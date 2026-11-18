// Emissão e cancelamento de NFS-e pelo Sistema Nacional, rodando no cofre.
//
//   emitir:   reserva o número -> monta a DPS -> assina -> transmite à SEFIN
//             -> arquiva a NFS-e autorizada.
//   cancelar: monta o evento e101101 -> assina -> transmite -> arquiva o evento.

import { type Ambiente, NFSE_NACIONAL, nfseAmbiente } from "../fiscal/dados";
import {
	type CancelamentoInput,
	type Mensagem,
	type NfseInput,
	type RespostaEmissao,
	type RespostaEvento,
	base64ParaTexto,
	comDeclaracaoXml,
	corpoEmissao,
	corpoEvento,
	lerRespostaEmissao,
	lerRespostaEvento,
	montarDps,
	montarPedidoCancelamento,
	textoParaBase64,
} from "../nfse";
import { OperacaoError, type Operacoes } from "../operacoes";
import { VAULT_VERSION } from "../protocol";
import * as banco from "./banco";

/** Identificação enviada nos documentos fiscais (verAplic, até 20 caracteres). */
const VERSAO_APLICATIVO = `NFapi-${VAULT_VERSION}`;

export type ResultadoEmissao =
	/** `nova` é falso quando a referência já tinha uma nota e nada foi reenviado. */
	| { tipo: "autorizada"; nova: boolean; emission: banco.Emission }
	| { tipo: "conflito"; codigo: string; mensagem: string }
	| {
			tipo: "nao_autorizada";
			/** 422: recusada ou barrada antes de transmitir. 502: sem resposta conclusiva. */
			status: 422 | 502;
			codigo: string;
			mensagem: string;
			emission: banco.Emission;
	  };

/** Erros em que nada chegou a sair para o governo. */
const NAO_TRANSMITIDO = new Set(["host_nao_permitido", "requisicao_invalida", "certificado_do_cliente_invalido"]);

const doErro = (err: OperacaoError): Mensagem => ({ codigo: err.code, descricao: err.message });

async function consultar(ops: Operacoes, url: string, ref: string) {
	const res = await ops.transmit({ url, method: "GET", headers: { accept: "application/json" }, ref });
	return { status: res.status, corpo: base64ParaTexto(res.bodyB64) };
}

/**
 * Descobre se uma DPS já virou NFS-e (usado ao retomar uma emissão sem
 * resposta conclusiva). Devolve null quando a SEFIN não conhece a DPS.
 */
async function recuperar(ops: Operacoes, sefin: string, dpsId: string, ref: string): Promise<RespostaEmissao | null> {
	const dps = await consultar(ops, `${sefin}/dps/${dpsId}`, ref);
	if (dps.status === 404) return null;
	let chave: unknown;
	try {
		chave = (JSON.parse(dps.corpo) as { chaveAcesso?: unknown }).chaveAcesso;
	} catch {
		chave = undefined;
	}
	if (dps.status !== 200 || typeof chave !== "string") {
		return { tipo: "indefinida", detalhe: `Consulta da DPS respondeu HTTP ${dps.status}.` };
	}
	const nfse = await consultar(ops, `${sefin}/nfse/${chave}`, ref);
	const lida = await lerRespostaEmissao(nfse.status, nfse.corpo);
	return lida.tipo === "autorizada"
		? lida
		: { tipo: "indefinida", detalhe: `A DPS gerou a NFS-e ${chave}, mas a consulta do XML falhou.` };
}

export async function emitirNfse(
	d1: D1Database,
	ops: Operacoes,
	{ ambiente, referencia, pedido }: { ambiente: Ambiente; referencia?: string; pedido: NfseInput },
): Promise<ResultadoEmissao> {
	const config = nfseAmbiente(ambiente);
	const serieKey = { docId: ops.holder.id, kind: "nfse" as const, environment: ambiente, serie: pedido.serie };
	const hash = await banco.hashPedido(pedido);

	// ----- Idempotência -----
	let emission = referencia ? await banco.findByReference(d1, serieKey, referencia) : null;
	if (emission?.requestHash && emission.requestHash !== hash && emission.status !== "rejeitada" && emission.status !== "erro") {
		return { tipo: "conflito", codigo: banco.REFERENCIA_DIVERGENTE.codigo, mensagem: banco.REFERENCIA_DIVERGENTE.mensagem };
	}
	if (emission?.status === "autorizada" || emission?.status === "cancelada") {
		return { tipo: "autorizada", nova: false, emission };
	}
	if (emission?.status === "processando") {
		return { tipo: "conflito", codigo: "emissao_em_andamento", mensagem: "Já existe uma emissão em andamento para esta referência." };
	}

	const naoAutorizada = async (
		status: 422 | 502,
		situacao: "rejeitada" | "erro" | "indefinida",
		codigo: string,
		mensagens: Mensagem[],
		journalKey?: string,
	): Promise<ResultadoEmissao> => {
		const atual = await banco.updateEmission(d1, (emission as banco.Emission).id, {
			status: situacao,
			messages: mensagens,
			...(journalKey ? { journalKey } : {}),
		});
		return { tipo: "nao_autorizada", status, codigo, mensagem: mensagens[0]?.descricao ?? "A NFS-e não foi autorizada.", emission: atual };
	};
	const semResposta = (detalhe: Mensagem, journalKey?: string) =>
		naoAutorizada(502, "indefinida", "sem_resposta_conclusiva", [detalhe], journalKey);

	let resposta: RespostaEmissao | null = null;
	let journalKey: string | undefined;
	let dpsAssinada: string | undefined;

	try {
		// ----- Retomada: a tentativa anterior pode ter gerado a nota -----
		if (emission?.status === "indefinida") {
			resposta = await recuperar(ops, config.sefin, emission.documentId, emission.id);
			if (resposta?.tipo === "indefinida") {
				return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe });
			}
		}

		if (!resposta) {
			// ----- Número e DPS -----
			const numero = emission?.number ?? pedido.numero ?? (await banco.nextNumber(d1, serieKey));
			if (pedido.numero) await banco.noteNumber(d1, serieKey, pedido.numero);
			const dps = montarDps(pedido, {
				ambiente,
				leiaute: config.leiaute,
				emitente: { tipo: ops.holder.kind, numero: ops.holder.id },
				numero,
				versaoAplicativo: VERSAO_APLICATIVO,
			});

			if (emission) {
				// Nota recusada pode ser reenviada corrigida com a mesma referência: vale o conteúdo novo.
				emission = await banco.updateEmission(d1, emission.id, {
					status: "processando",
					documentId: dps.id,
					messages: [],
					requestHash: hash,
				});
			} else {
				const now = Date.now();
				emission = {
					id: banco.newId("nfs"),
					docId: ops.holder.id,
					kind: "nfse",
					environment: ambiente,
					reference: referencia ?? null,
					serie: pedido.serie,
					number: numero,
					documentId: dps.id,
					status: "processando",
					accessKey: null,
					fiscalNumber: null,
					messages: [],
					documentKey: null,
					journalKey: null,
					requestHash: hash,
					protocol: null,
					extra: {},
					createdAt: now,
					updatedAt: now,
				};
				if (!(await banco.insertEmission(d1, emission))) {
					return {
						tipo: "conflito",
						codigo: "numero_ja_utilizado",
						mensagem: `A DPS ${numero} da série ${pedido.serie} já foi usada (ou a referência acabou de ser registrada).`,
					};
				}
			}
			// Dados por onde o painel filtra: valor e tomador.
			await banco.anotarResumo(d1, emission.id, {
				value: pedido.valores.servico,
				recipientDoc: pedido.tomador?.cnpj ?? pedido.tomador?.cpf ?? null,
				recipientName: pedido.tomador?.nome ?? null,
			});

			// ----- Assinar -----
			try {
				const assinada = await ops.sign({ xml: dps.xml, tag: "infDPS", profile: NFSE_NACIONAL.assinatura });
				// O documento transmitido e o arquivado são o mesmo, já com a declaração XML.
				dpsAssinada = comDeclaracaoXml(assinada.xml);
			} catch (err) {
				if (!(err instanceof OperacaoError)) throw err;
				return await naoAutorizada(422, "erro", err.code, [doErro(err)]);
			}

			// ----- Transmitir -----
			try {
				const res = await ops.transmit({
					url: `${config.sefin}/nfse`,
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					bodyB64: textoParaBase64(await corpoEmissao(dpsAssinada)),
					timeoutMs: 60_000,
					ref: emission.id,
				});
				journalKey = res.journalKey;
				resposta = await lerRespostaEmissao(res.status, base64ParaTexto(res.bodyB64));
			} catch (err) {
				if (!(err instanceof OperacaoError)) throw err;
				return NAO_TRANSMITIDO.has(err.code)
					? await naoAutorizada(422, "erro", err.code, [doErro(err)])
					: await semResposta(doErro(err));
			}
		}
	} catch (err) {
		// Falha de transporte durante a retomada.
		if (!(err instanceof OperacaoError) || !emission) throw err;
		return await semResposta(doErro(err));
	}

	if (!emission) throw new Error("emissão sem registro");
	if (resposta.tipo === "rejeitada") {
		return await naoAutorizada(422, "rejeitada", "nfse_rejeitada", resposta.rejeicoes, journalKey);
	}
	if (resposta.tipo === "indefinida") {
		return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe }, journalKey);
	}

	// ----- Autorizada: arquivar -----
	const dia = new Date(emission.createdAt).toISOString();
	const base = `nfse/${ambiente}/${dia.slice(0, 4)}/${dia.slice(5, 7)}/${resposta.chaveAcesso}`;
	const meta = {
		tipo: "nfse",
		chaveAcesso: resposta.chaveAcesso,
		emissao: emission.id,
		ambiente,
		serie: emission.serie,
		numeroDps: emission.number,
		numeroNfse: resposta.numeroNfse,
		valor: pedido.valores.servico,
		emitidaEm: new Date().toISOString(),
	};
	await ops.putDocument(`${base}-nfse.xml`, resposta.xml, { contentType: "application/xml", meta });
	if (dpsAssinada) {
		await ops.putDocument(`${base}-dps.xml`, dpsAssinada, { contentType: "application/xml", meta: { ...meta, tipo: "dps" } });
	}

	const final = await banco.updateEmission(d1, emission.id, {
		status: "autorizada",
		accessKey: resposta.chaveAcesso,
		fiscalNumber: resposta.numeroNfse,
		messages: resposta.alertas,
		documentKey: `${base}-nfse.xml`,
		...(journalKey ? { journalKey } : {}),
	});
	await banco.anotarResumo(d1, emission.id, { issuedAt: meta.emitidaEm });
	return { tipo: "autorizada", nova: true, emission: final };
}

export type ResultadoCancelamento =
	| { ok: true; emission: banco.Emission; jaCancelada: boolean }
	| { ok: false; status: 409 | 422 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };

const falha = (
	status: 409 | 422 | 502,
	codigo: string,
	mensagens: Mensagem[],
	mensagem = mensagens[0]?.descricao ?? "O cancelamento não foi registrado.",
): ResultadoCancelamento => ({ ok: false, status, codigo, mensagem, mensagens });

export async function cancelarNfse(
	d1: D1Database,
	ops: Operacoes,
	emission: banco.Emission,
	input: CancelamentoInput,
): Promise<ResultadoCancelamento> {
	// Repetir o pedido de uma nota já cancelada não é erro.
	if (emission.status === "cancelada") return { ok: true, emission, jaCancelada: true };
	if (emission.status !== "autorizada" || !emission.accessKey) {
		return falha(409, "nfse_nao_autorizada", [], "Só é possível cancelar uma NFS-e autorizada.");
	}

	const config = nfseAmbiente(emission.environment);
	const pedido = montarPedidoCancelamento(input, {
		ambiente: emission.environment,
		autor: { tipo: ops.holder.kind, numero: ops.holder.id },
		chaveAcesso: emission.accessKey,
		versaoAplicativo: VERSAO_APLICATIVO,
	});

	let resposta: RespostaEvento;
	let journalKey: string | undefined;
	try {
		const assinado = comDeclaracaoXml(
			(await ops.sign({ xml: pedido.xml, tag: "infPedReg", profile: NFSE_NACIONAL.assinatura })).xml,
		);
		const res = await ops.transmit({
			url: `${config.sefin}/nfse/${emission.accessKey}/eventos`,
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			bodyB64: textoParaBase64(await corpoEvento(assinado)),
			timeoutMs: 60_000,
			ref: `${emission.id}:cancelamento`,
		});
		journalKey = res.journalKey;
		resposta = await lerRespostaEvento(res.status, base64ParaTexto(res.bodyB64));
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		// 422: barrado na assinatura ou antes de transmitir; o resto não é conclusivo.
		return err.status === 422 || NAO_TRANSMITIDO.has(err.code)
			? falha(422, err.code, [doErro(err)])
			: falha(502, "sem_resposta_conclusiva", [doErro(err)]);
	}

	if (resposta.tipo === "rejeitada") return falha(422, "cancelamento_rejeitado", resposta.rejeicoes);
	if (resposta.tipo === "indefinida") {
		return falha(502, "sem_resposta_conclusiva", [{ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe }]);
	}

	// Registrado: o evento fica ao lado do XML da nota.
	const destino = emission.documentKey
		? emission.documentKey.replace(/-nfse\.xml$/, "-cancelamento.xml")
		: `nfse/${emission.environment}/eventos/${emission.accessKey}-cancelamento.xml`;
	await ops.putDocument(destino, resposta.xml, {
		contentType: "application/xml",
		meta: {
			tipo: "cancelamento",
			chaveAcesso: emission.accessKey,
			emissao: emission.id,
			motivo: input.motivo,
			canceladaEm: new Date().toISOString(),
			diario: journalKey ?? null,
		},
	});
	const atual = await banco.updateEmission(d1, emission.id, { status: "cancelada", messages: [] });
	return { ok: true, emission: atual, jaCancelada: false };
}
