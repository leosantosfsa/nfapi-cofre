// Painel do emitente: visão geral do período, listagem das notas emitidas e das
// recebidas com filtros, e o detalhe de cada nota. São rotas de administração
// (segredo do cofre); a API dos sistemas clientes fica em /v1.

import type { Context, Hono } from "hono";
import { nfeJson } from "./api-nfe";
import { distribuicaoJson, recebidaJson } from "./api-recebidas";
import type { AppEnv, Ctx } from "./app";
import { filho, primeiro, raizDoXml, texto } from "./danfe/leitura";
import * as banco from "./emissao/banco";
import type { Ambiente } from "./fiscal/dados";
import type { SituacaoRecebida } from "./nfe/distribuicao";
import * as recebidas from "./recebidas/banco";
import * as store from "./store";

type C = Context<Ctx>;

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const MODELOS = new Set(["nfse", "nfe", "nfce"]);
const SITUACOES = new Set(["processando", "autorizada", "rejeitada", "denegada", "contingencia", "erro", "indefinida", "cancelada"]);
const SITUACOES_RECEBIDAS = new Set(["autorizada", "cancelada", "denegada"]);

const dia = (v: string | undefined) => (v && DIA.test(v) ? v : undefined);
const ambiente = (v: string | undefined): Ambiente | undefined => (v === "producao" || v === "homologacao" ? v : undefined);
const hoje = (agora = Date.now()) => new Date(agora - 3 * 3_600_000).toISOString().slice(0, 10);

function pagina(c: C): { limite: number; salto: number; numero: number } {
	const numero = Math.max(Math.trunc(Number(c.req.query("pagina") ?? 1)) || 1, 1);
	const limite = Math.min(Math.max(Math.trunc(Number(c.req.query("porPagina") ?? 25)) || 25, 1), 100);
	return { limite, salto: (numero - 1) * limite, numero };
}

/** Uma nota emitida, como o painel a mostra (NFS-e, NF-e ou NFC-e). */
export const emitidaJson = (e: banco.Emission) => ({
	id: e.id,
	modelo: e.kind,
	ambiente: e.environment,
	referencia: e.reference,
	serie: e.serie,
	/** Na NFS-e, o número da nota (quando autorizada); `numeroDps` é o da declaração. */
	numero: e.kind === "nfse" ? e.fiscalNumber : String(e.number),
	numeroDps: e.kind === "nfse" ? e.number : null,
	situacao: e.status,
	chaveAcesso: e.accessKey,
	protocolo: e.protocol,
	emitidaEm: e.issuedAt ?? new Date(e.createdAt).toISOString(),
	valor: e.value ?? null,
	/** Destinatário (NF-e, NFC-e) ou tomador (NFS-e); null quando a nota não identifica ninguém. */
	destinatario: e.recipientDoc || e.recipientName ? { documento: e.recipientDoc ?? null, nome: e.recipientName ?? null } : null,
	xmlDisponivel: e.documentKey !== null,
});

/**
 * Completa o destinatário das emissões anteriores ao painel, lendo o XML
 * arquivado. Um punhado por chamada, para não pesar em nenhuma.
 */
export async function completarResumos(env: AppEnv, limite = 25): Promise<number> {
	for (const e of await banco.listSemResumo(env.DB, limite)) {
		let resumo: banco.ResumoDaEmissao = {};
		const objeto = e.documentKey ? await store.getDocument(env.DOCS, e.documentKey) : null;
		if (objeto) {
			try {
				const raiz = raizDoXml(await objeto.text());
				// NF-e e NFC-e: <dest>; NFS-e: <toma> dentro da DPS que a nota carrega.
				const quem = primeiro(raiz, e.kind === "nfse" ? "toma" : "dest");
				resumo = {
					recipientDoc: texto(quem, "CNPJ") ?? texto(quem, "CPF") ?? texto(quem, "idEstrangeiro") ?? texto(quem, "NIF") ?? null,
					recipientName: texto(quem, "xNome") ?? null,
				};
				if (e.kind !== "nfse" && !e.issuedAt) resumo.issuedAt = texto(filho(primeiro(raiz, "infNFe"), "ide"), "dhEmi") ?? null;
			} catch {
				// XML ilegível: a emissão fica só com o que já se sabia.
			}
		}
		await banco.anotarResumo(env.DB, e.id, resumo);
	}
	return banco.contarSemResumo(env.DB);
}

export function registrarApiPainel(app: Hono<Ctx>) {
	// ---------- Visão geral ----------

	app.get("/admin/painel/resumo", async (c) => {
		const producaoLiberada = await store.getAllowProduction(c.env.DB);
		const amb = ambiente(c.req.query("ambiente")) ?? (producaoLiberada ? "producao" : "homologacao");
		const ate = dia(c.req.query("ate")) ?? hoje();
		const de = dia(c.req.query("de")) ?? `${ate.slice(0, 8)}01`;
		const periodo = { de, ate, environment: amb };

		const pendentes = await completarResumos(c.env);
		const [porSituacao, porDia, certificado, emContingencia, cursores, notasRecebidas] = await Promise.all([
			banco.totaisPorSituacao(c.env.DB, periodo),
			banco.autorizadasPorDia(c.env.DB, periodo),
			store.getCertificateInfo(c.env.DB),
			banco.contarEmContingencia(c.env.DB),
			recebidas.listCursores(c.env.DB),
			recebidas.buscarRecebidas(c.env.DB, periodo, { limite: 1, salto: 0 }),
		]);

		const soma = (situacoes: string[]) =>
			porSituacao.filter((t) => situacoes.includes(t.status)).reduce((s, t) => ({ quantidade: s.quantidade + t.quantidade, valor: s.valor + t.valor }), { quantidade: 0, valor: 0 });
		return c.json({
			ambiente: amb,
			periodo: { de, ate },
			producaoLiberada,
			certificado,
			emitidas: {
				autorizadas: soma(["autorizada"]),
				canceladas: soma(["cancelada"]),
				/** Recusadas pelo governo ou pelo cofre antes de sair: não têm valor fiscal. */
				naoAutorizadas: soma(["rejeitada", "denegada", "erro"]),
				/** Sem resposta conclusiva ou ainda em andamento: pedem conferência. */
				pendentes: soma(["processando", "indefinida", "contingencia"]),
				porModelo: porSituacao.map((t) => ({ modelo: t.kind, situacao: t.status, quantidade: t.quantidade, valor: t.valor })),
				porDia,
			},
			/** NFC-e em contingência aguardando a transmissão, em qualquer período. */
			contingenciaPendente: emContingencia,
			recebidas: { quantidade: notasRecebidas.total, valor: notasRecebidas.valor, semXml: notasRecebidas.semXml },
			distribuicoes: cursores.map((d) => distribuicaoJson(d)),
			/** Notas antigas cujo destinatário o cofre ainda está lendo do XML arquivado. */
			resumosPendentes: pendentes,
		});
	});

	// ---------- Notas emitidas ----------

	app.get("/admin/painel/emitidas", async (c) => {
		const modelo = c.req.query("modelo");
		const situacao = c.req.query("situacao");
		const p = pagina(c);
		const pendentes = await completarResumos(c.env);
		const r = await banco.buscarEmissoes(
			c.env.DB,
			{
				de: dia(c.req.query("de")),
				ate: dia(c.req.query("ate")),
				kind: modelo && MODELOS.has(modelo) ? (modelo as banco.Kind) : undefined,
				status: situacao && SITUACOES.has(situacao) ? (situacao as banco.EmissionStatus) : undefined,
				environment: ambiente(c.req.query("ambiente")),
				busca: c.req.query("busca"),
			},
			p,
		);
		return c.json({ itens: r.itens.map(emitidaJson), total: r.total, valor: r.valor, pagina: p.numero, porPagina: p.limite, resumosPendentes: pendentes });
	});

	app.get("/admin/painel/emitidas/:id", async (c) => {
		const e = await banco.getEmission(c.env.DB, c.req.param("id"));
		if (!e) return c.json({ error: { code: "nao_encontrado", message: "Nota inexistente neste cofre." } }, 404);
		const detalhe = e.kind === "nfse" ? null : nfeJson(e);
		return c.json({
			nota: {
				...emitidaJson(e),
				autorizadaEm: detalhe?.autorizadaEm ?? null,
				cartasCorrecao: detalhe?.cartasCorrecao ?? 0,
				contingencia: detalhe?.contingencia ?? null,
				urlConsulta: detalhe?.urlConsulta ?? null,
				/** Código e motivo devolvidos pelo governo, ou o erro do cofre. */
				mensagens: e.messages,
				criadaEm: new Date(e.createdAt).toISOString(),
				atualizadaEm: new Date(e.updatedAt).toISOString(),
			},
			arquivos: e.accessKey ? await store.listArquivosDaNota(c.env.DB, e.accessKey) : [],
		});
	});

	// ---------- Notas recebidas ----------

	app.get("/admin/painel/recebidas", async (c) => {
		const situacao = c.req.query("situacao");
		const xml = c.req.query("xml");
		const p = pagina(c);
		const r = await recebidas.buscarRecebidas(
			c.env.DB,
			{
				de: dia(c.req.query("de")),
				ate: dia(c.req.query("ate")),
				environment: ambiente(c.req.query("ambiente")),
				situation: situacao && SITUACOES_RECEBIDAS.has(situacao) ? (situacao as SituacaoRecebida) : undefined,
				xml: xml === "completo" || xml === "resumo" ? xml : undefined,
				busca: c.req.query("busca"),
			},
			p,
		);
		return c.json({ itens: r.itens.map(recebidaJson), total: r.total, valor: r.valor, semXml: r.semXml, pagina: p.numero, porPagina: p.limite });
	});

	app.get("/admin/painel/recebidas/:id", async (c) => {
		const nota = await recebidas.getRecebida(c.env.DB, c.req.param("id"));
		if (!nota) return c.json({ error: { code: "nao_encontrado", message: "Nota inexistente neste cofre." } }, 404);
		const eventos = await recebidas.listDocumentos(c.env.DB, { environment: nota.environment, accessKey: nota.accessKey, eventos: true, limite: 100 });
		return c.json({
			nota: recebidaJson(nota),
			eventos: eventos.map((d) => ({
				codigo: d.eventType,
				sequencia: d.eventSeq,
				descricao: d.detail.descricao ?? null,
				registradoEm: d.detail.em ?? null,
				protocolo: d.detail.protocolo ?? null,
				autor: d.detail.autor ?? null,
			})),
		});
	});
}
