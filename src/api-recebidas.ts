// NF-e recebidas: as notas que outras empresas emitiram contra o CNPJ do
// titular, baixadas do Ambiente Nacional (distribuição de DF-e), e a
// manifestação do destinatário.
//
//   GET  /v1/nfe-recebidas                          lista, na ordem da sequência de leitura (?depois=)
//   GET  /v1/nfe-recebidas/:id                      a nota, com os eventos recebidos
//   GET  /v1/nfe-recebidas/:id/xml                  XML completo (nfeProc), quando já liberado
//   GET  /v1/nfe-recebidas/:id/danfe                DANFE em PDF, quando há o XML completo
//   POST /v1/nfe-recebidas/:id/manifestar           ciência, confirmação, desconhecimento ou operação não realizada
//   POST /v1/nfe-recebidas/manifestar               o mesmo, pela chave de acesso
//   GET  /v1/nfe-recebidas/:id/manifestacoes/:tipo/:sequencia/xml
//   GET  /v1/distribuicao                           onde a consulta parou e quando sai a próxima
//   POST /v1/distribuicao/sincronizar               consulta agora, se a espera já venceu
//   POST /v1/distribuicao/consultar-chave           busca uma NF-e pela chave de acesso
//   GET  /v1/distribuicao/documentos                tudo o que foi entregue, na ordem de chegada
//   GET  /v1/distribuicao/documentos/:sequencia/xml
//
// O último NSU e o horário da próxima consulta ficam só no cofre (ver recebidas/servico.ts).

import type { Context, Hono } from "hono";
import { z } from "zod";
import { ambienteDoFiltro, autenticar, erro, iso, operacoes, problema } from "./api-nfse";
import type { AppEnv, Ctx } from "./app";
import * as banco from "./recebidas/banco";
import { ConfiguracaoInput, ConsultarChaveInput, ManifestacaoInput, ManifestacaoPorChaveInput, SincronizarInput } from "./recebidas/schema";
import { type Falha, LIMITE_POR_CHAVE, type ResultadoSincronizacao, cnpjDoTitular, consultarChave, manifestar, sincronizar } from "./recebidas/servico";
import * as store from "./store";
import type { Transport } from "./transport";

type C = Context<Ctx>;

const manifestacaoJson = (m: banco.ManifestacaoRegistrada) => ({
	tipo: m.tipo,
	sequencia: m.sequencia,
	protocolo: m.protocolo,
	registradaEm: m.em,
	justificativa: m.justificativa,
	/** `agendador` na ciência automática; senão, a chave de API ou o painel. */
	origem: m.origem,
	xmlDisponivel: m.documentKey !== null,
});

export const recebidaJson = (r: banco.Recebida) => {
	const manifestacoes = (r.extra.manifestacoes ?? []).map(manifestacaoJson);
	return {
		id: r.id,
		ambiente: r.environment,
		/** CNPJ do titular (ou da filial) a quem a nota interessa. */
		cnpj: r.docId,
		chaveAcesso: r.accessKey,
		/** Cresce a cada mudança da nota: é o valor a passar em ?depois= na próxima leitura. */
		sequencia: r.seq,
		/** `terceiro`: o titular é transportador ou autorizado a baixar o XML, não o destinatário. */
		papel: r.role,
		emitente: { documento: r.emitDoc ?? r.accessKey.slice(6, 20), nome: r.emitName, ie: r.emitIe },
		serie: Number(r.accessKey.slice(22, 25)),
		numero: Number(r.accessKey.slice(25, 34)),
		emitidaEm: r.issuedAt,
		autorizadaEm: r.authorizedAt,
		protocolo: r.protocol,
		tipoOperacao: r.operation,
		valor: r.value,
		/** Null enquanto o cofre só conhece a chave (manifestação feita antes de o resumo chegar). */
		situacao: r.situation,
		/** O XML completo só é entregue ao destinatário depois da manifestação. */
		xmlDisponivel: r.xmlKey !== null,
		manifestacao: manifestacoes[manifestacoes.length - 1] ?? null,
		manifestacoes,
		/** Motivo da recusa quando a ciência automática foi tentada e não foi aceita. */
		cienciaAutomaticaRecusada: r.extra.cienciaAutomatica ?? null,
		recebidaEm: iso(r.createdAt),
		atualizadaEm: iso(r.updatedAt),
	};
};

const documentoJson = (d: banco.DocumentoDfe) => ({
	sequencia: d.seq,
	ambiente: d.environment,
	cnpj: d.docId,
	nsu: d.nsu,
	/** resumo_nfe, nfe, resumo_evento, evento ou outro. */
	tipo: d.kind,
	schema: d.schema,
	chaveAcesso: d.accessKey,
	evento: d.eventType ? { codigo: d.eventType, sequencia: d.eventSeq, descricao: d.detail.descricao ?? null, registradoEm: d.detail.em ?? null, protocolo: d.detail.protocolo ?? null, autor: d.detail.autor ?? null } : null,
	recebidoEm: iso(d.receivedAt),
});

export const distribuicaoJson = (c: banco.Cursor, agora = Date.now()) => ({
	cnpj: c.docId,
	ambiente: c.environment,
	uf: c.uf,
	consultaAutomatica: c.auto,
	cienciaAutomatica: c.autoCiencia,
	ultimoNsu: c.ultNsu,
	maiorNsu: c.maxNsu,
	ultimaConsulta: c.lastAt ? iso(c.lastAt) : null,
	/** Antes deste instante o cofre não consulta: é a espera que o Ambiente Nacional exige. */
	proximaConsulta: c.nextAt > agora ? iso(c.nextAt) : null,
	/** Consumo indevido (656): o Ambiente Nacional recusa tudo deste CNPJ até a próxima consulta. */
	bloqueada: c.lastCode === "656" && c.nextAt > agora,
	/** Código e motivo da última resposta (cStat e xMotivo), ou o erro do cofre. */
	mensagem: c.lastCode ? { codigo: c.lastCode, descricao: c.lastMessage ?? "" } : null,
	consultasPorChave: { naUltimaHora: c.pontuais.filter((t) => t > agora - 3_600_000).length, limite: LIMITE_POR_CHAVE },
	/** NSU que o cofre pulou (outro sistema consultou na frente) e ainda vai buscar um a um. */
	documentosARecuperar: banco.contarPulados(c.lacunas),
});

const sincronizacaoJson = (r: ResultadoSincronizacao) => ({
	consultou: r.consultou,
	lotes: r.lotes,
	documentos: r.documentos,
	recuperados: r.recuperados,
	notasNovas: r.notasNovas,
	distribuicao: distribuicaoJson(r.cursor),
});

export function registrarApiRecebidas(app: Hono<Ctx>, makeTransport: (env: AppEnv) => Transport) {
	const somenteHomologacao = (c: C) => erro(c, 403, "chave_somente_homologacao", "Esta chave de API só opera em homologação.");
	const falhou = (c: C, f: Falha) => erro(c, f.status, f.codigo, f.mensagem, { mensagens: f.mensagens });
	const inexistente = (c: C) => erro(c, 404, "nao_encontrado", "Nota recebida inexistente.");
	const xml = (c: C, object: R2ObjectBody) => c.body(object.body, 200, { "content-type": "application/xml; charset=utf-8" });
	const inteiro = (valor: string | undefined, padrao: number) => (valor && /^\d{1,15}$/.test(valor) ? Number(valor) : padrao);

	/** O cursor do CNPJ pedido (ou do titular), ou a resposta que explica por que não há. */
	const cursorDe = async (c: C, ops: { holder: { kind: string; id: string } }, ambiente: "homologacao" | "producao", informado?: string) => {
		const cnpj = cnpjDoTitular(ops as Parameters<typeof cnpjDoTitular>[0], informado);
		if (!cnpj) return erro(c, 422, "emitente_divergente", "A consulta é do titular do certificado (CNPJ) ou de uma filial de mesma raiz.");
		const cursor = await banco.getCursor(c.env.DB, cnpj, ambiente);
		return cursor ?? erro(c, 409, "distribuicao_nao_configurada", "Configure as notas recebidas na tela /setup (UF do estabelecimento) antes de consultar.");
	};

	// ---------- Notas recebidas ----------

	app.get("/v1/nfe-recebidas", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const ambiente = ambienteDoFiltro(c);
		if (ambiente === null) return erro(c, 400, "requisicao_invalida", 'O filtro "ambiente" aceita homologacao ou producao.');
		const depois = inteiro(c.req.query("depois"), 0);
		const limite = Math.min(Math.max(inteiro(c.req.query("limite"), 50), 1), 200);
		// Uma a mais que o limite, só para saber se há mais.
		const lista = await banco.listRecebidas(c.env.DB, { depois, limite: Math.min(limite + 1, 200), environment: ambiente, accessKey: c.req.query("chaveAcesso") || undefined });
		const pagina = lista.slice(0, limite);
		return c.json({
			recebidas: pagina.map(recebidaJson),
			/** Passe este valor em ?depois= para ler só o que mudar daqui em diante. */
			ultimaSequencia: pagina[pagina.length - 1]?.seq ?? depois,
			haMais: lista.length > pagina.length,
		});
	});

	app.post("/v1/nfe-recebidas/manifestar", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = ManifestacaoPorChaveInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		if (chave.scope === "homologacao" && input.data.ambiente !== "homologacao") return somenteHomologacao(c);
		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const r = await manifestar(c.env.DB, ops, {
			ambiente: input.data.ambiente, chave: input.data.chaveAcesso, tipo: input.data.tipo, justificativa: input.data.justificativa,
			cnpj: input.data.cnpj, origem: `chave:${chave.id}`, baixarXml: true,
		});
		return r.ok ? c.json({ ...recebidaJson(r.recebida), repetido: r.repetido }) : falhou(c, r);
	});

	app.get("/v1/nfe-recebidas/:id", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const nota = await banco.getRecebida(c.env.DB, c.req.param("id"));
		if (!nota) return inexistente(c);
		const eventos = await banco.listDocumentos(c.env.DB, { environment: nota.environment, accessKey: nota.accessKey, eventos: true, limite: 200 });
		return c.json({ ...recebidaJson(nota), eventos: eventos.map(documentoJson) });
	});

	app.get("/v1/nfe-recebidas/:id/xml", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const nota = await banco.getRecebida(c.env.DB, c.req.param("id"));
		if (!nota) return inexistente(c);
		const object = nota.xmlKey ? await store.getDocument(c.env.DOCS, nota.xmlKey) : null;
		return object ? xml(c, object) : erro(c, 409, "xml_indisponivel", "O cofre só tem o resumo desta nota. O XML completo é liberado depois da manifestação do destinatário.");
	});

	app.get("/v1/nfe-recebidas/:id/danfe", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const nota = await banco.getRecebida(c.env.DB, c.req.param("id"));
		if (!nota) return inexistente(c);
		const object = nota.xmlKey ? await store.getDocument(c.env.DOCS, nota.xmlKey) : null;
		if (!object) return erro(c, 409, "xml_indisponivel", "O DANFE precisa do XML completo, liberado depois da manifestação do destinatário.");
		return danfeDaRecebida(c, nota, await object.text());
	});

	app.post("/v1/nfe-recebidas/:id/manifestar", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = ManifestacaoInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		const nota = await banco.getRecebida(c.env.DB, c.req.param("id"));
		if (!nota) return inexistente(c);
		if (chave.scope === "homologacao" && nota.environment !== "homologacao") return somenteHomologacao(c);
		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const r = await manifestar(c.env.DB, ops, {
			ambiente: nota.environment, chave: nota.accessKey, tipo: input.data.tipo, justificativa: input.data.justificativa, origem: `chave:${chave.id}`, baixarXml: true,
		});
		return r.ok ? c.json({ ...recebidaJson(r.recebida), repetido: r.repetido }) : falhou(c, r);
	});

	app.get("/v1/nfe-recebidas/:id/manifestacoes/:tipo/:sequencia/xml", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const nota = await banco.getRecebida(c.env.DB, c.req.param("id"));
		const m = nota?.extra.manifestacoes?.find((x) => x.tipo === c.req.param("tipo") && String(x.sequencia) === c.req.param("sequencia"));
		const object = m?.documentKey ? await store.getDocument(c.env.DOCS, m.documentKey) : null;
		return object ? xml(c, object) : erro(c, 404, "nao_encontrado", "Esta manifestação não está arquivada no cofre.");
	});

	// ---------- Distribuição ----------

	app.get("/v1/distribuicao", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		return c.json({ distribuicoes: (await banco.listCursores(c.env.DB)).map((d) => distribuicaoJson(d)) });
	});

	app.post("/v1/distribuicao/sincronizar", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = SincronizarInput.safeParse(await c.req.json().catch(() => ({})));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		if (chave.scope === "homologacao" && input.data.ambiente !== "homologacao") return somenteHomologacao(c);
		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const cursor = await cursorDe(c, ops, input.data.ambiente, input.data.cnpj);
		if (cursor instanceof Response) return cursor;
		const r = await sincronizar(c.env.DB, ops, cursor);
		if ("ok" in r) return falhou(c, r);
		return c.json(sincronizacaoJson(r));
	});

	app.post("/v1/distribuicao/consultar-chave", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = ConsultarChaveInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		if (chave.scope === "homologacao" && input.data.ambiente !== "homologacao") return somenteHomologacao(c);
		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const cursor = await cursorDe(c, ops, input.data.ambiente, input.data.cnpj);
		if (cursor instanceof Response) return cursor;
		const r = await consultarChave(c.env.DB, ops, cursor, input.data.chaveAcesso);
		return r.ok ? c.json(recebidaJson(r.recebida)) : falhou(c, r);
	});

	app.get("/v1/distribuicao/documentos", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const ambiente = ambienteDoFiltro(c);
		if (ambiente === null) return erro(c, 400, "requisicao_invalida", 'O filtro "ambiente" aceita homologacao ou producao.');
		const depois = inteiro(c.req.query("depois"), 0);
		const limite = Math.min(Math.max(inteiro(c.req.query("limite"), 50), 1), 200);
		const lista = await banco.listDocumentos(c.env.DB, { depois, limite: Math.min(limite + 1, 200), environment: ambiente, accessKey: c.req.query("chaveAcesso") || undefined });
		const pagina = lista.slice(0, limite);
		return c.json({ documentos: pagina.map(documentoJson), ultimaSequencia: pagina[pagina.length - 1]?.seq ?? depois, haMais: lista.length > pagina.length });
	});

	app.get("/v1/distribuicao/documentos/:sequencia/xml", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const doc = await banco.getDocumento(c.env.DB, inteiro(c.req.param("sequencia"), 0));
		const object = doc ? await store.getDocument(c.env.DOCS, doc.documentKey) : null;
		return object ? xml(c, object) : erro(c, 404, "nao_encontrado", "Documento inexistente.");
	});

	// ---------- Configuração e painel do emitente (tela /setup) ----------

	const recusar = (c: C, status: 400 | 404 | 409 | 422 | 429 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);
	const estado = async (c: C) => ({ distribuicoes: (await banco.listCursores(c.env.DB)).map((d) => distribuicaoJson(d)), recebidas: await banco.contarRecebidas(c.env.DB) });

	app.get("/admin/distribuicao", async (c) => c.json(await estado(c)));

	app.put("/admin/distribuicao", async (c) => {
		const input = ConfiguracaoInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return recusar(c, 400, "requisicao_invalida", problema(input.error));
		const cert = await store.getCertificateInfo(c.env.DB);
		if (!cert) return recusar(c, 409, "certificado_ausente", "Instale o certificado antes de configurar as notas recebidas.");
		const cnpj = cnpjDoTitular({ holder: cert.holder }, input.data.cnpj);
		if (!cnpj) return recusar(c, 400, "emitente_divergente", "As notas recebidas são do titular do certificado (CNPJ) ou de uma filial de mesma raiz.");
		const { ambiente, uf, consultaAutomatica, cienciaAutomatica } = input.data;
		if (ambiente === "producao" && consultaAutomatica && !(await store.getAllowProduction(c.env.DB))) {
			return recusar(c, 409, "producao_bloqueada", "Este cofre está travado em homologação. Libere a produção antes de ligar a consulta em produção.");
		}
		const cursor = await banco.configurarCursor(c.env.DB, { docId: cnpj, environment: ambiente }, { uf, auto: consultaAutomatica, autoCiencia: consultaAutomatica && cienciaAutomatica });
		await store.audit(c.env.DB, { action: "distribuicao.configurar", actor: "admin", outcome: "ok", detail: { cnpj, ambiente, uf, consultaAutomatica: cursor.auto, cienciaAutomatica: cursor.autoCiencia } });
		return c.json({ distribuicao: distribuicaoJson(cursor) });
	});

	app.post("/admin/distribuicao/sincronizar", async (c) => {
		const input = SincronizarInput.safeParse(await c.req.json().catch(() => ({})));
		if (!input.success) return recusar(c, 400, "requisicao_invalida", problema(input.error));
		const ops = await operacoes(c, makeTransport(c.env), "admin");
		if (ops instanceof Response) return ops;
		const cnpj = cnpjDoTitular(ops, input.data.cnpj);
		const cursor = cnpj ? await banco.getCursor(c.env.DB, cnpj, input.data.ambiente) : null;
		if (!cursor) return recusar(c, 409, "distribuicao_nao_configurada", "Salve a configuração das notas recebidas antes de consultar.");
		const r = await sincronizar(c.env.DB, ops, cursor);
		if ("ok" in r) return recusar(c, r.status, r.codigo, r.mensagem);
		return c.json(sincronizacaoJson(r));
	});

	app.get("/admin/recebidas", async (c) => {
		const ambiente = ambienteDoFiltro(c) ?? undefined;
		return c.json({ recebidas: (await banco.listRecebidas(c.env.DB, { recentes: true, limite: 100, environment: ambiente })).map(recebidaJson) });
	});

	app.post("/admin/recebidas/manifestar", async (c) => {
		const input = ManifestacaoInput.extend({ id: z.string() }).safeParse(await c.req.json().catch(() => null));
		if (!input.success) return recusar(c, 400, "requisicao_invalida", problema(input.error));
		const nota = await banco.getRecebida(c.env.DB, input.data.id);
		if (!nota) return recusar(c, 404, "nao_encontrado", "Nota recebida inexistente.");
		const ops = await operacoes(c, makeTransport(c.env), "admin");
		if (ops instanceof Response) return ops;
		const r = await manifestar(c.env.DB, ops, { ambiente: nota.environment, chave: nota.accessKey, tipo: input.data.tipo, justificativa: input.data.justificativa, origem: "admin", baixarXml: true });
		return r.ok ? c.json({ recebida: recebidaJson(r.recebida), repetido: r.repetido }) : recusar(c, r.status, r.codigo, r.mensagem);
	});

	// Download do XML completo (ou, sem ele, do resumo) e do DANFE de uma nota recebida.
	app.get("/admin/recebidas/arquivo", async (c) => {
		const nota = await banco.getRecebida(c.env.DB, c.req.query("id") ?? "");
		if (!nota) return recusar(c, 404, "nao_encontrado", "Nota recebida inexistente.");
		const pdf = c.req.query("tipo") === "danfe";
		const key = pdf ? nota.xmlKey : (nota.xmlKey ?? nota.summaryKey);
		const object = key ? await store.getDocument(c.env.DOCS, key) : null;
		if (!object) return recusar(c, 409, "xml_indisponivel", "O cofre ainda não tem este arquivo.");
		if (pdf) return danfeDaRecebida(c, nota, await object.text());
		return c.body(object.body, 200, {
			"content-type": "application/xml; charset=utf-8",
			"content-disposition": `attachment; filename="${nota.accessKey}-${nota.xmlKey ? "nfe" : "resumo"}.xml"`,
		});
	});
}

/** DANFE da nota recebida, sem logotipo: o do cofre é o do titular, não o do emitente da nota. */
async function danfeDaRecebida(c: C, nota: banco.Recebida, xml: string) {
	const { DanfeError, gerarDanfePdf } = await import("./danfe/danfe-pdf");
	try {
		const pdf = await gerarDanfePdf(xml, { cancelada: nota.situation === "cancelada" });
		return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
			"content-type": "application/pdf",
			"content-disposition": `inline; filename="${nota.accessKey}-danfe.pdf"`,
			"cache-control": "private, no-store",
		});
	} catch (err) {
		if (!(err instanceof DanfeError)) throw err;
		return c.json(c.req.path.startsWith("/v1/") ? { erro: { codigo: "xml_indisponivel", mensagem: err.message } } : { error: { code: "xml_indisponivel", message: err.message } }, 409);
	}
}
