// NF-e recebidas: baixa do Ambiente Nacional as notas emitidas contra o CNPJ do
// titular (distribuição de DF-e, NT 2014.002) e registra a manifestação do
// destinatário (NT 2020.001).
//
// O Ambiente Nacional bloqueia por uma hora quem consulta fora das regras, e o
// bloqueio vale para o CNPJ inteiro. Por isso é o cofre que guarda o último
// NSU e o horário da próxima consulta, e nenhum sistema cliente os controla:
//
//   - a consulta por sequência continua do último NSU recebido;
//   - depois de "nenhum documento" (137), ou quando o último NSU alcança o
//     maior NSU existente, a próxima consulta só sai uma hora depois;
//   - depois de "consumo indevido" (656), nada sai por uma hora;
//   - a consulta por chave ou por NSU tem limite de 20 por hora; o cofre para antes.
//
// Quando outro sistema (o do contador, por exemplo) consulta o mesmo CNPJ, o
// 656 pode devolver um NSU à frente do que o cofre conhece. O cofre segue desse
// número, como a nota técnica manda, e busca um a um os NSU que ficaram para
// trás (consNSU), para nenhum documento se perder.

import { ambienteNacional } from "../fiscal/dados";
import type { Ambiente } from "../fiscal/dados";
import { chaveValida } from "../nfe/chave";
import { type DocumentoDistribuido, EVENTOS_DE_CANCELAMENTO, distDFeInt, lerDocumento, lerRetornoDistribuicao, requisicaoDistribuicao } from "../nfe/distribuicao";
import { MANIFESTACOES, type Manifestacao, montarManifestacao } from "../nfe/eventos";
import { envEvento, lerRespostaEventoNfe, procEventoNFe, requisicaoSoap } from "../nfe/sefaz";
import { type Mensagem, base64ParaTexto } from "../nfse";
import { OperacaoError, type Operacoes } from "../operacoes";
import * as store from "../store";
import * as banco from "./banco";

/** Espera depois de "nenhum documento" ou de um bloqueio: a hora exigida, com folga. */
export const ESPERA_MS = 62 * 60_000;
/** Nova tentativa quando o Ambiente Nacional não respondeu ou está paralisado. */
export const NOVA_TENTATIVA_MS = 15 * 60_000;
/** Enquanto uma consulta está em andamento, nenhuma outra começa. */
const RESERVA_MS = 10 * 60_000;
/** Consultas por chave ou por NSU em uma hora. O Ambiente Nacional aceita 20; o cofre para antes. */
export const LIMITE_POR_CHAVE = 18;
/** Dessas, quantas a busca dos NSU pulados pode usar; o resto fica para as consultas por chave. */
export const LIMITE_DE_RECUPERACAO = 12;
/** Quantos NSU pulados o cofre guarda para buscar: os mais recentes. */
export const LIMITE_DE_PULADOS = 500;
/** A ciência da operação só é aceita até 10 dias depois da autorização; o cofre para um dia antes. */
const DIAS_PARA_CIENCIA = 9;

const HORA = 60 * 60_000;
const SERVICO_PARALISADO = new Set(["108", "109"]);
const pasta = (ambiente: Ambiente, chave: string) => `recebidas/${ambiente}/${chave}`;
const dois = (n: number) => String(n).padStart(2, "0");

export type Falha = { ok: false; status: 409 | 422 | 429 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };
const falha = (status: Falha["status"], codigo: string, mensagem: string, mensagens: Mensagem[] = []): Falha => ({ ok: false, status, codigo, mensagem, mensagens });

/** A distribuição só existe para titular pessoa jurídica; filial de mesma raiz também vale. */
export function cnpjDoTitular(ops: Pick<Operacoes, "holder">, informado?: string): string | null {
	if (ops.holder.kind !== "cnpj") return null;
	if (!informado) return ops.holder.id;
	return informado.slice(0, 8) === ops.holder.id.slice(0, 8) ? informado : null;
}

async function producaoBloqueada(d1: D1Database, ambiente: Ambiente): Promise<Falha | null> {
	if (ambiente !== "producao" || (await store.getAllowProduction(d1))) return null;
	return falha(422, "producao_bloqueada", "Este cofre está travado em homologação. Libere a produção na tela /setup.");
}

// ---------- Guarda dos documentos ----------

interface Guardado {
	/** O documento já estava no cofre (mesmo NSU). */
	repetido: boolean;
	recebida: banco.Recebida | null;
	novaNota: boolean;
}

/**
 * Arquiva o documento, registra-o e atualiza a nota recebida a que ele se refere.
 * `foraDeOrdem`: o documento não veio pela sequência (busca por NSU ou por chave),
 * então um evento da nota pode ter chegado antes dela.
 */
async function guardar(d1: D1Database, ops: Operacoes, cursor: banco.Cursor, doc: DocumentoDistribuido, agora: number, foraDeOrdem = false): Promise<Guardado> {
	const lido = lerDocumento(doc.xml);
	const { environment, docId } = cursor;
	let destino: string;
	let chave: string | null = null;
	let evento: { tipo: string; sequencia: number } | null = null;
	switch (lido.tipo) {
		case "resumo_nfe":
		case "nfe":
			chave = lido.chave;
			destino = `${pasta(environment, chave)}/${lido.tipo === "nfe" ? "nfe" : "resumo"}.xml`;
			break;
		case "resumo_evento":
		case "evento":
			chave = lido.chave;
			evento = { tipo: lido.tpEvento, sequencia: lido.sequencia };
			destino = `${pasta(environment, chave)}/${lido.tipo === "evento" ? "evento" : "resumo-evento"}-${lido.tpEvento}-${dois(lido.sequencia)}.xml`;
			break;
		default:
			destino = `recebidas/${environment}/outros/${docId}-${doc.nsu ?? `sem-nsu-${agora}`}.xml`;
	}

	await ops.putDocument(destino, doc.xml, {
		contentType: "application/xml",
		meta: { tipo: `recebida_${lido.tipo}`, chaveAcesso: chave, nsu: doc.nsu, schema: doc.schema, ambiente: environment },
	});
	const novo = await banco.inserirDocumento(d1, {
		docId, environment, nsu: doc.nsu, schema: doc.schema, kind: lido.tipo, accessKey: chave,
		eventType: evento?.tipo ?? null, eventSeq: evento?.sequencia ?? null,
		detail: lido.tipo === "evento" || lido.tipo === "resumo_evento" ? { descricao: lido.descricao, em: lido.em, protocolo: lido.protocolo, autor: lido.autor } : {},
		documentKey: destino, receivedAt: agora,
	});
	if (!novo || !chave) return { repetido: !novo, recebida: null, novaNota: false };

	const k = { docId, environment, accessKey: chave };
	if (lido.tipo === "resumo_nfe" || lido.tipo === "nfe") {
		const completa = lido.tipo === "nfe";
		const jaCancelada = foraDeOrdem && (await banco.temEvento(d1, environment, chave, EVENTOS_DE_CANCELAMENTO));
		const r = await banco.salvarRecebida(
			d1,
			k,
			{
				// O resumo só é entregue ao destinatário; a nota completa também vai a transportador e terceiros.
				role: completa && lido.destinatario && lido.destinatario.slice(0, 8) !== docId.slice(0, 8) ? "terceiro" : undefined,
				emitDoc: lido.emitente.documento, emitName: lido.emitente.nome, emitIe: lido.emitente.ie,
				issuedAt: lido.emitidaEm, operation: lido.operacao, value: lido.valor, situation: jaCancelada ? "cancelada" : lido.situacao,
				protocol: lido.protocolo, authorizedAt: lido.autorizadaEm,
				...(completa ? { xmlKey: destino } : { summaryKey: destino }),
			},
			agora,
		);
		return { repetido: false, recebida: r.recebida, novaNota: r.nova };
	}
	// Evento: só interessa à lista de recebidas se a nota está nela. Eventos de notas
	// que o próprio titular emitiu ficam apenas no registro de documentos.
	if (lido.tipo === "evento" || lido.tipo === "resumo_evento") {
		const nota = await banco.findRecebida(d1, environment, chave);
		if (!nota) return { repetido: false, recebida: null, novaNota: false };
		const r = await banco.salvarRecebida(d1, k, EVENTOS_DE_CANCELAMENTO.has(lido.tpEvento) ? { situation: "cancelada" } : {}, agora);
		return { repetido: false, recebida: r.recebida, novaNota: false };
	}
	return { repetido: false, recebida: null, novaNota: false };
}

// ---------- Consulta por sequência (distNSU) ----------

export interface ResultadoSincronizacao {
	/** Falso quando a espera ainda não venceu ou outra consulta está em andamento: nada foi enviado. */
	consultou: boolean;
	lotes: number;
	/** Documentos novos no cofre, contando os recuperados. */
	documentos: number;
	/** Dos documentos, quantos eram NSU pulados, buscados um a um. */
	recuperados: number;
	notasNovas: number;
	cursor: banco.Cursor;
}

type Contagem = Omit<ResultadoSincronizacao, "cursor">;
type Mudanca = Parameters<typeof banco.atualizarCursor>[2];

/** Há NSU pulado para buscar e cota de consultas pontuais nesta hora? */
export const podeRecuperar = (c: banco.Cursor, agora: number) =>
	c.lacunas.length > 0 && c.pontuais.filter((t) => t > agora - HORA).length < LIMITE_DE_RECUPERACAO;

/**
 * Busca pelo NSU, em ordem, os documentos que o cofre pulou, até acabar a cota
 * de consultas pontuais da hora. `parar` vem preenchido quando o Ambiente
 * Nacional bloqueou ou não respondeu: a consulta toda para ali.
 */
async function recuperarPulados(d1: D1Database, ops: Operacoes, inicial: banco.Cursor, agora: number, resumo: Contagem): Promise<{ cursor: banco.Cursor; parar: Mudanca | null }> {
	const url = ambienteNacional(inicial.environment).distribuicao;
	let cursor = inicial;
	const resolvido = async () => {
		cursor = await banco.atualizarCursor(d1, cursor, { lacunas: banco.semOProximo(cursor.lacunas) });
	};
	// O limite de passos protege a execução quando muitos NSU já estão no cofre.
	for (let passo = 0; passo < 40; passo++) {
		const nsu = banco.proximoPulado(cursor.lacunas);
		if (nsu === null) break;
		if (await banco.temNsu(d1, cursor, nsu)) {
			await resolvido();
			continue;
		}
		const pontuais = cursor.pontuais.filter((t) => t > agora - HORA);
		if (pontuais.length >= LIMITE_DE_RECUPERACAO) break;
		cursor = await banco.atualizarCursor(d1, cursor, { pontuais: [...pontuais, agora] });
		resumo.consultou = true;

		const pedido = distDFeInt({ ambiente: cursor.environment, uf: cursor.uf, cnpj: cursor.docId, consulta: { tipo: "nsu", nsu } });
		let r: Awaited<ReturnType<typeof lerRetornoDistribuicao>>;
		try {
			const res = await ops.transmit(requisicaoDistribuicao(url, pedido, `dfe:${cursor.docId}:nsu:${nsu}`));
			r = await lerRetornoDistribuicao(res.status, base64ParaTexto(res.bodyB64));
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
			return { cursor, parar: { nextAt: agora + NOVA_TENTATIVA_MS, lastCode: err.code, lastMessage: err.message } };
		}
		if (r.tipo === "indefinida") return { cursor, parar: { nextAt: agora + NOVA_TENTATIVA_MS, lastCode: "sem_resposta_conclusiva", lastMessage: r.detalhe } };
		if (r.codigo === "656" || SERVICO_PARALISADO.has(r.codigo)) {
			return { cursor, parar: { nextAt: agora + (r.codigo === "656" ? ESPERA_MS : NOVA_TENTATIVA_MS), lastCode: r.codigo, lastMessage: r.motivo } };
		}
		if (r.codigo === "138") {
			for (const doc of r.documentos) {
				const g = await guardar(d1, ops, cursor, { ...doc, nsu: doc.nsu ?? nsu }, agora, true);
				if (!g.repetido) {
					resumo.documentos++;
					resumo.recuperados++;
				}
				if (g.novaNota) resumo.notasNovas++;
			}
		} else if (r.codigo !== "137") {
			// 137: o NSU não tem mais documento (passou dos 90 dias). Qualquer outra recusa fica
			// no histórico, e o NSU sai da lista para a busca não travar nele.
			await store.audit(d1, { action: "distribuicao.nsu_nao_recuperado", actor: "cofre", outcome: "erro", detail: { cnpj: cursor.docId, ambiente: cursor.environment, nsu, codigo: r.codigo, motivo: r.motivo } });
		}
		await resolvido();
	}
	return { cursor, parar: null };
}

/**
 * Baixa o que chegou depois do último NSU, em lotes de até 50 documentos, até
 * alcançar o maior NSU ou o limite de lotes desta execução. Antes, busca os NSU
 * que ficaram para trás; com `soRecuperar`, faz só essa parte.
 */
export async function sincronizar(
	d1: D1Database,
	ops: Operacoes,
	inicial: banco.Cursor,
	opcoes: { maxLotes?: number; agora?: number; soRecuperar?: boolean } = {},
): Promise<ResultadoSincronizacao | Falha> {
	const agora = opcoes.agora ?? Date.now();
	const bloqueio = await producaoBloqueada(d1, inicial.environment);
	if (bloqueio) return bloqueio;
	const parado = { consultou: false, lotes: 0, documentos: 0, recuperados: 0, notasNovas: 0, cursor: inicial };
	if (inicial.nextAt > agora || !(await banco.reservarConsulta(d1, inicial, agora, agora + RESERVA_MS))) return parado;

	const url = ambienteNacional(inicial.environment).distribuicao;
	let cursor: banco.Cursor = { ...inicial, nextAt: agora + RESERVA_MS };
	const resumo: Contagem = { consultou: !opcoes.soRecuperar, lotes: 0, documentos: 0, recuperados: 0, notasNovas: 0 };
	const fechar = async (patch: Mudanca) => {
		cursor = await banco.atualizarCursor(d1, cursor, { lastAt: agora, ...patch });
		return { ...resumo, cursor };
	};

	if (cursor.lacunas.length > 0) {
		const recuperacao = await recuperarPulados(d1, ops, cursor, agora, resumo);
		cursor = recuperacao.cursor;
		if (recuperacao.parar) return fechar(recuperacao.parar);
	}
	if (opcoes.soRecuperar) {
		// Devolve a vez: a consulta por sequência continua podendo sair quando for pedida.
		cursor = await banco.atualizarCursor(d1, cursor, { nextAt: inicial.nextAt });
		return { ...resumo, cursor };
	}

	for (let lote = 0; lote < (opcoes.maxLotes ?? 5); lote++) {
		const pedido = distDFeInt({ ambiente: cursor.environment, uf: cursor.uf, cnpj: cursor.docId, consulta: { tipo: "sequencia", ultNsu: cursor.ultNsu } });
		let corpo: { status: number; texto: string };
		try {
			const res = await ops.transmit(requisicaoDistribuicao(url, pedido, `dfe:${cursor.docId}:${cursor.ultNsu}`));
			corpo = { status: res.status, texto: base64ParaTexto(res.bodyB64) };
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
			return fechar({ nextAt: agora + NOVA_TENTATIVA_MS, lastCode: err.code, lastMessage: err.message });
		}
		const r = await lerRetornoDistribuicao(corpo.status, corpo.texto);
		if (r.tipo === "indefinida") return fechar({ nextAt: agora + NOVA_TENTATIVA_MS, lastCode: "sem_resposta_conclusiva", lastMessage: r.detalhe });
		resumo.lotes++;

		if (r.codigo === "138") {
			for (const doc of r.documentos) {
				const g = await guardar(d1, ops, cursor, doc, agora);
				if (!g.repetido) resumo.documentos++;
				if (g.novaNota) resumo.notasNovas++;
			}
			// O lote só conta depois de guardado: se a execução parar no meio, o mesmo lote volta.
			const maiorDoLote = Math.max(cursor.ultNsu, ...r.documentos.map((d) => d.nsu ?? 0));
			const ultNsu = r.ultNsu ?? maiorDoLote;
			const maxNsu = Math.max(r.maxNsu ?? 0, ultNsu);
			const acabou = ultNsu >= maxNsu || ultNsu <= cursor.ultNsu;
			cursor = await banco.atualizarCursor(d1, cursor, {
				ultNsu, maxNsu, lastAt: agora, lastCode: r.codigo, lastMessage: r.motivo,
				// Enquanto houver mais, a reserva segue valendo; ao fim, começa a hora de espera.
				nextAt: acabou ? agora + ESPERA_MS : cursor.nextAt,
			});
			if (acabou) return { ...resumo, cursor };
			continue;
		}
		if (r.codigo === "137") {
			const ultNsu = Math.max(cursor.ultNsu, r.ultNsu ?? 0);
			return fechar({ ultNsu, maxNsu: Math.max(r.maxNsu ?? 0, ultNsu), nextAt: agora + ESPERA_MS, lastCode: r.codigo, lastMessage: r.motivo });
		}
		if (r.codigo === "656") {
			// Consumo indevido: bloqueio de uma hora. O retorno traz o último NSU que o Ambiente
			// Nacional entregou a este CNPJ; se for maior que o do cofre, outro sistema consultou
			// na frente. A sequência segue de onde ele parou, e os NSU que ficaram para trás
			// entram na lista do que o cofre busca um a um.
			const adiantado = r.ultNsu !== null && r.ultNsu > cursor.ultNsu ? r.ultNsu : null;
			let lacunas = cursor.lacunas;
			if (adiantado) {
				const nova = banco.comLacuna(cursor.lacunas, cursor.ultNsu + 1, adiantado, LIMITE_DE_PULADOS);
				lacunas = nova.lacunas;
				await store.audit(d1, {
					action: "distribuicao.sequencia_adiantada", actor: "cofre", outcome: "ok",
					detail: { cnpj: cursor.docId, ambiente: cursor.environment, de: cursor.ultNsu, para: adiantado, aRecuperar: banco.contarPulados(lacunas), descartados: nova.descartados },
				});
			}
			return fechar({ ultNsu: adiantado ?? cursor.ultNsu, maxNsu: Math.max(cursor.maxNsu, r.maxNsu ?? 0, adiantado ?? 0), lacunas, nextAt: agora + ESPERA_MS, lastCode: r.codigo, lastMessage: r.motivo });
		}
		return fechar({ nextAt: agora + (SERVICO_PARALISADO.has(r.codigo) ? NOVA_TENTATIVA_MS : ESPERA_MS), lastCode: r.codigo, lastMessage: r.motivo });
	}
	// Limite de lotes desta execução: há mais documentos e a próxima pode começar já.
	cursor = await banco.atualizarCursor(d1, cursor, { nextAt: agora });
	return { ...resumo, cursor };
}

// ---------- Consulta por chave (consChNFe) ----------

export type ResultadoConsultaChave = { ok: true; recebida: banco.Recebida } | Falha;

const bloqueado = (c: banco.Cursor, agora: number) => c.lastCode === "656" && c.nextAt > agora;
const hora = (ms: number) => new Date(ms).toISOString();

/** Busca uma NF-e pela chave de acesso. Só a nota vem; os eventos chegam pela sequência. */
export async function consultarChave(d1: D1Database, ops: Operacoes, cursor: banco.Cursor, chave: string, agora = Date.now()): Promise<ResultadoConsultaChave> {
	if (!chaveValida(chave) || chave.slice(20, 22) !== "55") return falha(422, "chave_de_acesso_invalida", "Informe a chave de acesso (44 posições) de uma NF-e, modelo 55.");
	const bloqueio = await producaoBloqueada(d1, cursor.environment);
	if (bloqueio) return bloqueio;
	if (bloqueado(cursor, agora)) {
		return falha(429, "consumo_indevido", `O Ambiente Nacional bloqueou as consultas deste CNPJ por uma hora. Tente depois de ${hora(cursor.nextAt)}.`);
	}
	const pontuais = cursor.pontuais.filter((t) => t > agora - HORA);
	if (pontuais.length >= LIMITE_POR_CHAVE) {
		return falha(429, "limite_de_consultas", `Limite de ${LIMITE_POR_CHAVE} consultas por chave em uma hora. Tente depois de ${hora((pontuais[0] as number) + HORA)}.`);
	}
	let atual = await banco.atualizarCursor(d1, cursor, { pontuais: [...pontuais, agora] });

	const pedido = distDFeInt({ ambiente: cursor.environment, uf: cursor.uf, cnpj: cursor.docId, consulta: { tipo: "chave", chave } });
	let r: Awaited<ReturnType<typeof lerRetornoDistribuicao>>;
	try {
		const res = await ops.transmit(requisicaoDistribuicao(ambienteNacional(cursor.environment).distribuicao, pedido, `dfe:${cursor.docId}:chave:${chave}`));
		r = await lerRetornoDistribuicao(res.status, base64ParaTexto(res.bodyB64));
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return falha(502, "sem_resposta_conclusiva", err.message, [{ codigo: err.code, descricao: err.message }]);
	}
	if (r.tipo === "indefinida") return falha(502, "sem_resposta_conclusiva", r.detalhe);
	const mensagem = { codigo: r.codigo, descricao: r.motivo };
	if (r.codigo === "656") {
		atual = await banco.atualizarCursor(d1, atual, { nextAt: agora + ESPERA_MS, lastAt: agora, lastCode: r.codigo, lastMessage: r.motivo });
		return falha(429, "consumo_indevido", `O Ambiente Nacional bloqueou as consultas deste CNPJ por uma hora. Tente depois de ${hora(atual.nextAt)}.`, [mensagem]);
	}
	if (r.codigo === "137") return falha(422, "nota_nao_localizada", "O Ambiente Nacional não tem esta nota disponível para este CNPJ.", [mensagem]);
	if (r.codigo !== "138") return falha(422, "consulta_rejeitada", r.motivo, [mensagem]);

	for (const doc of r.documentos) await guardar(d1, ops, atual, doc, agora, true);
	const recebida = await banco.findRecebida(d1, cursor.environment, chave);
	return recebida ? { ok: true, recebida } : falha(422, "nota_nao_localizada", "O retorno não trouxe a nota desta chave.", [mensagem]);
}

// ---------- Manifestação do destinatário ----------

export type ResultadoManifestacao =
	/** `repetido`: a mesma manifestação já estava registrada e nada novo foi enviado. */
	| { ok: true; recebida: banco.Recebida; repetido: boolean }
	| Falha;

export interface PedidoDeManifestacao {
	ambiente: Ambiente;
	chave: string;
	tipo: Manifestacao;
	justificativa?: string;
	/** CNPJ do destinatário, quando é uma filial; padrão: o da nota no cofre ou o titular. */
	cnpj?: string;
	/** Quem pediu, para o histórico. */
	origem: string;
	/** Depois de uma manifestação que libera o XML, tenta baixá-lo na hora pela chave. */
	baixarXml?: boolean;
}

export async function manifestar(d1: D1Database, ops: Operacoes, p: PedidoDeManifestacao, agora = Date.now()): Promise<ResultadoManifestacao> {
	if (!chaveValida(p.chave) || p.chave.slice(20, 22) !== "55") return falha(422, "chave_de_acesso_invalida", "Informe a chave de acesso (44 posições) de uma NF-e, modelo 55.");
	const nota = await banco.findRecebida(d1, p.ambiente, p.chave);
	const cnpj = cnpjDoTitular(ops, p.cnpj ?? nota?.docId);
	if (!cnpj) return falha(422, "emitente_divergente", "A manifestação é do titular do certificado (CNPJ) ou de uma filial de mesma raiz.");
	const m = MANIFESTACOES[p.tipo];
	const justificativa = p.tipo === "nao_realizada" ? p.justificativa?.trim() : undefined;
	if (p.tipo === "nao_realizada" && (!justificativa || justificativa.length < 15 || justificativa.length > 255)) {
		return falha(422, "justificativa_obrigatoria", "A operação não realizada exige a justificativa, de 15 a 255 caracteres.");
	}

	const anteriores = nota?.extra.manifestacoes ?? [];
	const ultima = anteriores[anteriores.length - 1];
	if (nota && ultima?.tipo === p.tipo && (ultima.justificativa ?? undefined) === justificativa) return { ok: true, recebida: nota, repetido: true };
	if (!m.conclusiva && anteriores.length > 0) {
		return falha(409, "manifestacao_ja_registrada", "A ciência da operação não cabe depois de outra manifestação da mesma nota.");
	}
	const sequencia = anteriores.filter((a) => a.tipo === p.tipo).length + 1;
	if (sequencia > 2) return falha(422, "limite_de_manifestacoes", "Cada manifestação conclusiva pode ser registrada no máximo duas vezes por nota.");

	const cursor = await banco.getCursor(d1, cnpj, p.ambiente);
	// Sem UF configurada, a data do evento sai no horário de Brasília.
	const evento = montarManifestacao({ ambiente: p.ambiente, cnpj, chave: p.chave, agora: new Date(agora) }, cursor?.uf ?? "DF", p.tipo, sequencia, justificativa);
	let assinado: string;
	let resposta: ReturnType<typeof lerRespostaEventoNfe>;
	let journalKey: string | undefined;
	try {
		assinado = (await ops.sign({ xml: evento.xml, tag: "infEvento", profile: "rsa-sha1" })).xml;
		const res = await ops.transmit(requisicaoSoap("evento", ambienteNacional(p.ambiente).evento, envEvento(assinado, String(agora)), evento.id));
		journalKey = res.journalKey;
		resposta = lerRespostaEventoNfe(res.status, base64ParaTexto(res.bodyB64));
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		const mensagens = [{ codigo: err.code, descricao: err.message }];
		return err.status === 422 ? falha(422, err.code, err.message, mensagens) : falha(502, "sem_resposta_conclusiva", err.message, mensagens);
	}
	if (resposta.tipo === "indefinida") return falha(502, "sem_resposta_conclusiva", resposta.detalhe);
	if (resposta.tipo === "rejeitado") return falha(422, "manifestacao_rejeitada", resposta.mensagem.descricao, [resposta.mensagem]);

	// "duplicado" (573): o evento já estava no Ambiente Nacional, registrado fora do cofre ou
	// num envio cuja resposta se perdeu. Fica anotado sem o protocolo e sem o XML.
	const registrado = resposta.tipo === "registrado" ? resposta : null;
	const destino = registrado ? `${pasta(p.ambiente, p.chave)}/manifestacao-${m.tpEvento}-${dois(sequencia)}.xml` : null;
	if (registrado && destino) {
		await ops.putDocument(destino, procEventoNFe(assinado, registrado.retEvento), {
			contentType: "application/xml",
			meta: { tipo: "recebida_manifestacao", chaveAcesso: p.chave, manifestacao: p.tipo, sequencia, protocolo: registrado.protocolo, ambiente: p.ambiente, diario: journalKey ?? null },
		});
	}
	const manifestacoes: banco.ManifestacaoRegistrada[] = [
		...anteriores,
		{ tipo: p.tipo, sequencia, protocolo: registrado?.protocolo ?? null, em: new Date(agora).toISOString(), justificativa: justificativa ?? null, documentKey: destino, origem: p.origem },
	];
	let { recebida } = await banco.salvarRecebida(d1, { docId: cnpj, environment: p.ambiente, accessKey: p.chave }, { extra: { ...nota?.extra, manifestacoes } }, agora);
	await store.audit(d1, { action: "manifestacao.registrar", actor: p.origem, outcome: "ok", detail: { chaveAcesso: p.chave, tipo: p.tipo, sequencia, ambiente: p.ambiente, protocolo: registrado?.protocolo ?? null } });

	// Ciência, confirmação e operação não realizada liberam o XML completo. Ele chega pela
	// sequência na próxima consulta; pedido pela chave, chega agora (se houver cota).
	if (p.baixarXml && p.tipo !== "desconhecimento" && !recebida.xmlKey && cursor) {
		const baixada = await consultarChave(d1, ops, cursor, p.chave, agora).catch(() => null);
		if (baixada?.ok) recebida = baixada.recebida;
	}
	return { ok: true, recebida, repetido: !registrado };
}

// ---------- Ciência automática ----------

export interface ResumoDaCiencia {
	registradas: number;
	recusadas: number;
}

/** Dia mais antigo de autorização em que a ciência ainda é tentada. */
const inicioDaCiencia = (agora: number) => new Date(agora - DIAS_PARA_CIENCIA * 24 * HORA).toISOString().slice(0, 10);

/** Há nota nova esperando a ciência automática? */
export async function haCienciaPendente(d1: D1Database, cursor: banco.Cursor, agora = Date.now()): Promise<boolean> {
	return (await banco.listSemCiencia(d1, cursor, inicioDaCiencia(agora), 1)).length > 0;
}

/**
 * Registra a ciência da operação das notas novas de que o cofre só tem o resumo.
 * A nota recusada fica marcada e não é tentada de novo.
 */
export async function darCienciaAutomatica(d1: D1Database, ops: Operacoes, cursor: banco.Cursor, limite = 10, agora = Date.now()): Promise<ResumoDaCiencia | Falha> {
	const bloqueio = await producaoBloqueada(d1, cursor.environment);
	if (bloqueio) return bloqueio;
	const resumo = { registradas: 0, recusadas: 0 };
	for (const nota of await banco.listSemCiencia(d1, cursor, inicioDaCiencia(agora), limite)) {
		const r = await manifestar(d1, ops, { ambiente: nota.environment, chave: nota.accessKey, tipo: "ciencia", origem: "agendador" }, agora);
		if (r.ok) {
			resumo.registradas++;
			continue;
		}
		// Sem resposta do Ambiente Nacional: para aqui e tenta de novo na próxima execução.
		if (r.status === 502) break;
		resumo.recusadas++;
		const motivo = r.mensagens[0] ?? { codigo: r.codigo, descricao: r.mensagem };
		await banco.salvarRecebida(d1, { docId: nota.docId, environment: nota.environment, accessKey: nota.accessKey }, { extra: { ...nota.extra, cienciaAutomatica: motivo } }, agora);
	}
	return resumo;
}
