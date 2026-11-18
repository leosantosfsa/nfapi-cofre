// Emissão, consulta, cancelamento, carta de correção e inutilização de NF-e
// (modelo 55) e NFC-e (modelo 65), rodando no cofre.
//
//   emitir: reserva o número na série -> monta o XML -> assina -> guarda a nota
//           assinada -> transmite (lote síncrono) -> arquiva a nota autorizada
//           junto com o protocolo (nfeProc).
//
// A nota assinada é guardada antes de transmitir: se a resposta se perder, a
// retomada consulta a SEFAZ pela chave e fecha o arquivo sem emitir de novo.

import { type Ambiente, type Autorizador, autorizadorNfe, temInutilizacao } from "../fiscal/dados";
import type { Mensagem } from "../nfse";
import { base64ParaTexto } from "../nfse";
import { CODIGO_UF, type Modelo, dataHoraNaUf, gerarCodigoNumerico } from "../nfe/chave";
import { montarCancelamentoNfe, montarCancelamentoPorSubstituicao, montarCartaCorrecao, montarInutilizacao } from "../nfe/eventos";
import { suplementoNfce, suplementoNfceOffline } from "../nfe/qrcode";
import type { CancelamentoNfe, CartaCorrecao, InutilizacaoInput, PedidoNfe } from "../nfe/schema";
import {
	type RespostaAutorizacao,
	type Servico,
	consReciNFe,
	consSitNFe,
	consStatServ,
	envEvento,
	enviNFe,
	lerRespostaAutorizacao,
	lerRespostaConsulta,
	lerRespostaEventoNfe,
	lerRespostaInutilizacao,
	lerStatusServico,
	nfeProc,
	procEventoNFe,
	procInutNFe,
	requisicaoSoap,
} from "../nfe/sefaz";
import { comSuplementoNfce, montarNfe } from "../nfe/xml";
import { OperacaoError, type Operacoes } from "../operacoes";
import { VAULT_VERSION } from "../protocol";
import * as store from "../store";
import * as banco from "./banco";

const VERSAO_APLICATIVO = `NFapi-${VAULT_VERSION}`;

/** Ajustes de tempo; os testes zeram a espera. */
export const ajustes = { esperaReciboMs: 1500, tentativasRecibo: 3 };

export const KIND: Record<Modelo, "nfe" | "nfce"> = { "55": "nfe", "65": "nfce" };
export const MODELO: Record<"nfe" | "nfce", Modelo> = { nfe: "55", nfce: "65" };
const NOME = { nfe: "NF-e", nfce: "NFC-e" } as const;

/** Erros em que nada chegou a sair para o governo. */
const NAO_TRANSMITIDO = new Set(["host_nao_permitido", "requisicao_invalida", "certificado_do_cliente_invalido"]);
/**
 * Rejeições em que o número existe para a SEFAZ (duplicidade, faixa
 * inutilizada): ele não volta para a série.
 */
const NUMERO_OCUPADO = new Set(["204", "206", "218", "256", "539"]);
/** O serviço de autorização está parado: a nota não foi processada. */
const SERVICO_PARALISADO = new Set(["108", "109"]);

const doErro = (err: OperacaoError): Mensagem => ({ codigo: err.code, descricao: err.message });
const tpAmb = (ambiente: Ambiente) => (ambiente === "homologacao" ? "2" : "1");
const idLote = () => String(Date.now());

export type ResultadoNfe =
	| { tipo: "autorizada"; nova: boolean; emission: banco.Emission }
	/** NFC-e emitida em contingência offline: vale para o consumidor e aguarda a transmissão à SEFAZ. */
	| { tipo: "contingencia"; nova: boolean; emission: banco.Emission }
	| { tipo: "conflito"; status: 409 | 422; codigo: string; mensagem: string }
	| { tipo: "nao_autorizada"; status: 422 | 502; codigo: string; mensagem: string; emission: banco.Emission };

const conflito = (codigo: string, mensagem: string, status: 409 | 422 = 409): ResultadoNfe => ({ tipo: "conflito", status, codigo, mensagem });

async function chamar(ops: Operacoes, autorizador: Autorizador, servico: Servico, dados: string, ref: string, timeoutMs?: number) {
	const requisicao = requisicaoSoap(servico, autorizador.servicos[servico], dados, ref);
	const res = await ops.transmit(timeoutMs ? { ...requisicao, timeoutMs } : requisicao);
	return { status: res.status, corpo: base64ParaTexto(res.bodyB64), journalKey: res.journalKey };
}

/** CNPJ do emitente: o do certificado, ou o de uma filial de mesma raiz. */
function cnpjEmitente(ops: Operacoes, informado: string | undefined): string | null {
	if (ops.holder.kind !== "cnpj") return null;
	if (!informado) return ops.holder.id;
	return informado.slice(0, 8) === ops.holder.id.slice(0, 8) ? informado : null;
}

/** Reserva o próximo número livre da série, pulando faixas inutilizadas. */
async function reservarNumero(d1: D1Database, k: banco.SerieKey): Promise<number | null> {
	for (;;) {
		const numero = await banco.nextNumberCadastrada(d1, k);
		if (numero === null) return null;
		const fim = await banco.fimDaFaixaInutilizada(d1, k, numero);
		if (fim === null) return numero;
		await banco.avancarSerie(d1, k, fim);
	}
}

const pasta = (kind: string, ambiente: Ambiente, criadaEm: number) => {
	const dia = new Date(criadaEm).toISOString();
	return `${kind}/${ambiente}/${dia.slice(0, 4)}/${dia.slice(5, 7)}`;
};

/** Arquiva a nota autorizada (ou denegada) com o protocolo e descarta a cópia de trabalho. */
async function arquivar(
	d1: D1Database,
	ops: Operacoes,
	emission: banco.Emission,
	nfeAssinada: string,
	r: Extract<RespostaAutorizacao, { tipo: "autorizada" | "denegada" }>,
	journalKey?: string,
): Promise<banco.Emission> {
	const chave = emission.accessKey as string;
	const destino = `${pasta(emission.kind, emission.environment, emission.createdAt)}/${chave}-nfe.xml`;
	const autorizada = r.tipo === "autorizada";
	await ops.putDocument(destino, nfeProc(nfeAssinada, r.protNFe), {
		contentType: "application/xml",
		meta: {
			tipo: emission.kind,
			chaveAcesso: chave,
			emissao: emission.id,
			ambiente: emission.environment,
			serie: emission.serie,
			numero: emission.number,
			valor: emission.extra.valor ?? null,
			protocolo: autorizada ? r.protocolo : null,
			situacao: autorizada ? "autorizada" : "denegada",
			emitidaEm: new Date().toISOString(),
		},
	});
	const pendente = emission.extra.pendente;
	if (typeof pendente === "string") await ops.removeDocument(pendente).catch(() => undefined);
	const { pendente: _descartado, ...resto } = emission.extra;
	// Data e hora em que a SEFAZ autorizou (dhRecbto): vai impressa no DANFE.
	const extra = autorizada && r.recebidaEm ? { ...resto, autorizadaEm: r.recebidaEm } : resto;
	return banco.updateEmission(d1, emission.id, {
		status: autorizada ? "autorizada" : "denegada",
		protocol: autorizada ? r.protocolo : null,
		fiscalNumber: String(emission.number),
		messages: [r.mensagem],
		documentKey: destino,
		extra,
		...(journalKey ? { journalKey } : {}),
	});
}

type Retomada =
	| { tipo: "resolvida"; emission: banco.Emission }
	/** A SEFAZ não conhece a nota: a tentativa anterior não valeu e pode ser refeita. */
	| { tipo: "nao_consta"; emission: banco.Emission }
	| { tipo: "indefinida"; detalhe: string };

/** Descobre, pela chave, o que aconteceu com uma emissão que ficou sem resposta. */
async function retomar(d1: D1Database, ops: Operacoes, autorizador: Autorizador, emission: banco.Emission): Promise<Retomada> {
	const chave = emission.accessKey as string;
	const { status, corpo } = await chamar(ops, autorizador, "consulta", consSitNFe(tpAmb(emission.environment), chave), `${emission.id}:consulta`);
	const r = lerRespostaConsulta(status, corpo, chave);
	if (r.tipo === "indefinida") return r;
	if (r.tipo === "nao_consta") {
		const serieKey = { docId: emission.docId, kind: emission.kind, environment: emission.environment, serie: emission.serie };
		const atual = await banco.updateEmission(d1, emission.id, { status: "rejeitada", messages: [r.mensagem] });
		await banco.devolverNumero(d1, serieKey, emission.number);
		return { tipo: "nao_consta", emission: atual };
	}
	const pendente = typeof emission.extra.pendente === "string" ? await ops.getDocument(emission.extra.pendente) : null;
	if (r.tipo === "cancelada") {
		const arquivada = pendente && r.protNFe
			? await arquivar(d1, ops, emission, pendente, { tipo: "autorizada", protocolo: r.protocolo ?? "", recebidaEm: null, mensagem: r.mensagem, protNFe: r.protNFe })
			: emission;
		return { tipo: "resolvida", emission: await banco.updateEmission(d1, arquivada.id, { status: "cancelada", messages: [r.mensagem] }) };
	}
	if (!pendente) {
		return { tipo: "indefinida", detalhe: "A nota consta na SEFAZ, mas a cópia assinada não está mais no cofre. Baixe o XML pela chave de acesso." };
	}
	return { tipo: "resolvida", emission: await arquivar(d1, ops, emission, pendente, r) };
}

/**
 * Contingência offline da NFC-e (tpEmis 9), para quando a SEFAZ não responde e
 * a loja continua com internet: o cofre assina a nota, devolve para o caixa
 * imprimir e transmite depois.
 *
 *   nunca       nunca entra em contingência (padrão).
 *   automatica  entra se a SEFAZ não der resposta conclusiva.
 *   forcada     emite direto em contingência.
 */
export type ModoContingencia = "nunca" | "automatica" | "forcada";

/** Espera pela SEFAZ quando há a contingência como saída: o caixa não pode ficar parado. */
const ESPERA_COM_CONTINGENCIA_MS = 20_000;
/** Depois deste tempo sem conferir, uma nova emissão tenta de novo o caminho normal. */
const VALIDADE_DO_ESTADO_MS = 10 * 60_000;

interface EstadoContingencia {
	/** Quando o emitente entrou em contingência (dhCont). */
	desde: string;
	motivo: string;
	/** Última vez em que se constatou que a SEFAZ seguia sem responder. */
	verificadoEm: number;
}

const chaveDoEstado = (ambiente: Ambiente, uf: string) => `contingencia_nfce_${ambiente}_${uf}`;

async function lerEstado(d1: D1Database, ambiente: Ambiente, uf: string): Promise<EstadoContingencia | null> {
	const valor = await store.getSetting(d1, chaveDoEstado(ambiente, uf));
	if (!valor) return null;
	try {
		return JSON.parse(valor) as EstadoContingencia;
	} catch {
		return null;
	}
}

export async function emitirNfe(
	d1: D1Database,
	ops: Operacoes,
	{ ambiente, referencia, pedido, contingencia = "nunca" }: { ambiente: Ambiente; referencia?: string; pedido: PedidoNfe; contingencia?: ModoContingencia },
): Promise<ResultadoNfe> {
	const kind = KIND[pedido.modelo];
	const nome = NOME[kind];
	const cnpj = cnpjEmitente(ops, pedido.emitente.cnpj);
	if (!cnpj) return conflito("emitente_divergente", "O emitente precisa ser o titular do certificado (CNPJ) ou uma filial de mesma raiz.", 422);
	const uf = pedido.emitente.endereco.uf;
	const autorizador = autorizadorNfe(pedido.modelo, uf, ambiente);
	if (!autorizador) return conflito("uf_nao_suportada", `A emissão de ${nome} para a UF ${uf} ainda não está disponível neste cofre.`, 422);
	// A contingência offline só existe na NFC-e.
	const modo: ModoContingencia = kind === "nfce" ? contingencia : "nunca";

	const base = { docId: cnpj, kind, environment: ambiente };
	const hash = await banco.hashPedido(pedido);

	// ----- Idempotência -----
	let emission = referencia ? await banco.findByReference(d1, base, referencia) : null;
	if (emission?.requestHash && emission.requestHash !== hash && emission.status !== "rejeitada" && emission.status !== "erro") {
		return conflito(banco.REFERENCIA_DIVERGENTE.codigo, banco.REFERENCIA_DIVERGENTE.mensagem);
	}
	if (emission?.status === "autorizada" || emission?.status === "cancelada") return { tipo: "autorizada", nova: false, emission };
	if (emission?.status === "contingencia") return { tipo: "contingencia", nova: false, emission };
	if (emission?.status === "denegada") {
		return { tipo: "nao_autorizada", status: 422, codigo: "nfe_denegada", mensagem: emission.messages[0]?.descricao ?? "Uso denegado.", emission };
	}
	if (emission?.status === "processando") return conflito("emissao_em_andamento", "Já existe uma emissão em andamento para esta referência.");

	const encerrar = async (
		status: 422 | 502,
		situacao: "rejeitada" | "erro" | "indefinida",
		codigo: string,
		mensagens: Mensagem[],
		opcoes: { journalKey?: string; devolver?: boolean } = {},
	): Promise<ResultadoNfe> => {
		const e = emission as banco.Emission;
		const atual = await banco.updateEmission(d1, e.id, { status: situacao, messages: mensagens, ...(opcoes.journalKey ? { journalKey: opcoes.journalKey } : {}) });
		if (opcoes.devolver) await banco.devolverNumero(d1, { ...base, serie: e.serie }, e.number);
		return { tipo: "nao_autorizada", status, codigo, mensagem: mensagens[0]?.descricao ?? `A ${nome} não foi autorizada.`, emission: atual };
	};
	const semResposta = (detalhe: Mensagem, journalKey?: string) => encerrar(502, "indefinida", "sem_resposta_conclusiva", [detalhe], { journalKey });

	try {
		// ----- Retomada: a tentativa anterior pode ter sido autorizada -----
		if (emission?.status === "indefinida") {
			const r = await retomar(d1, ops, autorizador, emission);
			if (r.tipo === "resolvida") return { tipo: "autorizada", nova: true, emission: r.emission };
			if (r.tipo === "indefinida") return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: r.detalhe });
			emission = r.emission;
		}

		// Nota emitida em contingência e rejeitada na transmissão: a correção mantém série, número e datas.
		const anterior = emission?.status === "rejeitada" ? (emission.extra.contingencia as { desde: string; motivo: string } | undefined) : undefined;

		// ----- Série -----
		const cadastradas = (await banco.listSeries(d1, cnpj)).filter((s) => s.kind === kind && s.environment === ambiente);
		const serie = anterior && emission ? Number(emission.serie) : (pedido.serie ?? (cadastradas.length === 1 ? Number(cadastradas[0]?.serie) : undefined));
		if (serie === undefined) {
			return conflito(
				cadastradas.length === 0 ? "serie_nao_cadastrada" : "serie_obrigatoria",
				cadastradas.length === 0
					? `Nenhuma série de ${nome} cadastrada para ${ambiente}. Cadastre a série na tela do cofre.`
					: `Há mais de uma série de ${nome} cadastrada: informe "serie" no pedido.`,
				422,
			);
		}
		const serieKey = { ...base, serie: String(serie) };
		const serieAusente = () => conflito("serie_nao_cadastrada", `A série ${serie} de ${nome} não está cadastrada para ${ambiente}. Cadastre-a na tela do cofre.`, 422);

		/** Grava a emissão (ou atualiza a que já existe) com o número e a chave desta tentativa. */
		/** Dados por onde o painel filtra: data, valor e destinatário. */
		const resumir = (id: string, extra: Record<string, unknown>) =>
			banco.anotarResumo(d1, id, {
				issuedAt: typeof extra.emitidaEm === "string" ? extra.emitidaEm : null,
				value: typeof extra.valor === "number" ? extra.valor : null,
				recipientDoc: pedido.destinatario?.cnpj ?? pedido.destinatario?.cpf ?? pedido.destinatario?.idEstrangeiro ?? null,
				recipientName: pedido.destinatario?.nome ?? null,
			});
		const registrar = async (numero: number, chave: string, status: "processando" | "contingencia", extra: Record<string, unknown>): Promise<boolean> => {
			if (emission) {
				emission = await banco.updateEmission(d1, emission.id, { status, number: numero, accessKey: chave, documentId: `NFe${chave}`, messages: [], requestHash: hash, extra });
				await resumir(emission.id, extra);
				return true;
			}
			const now = Date.now();
			const nova: banco.Emission = {
				id: banco.newId(kind === "nfe" ? "nfe" : "nfc"), docId: cnpj, kind, environment: ambiente, reference: referencia ?? null,
				serie: String(serie), number: numero, documentId: `NFe${chave}`, status, accessKey: chave,
				fiscalNumber: null, messages: [], documentKey: null, journalKey: null, requestHash: hash, protocol: null, extra,
				createdAt: now, updatedAt: now,
			};
			if (!(await banco.insertEmission(d1, nova))) return false;
			emission = await banco.updateEmission(d1, nova.id, { accessKey: chave });
			await resumir(nova.id, extra);
			return true;
		};

		/** Emite a NFC-e em contingência offline e a deixa na fila de transmissão. */
		const emContingencia = async (
			motivo: string,
			opcoes: {
				/** A nota normal que ficou sem resposta e precisa ser conferida depois. */
				original?: Record<string, unknown>;
				/** Reemissão de uma nota em contingência rejeitada: mesmo número e mesmas datas. */
				refazer?: { numero: number; dataEmissao: string; desde: string };
				/** A SEFAZ acabou de falhar (e não só o estado guardado diz isso). */
				constatado?: boolean;
			} = {},
		): Promise<ResultadoNfe> => {
			if (!autorizador.nfce) return conflito("uf_nao_suportada", `A contingência de NFC-e para a UF ${uf} ainda não está disponível neste cofre.`, 422);
			const numero = opcoes.refazer?.numero ?? (await reservarNumero(d1, serieKey));
			if (numero === null) return serieAusente();

			const guardado = await lerEstado(d1, ambiente, uf);
			const estado: EstadoContingencia = {
				desde: guardado?.desde ?? dataHoraNaUf(new Date(), uf),
				motivo: guardado?.motivo ?? motivo,
				verificadoEm: opcoes.constatado || !guardado ? Date.now() : guardado.verificadoEm,
			};
			if (!opcoes.refazer) await store.setSetting(d1, chaveDoEstado(ambiente, uf), JSON.stringify(estado));
			const desde = opcoes.refazer?.desde ?? estado.desde;

			const montada = montarNfe(pedido, {
				ambiente, cnpj, serie, numero, cNF: gerarCodigoNumerico(numero), versaoAplicativo: VERSAO_APLICATIVO,
				contingencia: { desde, justificativa: motivo }, dataEmissao: opcoes.refazer?.dataEmissao,
			});
			let assinada: string;
			let supl: { qrCode: string; urlChave: string };
			try {
				supl = await suplementoNfceOffline(
					montada.chave, ambiente, autorizador.nfce,
					{ dataEmissao: montada.dataEmissao, total: montada.total, destinatario: pedido.destinatario },
					(campos) => ops.assinarQrCodeOffline(campos),
				);
				assinada = (await ops.sign({ xml: comSuplementoNfce(montada.xml, supl.qrCode, supl.urlChave), tag: "infNFe", profile: "rsa-sha1" })).xml;
			} catch (err) {
				if (!(err instanceof OperacaoError)) throw err;
				if (!opcoes.refazer) await banco.devolverNumero(d1, serieKey, numero);
				return emission ? await encerrar(422, "erro", err.code, [doErro(err)]) : conflito(err.code, err.message, 422);
			}

			const extra: Record<string, unknown> = {
				valor: montada.total, uf, emitidaEm: montada.dataEmissao, qrCode: supl.qrCode, urlConsulta: supl.urlChave,
				contingencia: { desde, motivo, tentativas: 0 },
				...(opcoes.original ? { original: opcoes.original } : {}),
			};
			if (!(await registrar(numero, montada.chave, "contingencia", extra))) {
				await banco.devolverNumero(d1, serieKey, numero);
				return conflito("emissao_em_andamento", "A referência acabou de ser registrada por outro pedido.");
			}
			const e = emission as unknown as banco.Emission;
			// Enquanto a SEFAZ não autoriza, o arquivo da nota é o XML assinado, sem protocolo.
			const destino = `${pasta(kind, ambiente, e.createdAt)}/${montada.chave}-nfe.xml`;
			await ops.putDocument(destino, assinada, {
				contentType: "application/xml",
				meta: { tipo: kind, chaveAcesso: montada.chave, emissao: e.id, ambiente, serie: e.serie, numero, valor: montada.total, protocolo: null, situacao: "contingencia", emitidaEm: new Date().toISOString() },
			});
			emission = await banco.updateEmission(d1, e.id, { documentKey: destino });
			return { tipo: "contingencia", nova: true, emission };
		};

		if (anterior && emission) {
			const refeita = await emContingencia(anterior.motivo, {
				refazer: { numero: emission.number, dataEmissao: String(emission.extra.emitidaEm), desde: anterior.desde },
				original: emission.extra.original as Record<string, unknown> | undefined,
			});
			if (refeita.tipo !== "contingencia") return refeita;
			return resultadoDaTransmissao(await transmitirContingencia(d1, ops, refeita.emission), nome);
		}

		// ----- Entrada direta em contingência -----
		if (modo === "forcada") return await emContingencia("Contingencia solicitada pelo sistema emissor");
		if (modo === "automatica") {
			const estado = await lerEstado(d1, ambiente, uf);
			if (estado && Date.now() - estado.verificadoEm < VALIDADE_DO_ESTADO_MS) return await emContingencia(estado.motivo);
		}

		// ----- Número e XML -----
		const numero = await reservarNumero(d1, serieKey);
		if (numero === null) return serieAusente();
		const montada = montarNfe(pedido, { ambiente, cnpj, serie, numero, cNF: gerarCodigoNumerico(numero), versaoAplicativo: VERSAO_APLICATIVO });
		let xml = montada.xml;
		const extra: Record<string, unknown> = { valor: montada.total, uf, emitidaEm: montada.dataEmissao };
		if (kind === "nfce" && autorizador.nfce) {
			const supl = suplementoNfce(montada.chave, ambiente, autorizador.nfce);
			xml = comSuplementoNfce(xml, supl.qrCode, supl.urlChave);
			extra.qrCode = supl.qrCode;
			extra.urlConsulta = supl.urlChave;
		}
		if (!(await registrar(numero, montada.chave, "processando", extra))) {
			await banco.devolverNumero(d1, serieKey, numero);
			return conflito("emissao_em_andamento", "A referência acabou de ser registrada por outro pedido.");
		}
		let atual = emission as unknown as banco.Emission;

		// ----- Assinar e guardar a cópia de trabalho -----
		let assinada: string;
		try {
			assinada = (await ops.sign({ xml, tag: "infNFe", profile: "rsa-sha1" })).xml;
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
			return await encerrar(422, "erro", err.code, [doErro(err)], { devolver: true });
		}
		const pendente = `${pasta(kind, ambiente, atual.createdAt)}/${montada.chave}-enviada.xml`;
		await ops.putDocument(pendente, assinada, { contentType: "application/xml", meta: { tipo: "enviada", emissao: atual.id } });
		atual = emission = await banco.updateEmission(d1, atual.id, { extra: { ...extra, pendente } });
		// A nota normal que pode ter chegado à SEFAZ: a contingência a confere depois.
		const original = { chave: montada.chave, numero, pendente };

		// ----- Transmitir -----
		let resposta: RespostaAutorizacao;
		let journalKey: string | undefined;
		try {
			const res = await chamar(ops, autorizador, "autorizacao", enviNFe(assinada, idLote()), atual.id, modo === "automatica" ? ESPERA_COM_CONTINGENCIA_MS : undefined);
			journalKey = res.journalKey;
			resposta = lerRespostaAutorizacao(res.status, res.corpo, montada.chave);
			for (let i = 0; resposta.tipo === "em_processamento" && i < ajustes.tentativasRecibo; i++) {
				await new Promise((resolve) => setTimeout(resolve, ajustes.esperaReciboMs));
				const ret = await chamar(ops, autorizador, "retAutorizacao", consReciNFe(tpAmb(ambiente), resposta.recibo), `${atual.id}:recibo`);
				resposta = lerRespostaAutorizacao(ret.status, ret.corpo, montada.chave);
			}
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
			if (NAO_TRANSMITIDO.has(err.code)) return await encerrar(422, "erro", err.code, [doErro(err)], { devolver: true });
			if (modo === "automatica") return await emContingencia(`Sem resposta da SEFAZ na autorizacao (${err.code})`, { original, constatado: true });
			return await semResposta(doErro(err));
		}

		if (resposta.tipo === "autorizada") {
			return { tipo: "autorizada", nova: true, emission: await arquivar(d1, ops, atual, assinada, resposta, journalKey) };
		}
		if (resposta.tipo === "denegada") {
			const negada = await arquivar(d1, ops, atual, assinada, resposta, journalKey);
			return { tipo: "nao_autorizada", status: 422, codigo: "nfe_denegada", mensagem: resposta.mensagem.descricao, emission: negada };
		}
		if (resposta.tipo === "rejeitada") {
			// 204: esta mesma chave já foi autorizada (uma resposta anterior se perdeu).
			if (resposta.mensagem.codigo === "204") {
				const r = await retomar(d1, ops, autorizador, atual);
				if (r.tipo === "resolvida") return { tipo: "autorizada", nova: true, emission: r.emission };
			}
			await ops.removeDocument(pendente).catch(() => undefined);
			// 108 e 109: o serviço está paralisado. A nota não foi processada; é o caso da contingência.
			if (modo === "automatica" && SERVICO_PARALISADO.has(resposta.mensagem.codigo)) {
				return await emContingencia(`Servico de autorizacao da SEFAZ paralisado (cStat ${resposta.mensagem.codigo})`, { constatado: true });
			}
			return await encerrar(422, "rejeitada", "nfe_rejeitada", [resposta.mensagem], {
				journalKey,
				devolver: !NUMERO_OCUPADO.has(resposta.mensagem.codigo),
			});
		}
		if (modo === "automatica") return await emContingencia("Sem resposta conclusiva da SEFAZ na autorizacao", { original, constatado: true });
		const detalhe = resposta.tipo === "em_processamento" ? "A SEFAZ recebeu o lote, mas ainda não o processou. Repita o pedido com a mesma referência." : resposta.detalhe;
		return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: detalhe }, journalKey);
	} catch (err) {
		// Falha de transporte durante a retomada.
		if (!(err instanceof OperacaoError) || !emission) throw err;
		return await semResposta(doErro(err));
	}
}

function resultadoDaTransmissao(emission: banco.Emission, nome: string): ResultadoNfe {
	if (emission.status === "autorizada") return { tipo: "autorizada", nova: true, emission };
	if (emission.status === "contingencia") return { tipo: "contingencia", nova: true, emission };
	const mensagem = emission.messages[0]?.descricao ?? `A ${nome} não foi autorizada.`;
	return { tipo: "nao_autorizada", status: 422, codigo: emission.status === "denegada" ? "nfe_denegada" : "nfe_rejeitada", mensagem, emission };
}

/**
 * Transmite à SEFAZ uma NFC-e emitida em contingência: o mesmo XML assinado,
 * sem alteração. Devolve a emissão como ficou.
 */
export async function transmitirContingencia(d1: D1Database, ops: Operacoes, emission: banco.Emission): Promise<banco.Emission> {
	if (emission.status !== "contingencia" || !emission.accessKey || !emission.documentKey) return emission;
	const autorizador = autorizadorNfe(MODELO[emission.kind as "nfe" | "nfce"], String(emission.extra.uf ?? ""), emission.environment);
	const assinada = await ops.getDocument(emission.documentKey);
	if (!autorizador || !assinada) return emission;

	const contingencia = (emission.extra.contingencia ?? {}) as Record<string, unknown>;
	/** Registra a tentativa; a nota continua na fila, a menos que o `patch` diga outra coisa. */
	const tentativa = (patch: Parameters<typeof banco.updateEmission>[2]) =>
		banco.updateEmission(d1, emission.id, {
			extra: { ...emission.extra, contingencia: { ...contingencia, tentativas: Number(contingencia.tentativas ?? 0) + 1, ultimaTentativa: new Date().toISOString() } },
			...patch,
		});

	let resposta: RespostaAutorizacao | Awaited<ReturnType<typeof lerRespostaConsulta>>;
	let journalKey: string | undefined;
	try {
		const res = await chamar(ops, autorizador, "autorizacao", enviNFe(assinada, idLote()), `${emission.id}:contingencia`);
		journalKey = res.journalKey;
		resposta = lerRespostaAutorizacao(res.status, res.corpo, emission.accessKey);
		// 204: a nota já está na SEFAZ (uma transmissão anterior chegou e a resposta se perdeu).
		if (resposta.tipo === "rejeitada" && resposta.mensagem.codigo === "204") {
			const consulta = await chamar(ops, autorizador, "consulta", consSitNFe(tpAmb(emission.environment), emission.accessKey), `${emission.id}:consulta`);
			const lida = lerRespostaConsulta(consulta.status, consulta.corpo, emission.accessKey);
			if (lida.tipo === "autorizada" || lida.tipo === "denegada") resposta = lida;
		}
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return tentativa({ messages: [doErro(err)] });
	}

	if (resposta.tipo === "autorizada" || resposta.tipo === "denegada") return arquivar(d1, ops, emission, assinada, resposta, journalKey);
	if (resposta.tipo === "rejeitada" && !SERVICO_PARALISADO.has(resposta.mensagem.codigo)) {
		// Rejeitada: o número continua sendo desta nota, que precisa ser corrigida e
		// reenviada com a mesma referência (a contingência não admite outro número).
		return tentativa({ status: "rejeitada", messages: [resposta.mensagem], ...(journalKey ? { journalKey } : {}) });
	}
	const detalhe: Mensagem =
		resposta.tipo === "rejeitada"
			? resposta.mensagem
			: { codigo: "sem_resposta_conclusiva", descricao: "detalhe" in resposta ? resposta.detalhe : "A SEFAZ ainda não deu resposta conclusiva." };
	return tentativa({ messages: [detalhe] });
}

/**
 * Confere a NFC-e normal que ficou sem resposta antes de a venda ser documentada
 * em contingência. Se ela acabou autorizada, a venda tem duas notas: a normal é
 * cancelada por substituição (evento 110112), apontando para a de contingência.
 */
async function resolverOriginal(d1: D1Database, ops: Operacoes, emission: banco.Emission): Promise<banco.Emission> {
	const original = emission.extra.original as { chave?: string; pendente?: string; falha?: string } | undefined;
	if (!original?.chave || original.falha || emission.status !== "autorizada" || !emission.accessKey) return emission;
	const autorizador = autorizadorNfe(MODELO[emission.kind as "nfe" | "nfce"], String(emission.extra.uf ?? ""), emission.environment);
	if (!autorizador) return emission;

	const encerrada = async (registro: Record<string, unknown> = {}) => {
		if (original.pendente) await ops.removeDocument(original.pendente).catch(() => undefined);
		const { original: _resolvida, ...resto } = emission.extra;
		return banco.updateEmission(d1, emission.id, { extra: { ...resto, ...registro } });
	};
	try {
		const consulta = await chamar(ops, autorizador, "consulta", consSitNFe(tpAmb(emission.environment), original.chave), `${emission.id}:original`);
		const r = lerRespostaConsulta(consulta.status, consulta.corpo, original.chave);
		if (r.tipo === "nao_consta" || r.tipo === "cancelada" || r.tipo === "denegada") return await encerrada();
		if (r.tipo !== "autorizada") return emission;

		const evento = montarCancelamentoPorSubstituicao(
			{ ambiente: emission.environment, cnpj: emission.docId, chave: original.chave },
			r.protocolo,
			"NFC-e substituida por nota emitida em contingencia",
			emission.accessKey,
			VERSAO_APLICATIVO,
		);
		const assinado = (await ops.sign({ xml: evento.xml, tag: "infEvento", profile: "rsa-sha1" })).xml;
		const res = await chamar(ops, autorizador, "evento", envEvento(assinado, idLote()), `${emission.id}:substituicao`);
		const lido = lerRespostaEventoNfe(res.status, res.corpo);
		if (lido.tipo === "registrado") {
			await ops.putDocument(`${pasta(emission.kind, emission.environment, emission.createdAt)}/${original.chave}-cancelamento-substituicao.xml`, procEventoNFe(assinado, lido.retEvento), {
				contentType: "application/xml",
				meta: { tipo: "cancelamento_substituicao", chaveAcesso: emission.accessKey, substituida: original.chave, emissao: emission.id, protocolo: lido.protocolo },
			});
		}
		if (lido.tipo === "registrado" || lido.tipo === "duplicado") {
			return await encerrada({ substituida: { chave: original.chave, canceladaEm: new Date().toISOString() } });
		}
		if (lido.tipo === "rejeitado") {
			// Sem repetir em laço: fica registrado para o emitente resolver.
			const falha = `[${lido.mensagem.codigo}] ${lido.mensagem.descricao}`;
			return banco.updateEmission(d1, emission.id, { extra: { ...emission.extra, original: { ...original, falha } } });
		}
		return emission;
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return emission;
	}
}

export interface ResumoPendencias {
	/** Notas autorizadas nesta passada. */
	autorizadas: number;
	/** Notas rejeitadas na transmissão: aguardam correção pelo sistema emissor. */
	rejeitadas: number;
	/** Notas que continuam na fila (a SEFAZ segue sem responder). */
	aguardando: number;
}

/**
 * Trabalho periódico da contingência: confere se a SEFAZ voltou, transmite as
 * notas em contingência e resolve as notas normais que ficaram sem resposta.
 * Antes de transmitir, consulta o status do serviço uma vez por UF, para não
 * insistir contra um serviço parado.
 */
export async function processarPendencias(d1: D1Database, ops: Operacoes, limite = 25): Promise<ResumoPendencias> {
	const resumo: ResumoPendencias = { autorizadas: 0, rejeitadas: 0, aguardando: 0 };
	const emOperacao = new Map<string, boolean>();
	const conferir = async (ambiente: Ambiente, uf: string): Promise<boolean> => {
		const grupo = `${ambiente}:${uf}`;
		const conhecido = emOperacao.get(grupo);
		if (conhecido !== undefined) return conhecido;
		let ok = false;
		try {
			ok = (await statusSefaz(ops, "65", uf, ambiente))?.emOperacao === true;
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
		}
		emOperacao.set(grupo, ok);
		const estado = await lerEstado(d1, ambiente, uf);
		// A SEFAZ voltou: as próximas notas saem pelo caminho normal.
		if (estado) await store.setSetting(d1, chaveDoEstado(ambiente, uf), ok ? "" : JSON.stringify({ ...estado, verificadoEm: Date.now() }));
		return ok;
	};

	for (const chave of await store.listSettingKeys(d1, "contingencia_nfce_")) {
		const [ambiente, uf] = chave.slice("contingencia_nfce_".length).split("_");
		if ((ambiente === "homologacao" || ambiente === "producao") && uf) await conferir(ambiente, uf);
	}

	for (const emission of await banco.listPendentesDeContingencia(d1, limite)) {
		if (!(await conferir(emission.environment, String(emission.extra.uf ?? "")))) {
			resumo.aguardando++;
			continue;
		}
		const eraContingencia = emission.status === "contingencia";
		let atual = eraContingencia ? await transmitirContingencia(d1, ops, emission) : emission;
		if (atual.status === "autorizada") {
			if (eraContingencia) resumo.autorizadas++;
			atual = await resolverOriginal(d1, ops, atual);
		} else if (atual.status === "rejeitada") resumo.rejeitadas++;
		else if (atual.status === "contingencia") resumo.aguardando++;
	}
	return resumo;
}

/**
 * Consulta a SEFAZ para fechar uma emissão que ficou sem resposta conclusiva,
 * ou tenta transmitir uma nota que está em contingência.
 */
export async function sincronizarNfe(d1: D1Database, ops: Operacoes, emission: banco.Emission): Promise<banco.Emission> {
	if (emission.status === "contingencia") {
		const atual = await transmitirContingencia(d1, ops, emission);
		return atual.status === "autorizada" ? resolverOriginal(d1, ops, atual) : atual;
	}
	if (emission.status !== "indefinida" || !emission.accessKey) return emission;
	const autorizador = autorizadorNfe(MODELO[emission.kind as "nfe" | "nfce"], String(emission.extra.uf ?? ""), emission.environment);
	if (!autorizador) return emission;
	try {
		const r = await retomar(d1, ops, autorizador, emission);
		return r.tipo === "indefinida" ? emission : r.emission;
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return emission;
	}
}

export type ResultadoEvento =
	| { ok: true; emission: banco.Emission; repetido: boolean }
	| { ok: false; status: 409 | 422 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };

const falha = (status: 409 | 422 | 502, codigo: string, mensagens: Mensagem[], mensagem = mensagens[0]?.descricao ?? "O evento não foi registrado."): ResultadoEvento => ({
	ok: false, status, codigo, mensagem, mensagens,
});

async function registrarEvento(ops: Operacoes, emission: banco.Emission, evento: { xml: string }, ref: string) {
	const autorizador = autorizadorNfe(MODELO[emission.kind as "nfe" | "nfce"], String(emission.extra.uf ?? ""), emission.environment);
	if (!autorizador) return { erro: falha(422, "uf_nao_suportada", [], "UF sem autorizador configurado neste cofre.") };
	try {
		const assinado = (await ops.sign({ xml: evento.xml, tag: "infEvento", profile: "rsa-sha1" })).xml;
		const res = await chamar(ops, autorizador, "evento", envEvento(assinado, idLote()), ref);
		return { assinado, resposta: lerRespostaEventoNfe(res.status, res.corpo), journalKey: res.journalKey };
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return {
			erro: err.status === 422 || NAO_TRANSMITIDO.has(err.code) ? falha(422, err.code, [doErro(err)]) : falha(502, "sem_resposta_conclusiva", [doErro(err)]),
		};
	}
}

export async function cancelarNfe(d1: D1Database, ops: Operacoes, emission: banco.Emission, input: CancelamentoNfe): Promise<ResultadoEvento> {
	if (emission.status === "cancelada") return { ok: true, emission, repetido: true };
	if (emission.status === "contingencia") {
		return falha(409, "nfe_nao_autorizada", [], "A nota está em contingência: só pode ser cancelada depois de autorizada pela SEFAZ.");
	}
	if (emission.status !== "autorizada" || !emission.accessKey || !emission.protocol) {
		return falha(409, "nfe_nao_autorizada", [], "Só é possível cancelar uma nota autorizada.");
	}
	const evento = montarCancelamentoNfe({ ambiente: emission.environment, cnpj: emission.docId, chave: emission.accessKey }, emission.protocol, input.justificativa);
	const r = await registrarEvento(ops, emission, evento, `${emission.id}:cancelamento`);
	if (r.erro) return r.erro;
	if (r.resposta.tipo === "rejeitado") return falha(422, "cancelamento_rejeitado", [r.resposta.mensagem]);
	if (r.resposta.tipo === "indefinida") return falha(502, "sem_resposta_conclusiva", [{ codigo: "sem_resposta_conclusiva", descricao: r.resposta.detalhe }]);
	if (r.resposta.tipo === "registrado" && emission.documentKey) {
		await ops.putDocument(emission.documentKey.replace(/-nfe\.xml$/, "-cancelamento.xml"), procEventoNFe(r.assinado, r.resposta.retEvento), {
			contentType: "application/xml",
			meta: { tipo: "cancelamento", chaveAcesso: emission.accessKey, emissao: emission.id, protocolo: r.resposta.protocolo, canceladaEm: new Date().toISOString(), diario: r.journalKey ?? null },
		});
	}
	return { ok: true, emission: await banco.updateEmission(d1, emission.id, { status: "cancelada", messages: [r.resposta.mensagem] }), repetido: false };
}

export async function corrigirNfe(d1: D1Database, ops: Operacoes, emission: banco.Emission, input: CartaCorrecao): Promise<ResultadoEvento> {
	if (emission.kind !== "nfe") return falha(422, "carta_nao_se_aplica", [], "A carta de correção existe só para a NF-e (modelo 55).");
	if (emission.status !== "autorizada" || !emission.accessKey) return falha(409, "nfe_nao_autorizada", [], "Só é possível corrigir uma nota autorizada.");
	const sequencia = (typeof emission.extra.cartas === "number" ? emission.extra.cartas : 0) + 1;
	if (sequencia > 20) return falha(422, "limite_de_cartas", [], "A nota já tem o máximo de 20 cartas de correção.");
	const evento = montarCartaCorrecao({ ambiente: emission.environment, cnpj: emission.docId, chave: emission.accessKey }, sequencia, input.correcao);
	const r = await registrarEvento(ops, emission, evento, `${emission.id}:cce:${sequencia}`);
	if (r.erro) return r.erro;
	if (r.resposta.tipo === "rejeitado") return falha(422, "carta_rejeitada", [r.resposta.mensagem]);
	if (r.resposta.tipo === "indefinida") return falha(502, "sem_resposta_conclusiva", [{ codigo: "sem_resposta_conclusiva", descricao: r.resposta.detalhe }]);
	if (r.resposta.tipo === "registrado" && emission.documentKey) {
		await ops.putDocument(emission.documentKey.replace(/-nfe\.xml$/, `-cce-${String(sequencia).padStart(2, "0")}.xml`), procEventoNFe(r.assinado, r.resposta.retEvento), {
			contentType: "application/xml",
			meta: { tipo: "carta_correcao", chaveAcesso: emission.accessKey, emissao: emission.id, sequencia, protocolo: r.resposta.protocolo, diario: r.journalKey ?? null },
		});
	}
	// Com 573 (duplicidade) a sequência já existe na SEFAZ: o contador avança do mesmo jeito.
	const atual = await banco.updateEmission(d1, emission.id, { extra: { ...emission.extra, cartas: sequencia } });
	return { ok: true, emission: atual, repetido: r.resposta.tipo === "duplicado" };
}

export type ResultadoInutilizacao =
	/** `repetida`: a faixa já estava inutilizada (no cofre ou na SEFAZ) e nada novo foi registrado. */
	| { ok: true; inutilizacao: banco.Inutilizacao; repetida: boolean }
	| { ok: false; status: 409 | 422 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };

export async function inutilizarNumeracao(d1: D1Database, ops: Operacoes, input: InutilizacaoInput): Promise<ResultadoInutilizacao> {
	const recusar = (status: 409 | 422 | 502, codigo: string, mensagem: string, mensagens: Mensagem[] = []): ResultadoInutilizacao => ({ ok: false, status, codigo, mensagem, mensagens });
	const cnpj = cnpjEmitente(ops, input.cnpj);
	if (!cnpj) return recusar(422, "emitente_divergente", "O emitente precisa ser o titular do certificado (CNPJ) ou uma filial de mesma raiz.");
	const modelo = MODELO[input.modelo];
	const autorizador = autorizadorNfe(modelo, input.uf, input.ambiente);
	if (!autorizador) return recusar(422, "uf_nao_suportada", `A UF ${input.uf} ainda não está disponível neste cofre.`);
	if (!temInutilizacao(modelo, input.uf)) {
		return recusar(
			422,
			"inutilizacao_extinta",
			`A inutilização de numeração deixou de existir em ${input.uf} (Ajustes SINIEF 38 e 40 de 2026): números não usados simplesmente ficam sem nota.`,
		);
	}
	const serieKey = { docId: cnpj, kind: input.modelo, environment: input.ambiente, serie: String(input.serie) };
	// Repetir o pedido de uma faixa já inutilizada por este cofre devolve o registro.
	const existente = await banco.findInutilizacao(d1, serieKey, input.numeroInicial, input.numeroFinal);
	if (existente) return { ok: true, inutilizacao: existente, repetida: true };
	if ((await banco.numerosEmUsoNaFaixa(d1, serieKey, input.numeroInicial, input.numeroFinal)) > 0) {
		return recusar(409, "faixa_em_uso", "A faixa contém números de notas autorizadas ou em andamento neste cofre.");
	}

	const pedido = montarInutilizacao({ ...input, cnpj, modelo });
	let assinado: string;
	let lido: ReturnType<typeof lerRespostaInutilizacao>;
	let journalKey: string | undefined;
	try {
		assinado = (await ops.sign({ xml: pedido.xml, tag: "infInut", profile: "rsa-sha1" })).xml;
		const res = await chamar(ops, autorizador, "inutilizacao", assinado, pedido.id);
		journalKey = res.journalKey;
		lido = lerRespostaInutilizacao(res.status, res.corpo);
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return err.status === 422 || NAO_TRANSMITIDO.has(err.code)
			? recusar(422, err.code, err.message, [doErro(err)])
			: recusar(502, "sem_resposta_conclusiva", err.message, [doErro(err)]);
	}
	if (lido.tipo === "indefinida") return recusar(502, "sem_resposta_conclusiva", lido.detalhe);
	if (lido.tipo === "rejeitada") return recusar(422, "inutilizacao_rejeitada", lido.mensagem.descricao, [lido.mensagem]);

	// "duplicada": a SEFAZ já tinha esta faixa inutilizada (um pedido anterior chegou
	// e a resposta se perdeu). Fica registrada sem o protocolo e sem o XML.
	const homologada = lido.tipo === "homologada" ? lido : null;
	const destino = homologada ? `${input.modelo}/${input.ambiente}/inutilizacoes/${pedido.id}.xml` : null;
	if (homologada && destino) {
		await ops.putDocument(destino, procInutNFe(assinado, homologada.retInutNFe), {
			contentType: "application/xml",
			meta: { tipo: "inutilizacao", serie: input.serie, numeroInicial: input.numeroInicial, numeroFinal: input.numeroFinal, protocolo: homologada.protocolo, diario: journalKey ?? null },
		});
	}
	const inutilizacao: banco.Inutilizacao = {
		...serieKey, id: banco.newId("inu"), firstNumber: input.numeroInicial, lastNumber: input.numeroFinal,
		protocol: homologada?.protocolo ?? null, justification: input.justificativa, documentKey: destino, createdAt: Date.now(),
	};
	await banco.insertInutilizacao(d1, inutilizacao);
	// Se a faixa começa no próximo número da série (ou antes), a série segue depois dela.
	const serie = await banco.getSerie(d1, serieKey);
	if (serie && input.numeroInicial <= serie.lastNumber + 1) await banco.avancarSerie(d1, serieKey, input.numeroFinal);
	return { ok: true, inutilizacao, repetida: !homologada };
}

/** Consulta o status do serviço de autorização da UF. */
export async function statusSefaz(ops: Operacoes, modelo: Modelo, uf: string, ambiente: Ambiente) {
	const autorizador = autorizadorNfe(modelo, uf, ambiente);
	if (!autorizador) return null;
	const res = await chamar(ops, autorizador, "status", consStatServ(tpAmb(ambiente), CODIGO_UF[uf] as string), `status:${modelo}:${uf}`);
	return { autorizador: autorizador.nome, ...(lerStatusServico(res.corpo) ?? { emOperacao: false, mensagem: { codigo: "000", descricao: `HTTP ${res.status} sem retorno reconhecível.` }, tempoMedioSegundos: null }) };
}
