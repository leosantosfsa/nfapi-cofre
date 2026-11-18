// Relatórios e exportação por período, para os sistemas clientes (/v1) e para o
// painel do emitente (/admin/painel).
//
//   GET  /v1/notas                         notas emitidas dos três documentos, com filtros
//   GET  /v1/relatorios/notas              totais do período
//   POST /v1/exportacoes                   cria a exportação de XML do período
//   GET  /v1/exportacoes                   exportações ainda válidas
//   GET  /v1/exportacoes/:id               situação e links de download
//   GET  /exportacoes/:id/:arquivo         download, pelo link assinado (sem chave de API)
//
// O download é um link com prazo curto para que o navegador do usuário baixe o
// arquivo direto do cofre, sem passar pelo sistema cliente.

import type { Context, Hono } from "hono";
import { ambienteDoFiltro, autenticar, erro, iso, problema } from "./api-nfse";
import { emitidaJson } from "./api-painel";
import type { Ctx } from "./app";
import { secretIsStrong } from "./crypto";
import * as banco from "./emissao/banco";
import {
	type Exportacao, VALIDADE_DO_LINK_MS, assinaturaValida, avancarExportacao, criarExportacao, getExportacao, lerPlanilha, linkAssinado, listExportacoes, nomeDaParte,
	nomeDaPlanilha, zipDaParte,
} from "./exportacao";
import type { Ambiente } from "./fiscal/dados";
import { relatorio } from "./relatorios";
import { ExportacaoInput, PeriodoInput } from "./relatorios-schema";

type C = Context<Ctx>;

const MODELOS = new Set(["nfse", "nfe", "nfce"]);
const SITUACOES = new Set(["processando", "autorizada", "rejeitada", "denegada", "contingencia", "erro", "indefinida", "cancelada"]);
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export async function exportacaoJson(c: C, r: { exportacao: Exportacao; notasPorLer: number }, agora = Date.now()) {
	const e = r.exportacao;
	const origem = new URL(c.req.url).origin;
	const expira = Math.min(agora + VALIDADE_DO_LINK_MS, e.expiresAt);
	const link = (arquivo: string) => linkAssinado(c.env.VAULT_SECRET, origem, e.id, arquivo, expira);
	const pronta = e.status === "pronta";
	return {
		id: e.id,
		ambiente: e.environment,
		periodo: { de: e.de, ate: e.ate },
		incluir: e.incluir,
		/** `preparando`: o cofre ainda está lendo os XML para a planilha; consulte de novo. `pronta`: os links valem. */
		situacao: e.status,
		notasPorLer: r.notasPorLer,
		arquivos: e.files,
		/** Quantos arquivos de cada tipo entraram. */
		conteudo: e.summary,
		/** O ZIP sai em partes; a planilha vai dentro da primeira. */
		partes: pronta
			? await Promise.all(Array.from({ length: e.parts }, async (_, i) => ({ parte: i + 1, nome: nomeDaParte(e, i + 1), url: await link(`parte-${i + 1}`) })))
			: [],
		planilha: pronta ? { nome: nomeDaPlanilha(e), url: await link("planilha") } : null,
		/** Os links param de valer neste instante; consultar a exportação devolve links novos. */
		linksValemAte: pronta ? iso(expira) : null,
		criadaEm: iso(e.createdAt),
		/** Depois disto a exportação e os arquivos dela são apagados. */
		expiraEm: iso(e.expiresAt),
	};
}

export function registrarApiRelatorios(app: Hono<Ctx>) {
	const somenteHomologacao = (c: C) => erro(c, 403, "chave_somente_homologacao", "Esta chave de API só opera em homologação.");
	const periodoDaConsulta = (c: C) => PeriodoInput.safeParse({ ambiente: c.req.query("ambiente"), de: c.req.query("de"), ate: c.req.query("ate") });
	const periodo = (p: { ambiente: Ambiente; de: string; ate: string }) => ({ de: p.de, ate: p.ate, environment: p.ambiente });

	// ---------- Sistemas clientes ----------

	app.get("/v1/notas", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const ambiente = ambienteDoFiltro(c);
		if (ambiente === null) return erro(c, 400, "requisicao_invalida", 'O filtro "ambiente" aceita homologacao ou producao.');
		const [de, ate, modelo, situacao] = [c.req.query("de"), c.req.query("ate"), c.req.query("modelo"), c.req.query("situacao")];
		if ((de && !DIA.test(de)) || (ate && !DIA.test(ate))) return erro(c, 400, "requisicao_invalida", 'Os filtros "de" e "ate" usam o formato AAAA-MM-DD.');
		if (modelo && !MODELOS.has(modelo)) return erro(c, 400, "requisicao_invalida", 'O filtro "modelo" aceita nfse, nfe ou nfce.');
		if (situacao && !SITUACOES.has(situacao)) return erro(c, 400, "requisicao_invalida", 'O filtro "situacao" não reconhece este valor.');
		const numero = Math.max(Math.trunc(Number(c.req.query("pagina") ?? 1)) || 1, 1);
		const limite = Math.min(Math.max(Math.trunc(Number(c.req.query("porPagina") ?? 50)) || 50, 1), 200);
		const r = await banco.buscarEmissoes(
			c.env.DB,
			{ de, ate, kind: modelo as banco.Kind | undefined, status: situacao as banco.EmissionStatus | undefined, environment: ambiente, busca: c.req.query("busca") },
			{ limite, salto: (numero - 1) * limite },
		);
		return c.json({ notas: r.itens.map(emitidaJson), total: r.total, valor: r.valor, pagina: numero, porPagina: limite });
	});

	app.get("/v1/relatorios/notas", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const p = periodoDaConsulta(c);
		if (!p.success) return erro(c, 400, "requisicao_invalida", problema(p.error));
		if (chave.scope === "homologacao" && p.data.ambiente !== "homologacao") return somenteHomologacao(c);
		return c.json(await relatorio(c.env, periodo(p.data)));
	});

	app.post("/v1/exportacoes", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = ExportacaoInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		if (chave.scope === "homologacao" && input.data.ambiente !== "homologacao") return somenteHomologacao(c);
		const r = await criarExportacao(c.env, { ...periodo(input.data), incluir: input.data.incluir }, `chave:${chave.id}`);
		return c.json(await exportacaoJson(c, r), 201);
	});

	app.get("/v1/exportacoes", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const lista = (await listExportacoes(c.env.DB)).filter((e) => chave.scope !== "homologacao" || e.environment === "homologacao");
		return c.json({ exportacoes: await Promise.all(lista.map((e) => exportacaoJson(c, { exportacao: e, notasPorLer: 0 }))) });
	});

	app.get("/v1/exportacoes/:id", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const e = await getExportacao(c.env.DB, c.req.param("id"));
		if (!e || (chave.scope === "homologacao" && e.environment !== "homologacao")) return erro(c, 404, "nao_encontrado", "Exportação inexistente ou já vencida.");
		return c.json(await exportacaoJson(c, await avancarExportacao(c.env, e)));
	});

	// ---------- Painel do emitente ----------

	const falhaDoPainel = (c: C, status: 400 | 404, message: string) => c.json({ error: { code: status === 404 ? "nao_encontrado" : "requisicao_invalida", message } }, status);

	app.get("/admin/painel/relatorio", async (c) => {
		const p = periodoDaConsulta(c);
		if (!p.success) return falhaDoPainel(c, 400, problema(p.error));
		return c.json(await relatorio(c.env, periodo(p.data)));
	});

	app.post("/admin/painel/exportacoes", async (c) => {
		const input = ExportacaoInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return falhaDoPainel(c, 400, problema(input.error));
		return c.json(await exportacaoJson(c, await criarExportacao(c.env, { ...periodo(input.data), incluir: input.data.incluir }, "admin")), 201);
	});

	app.get("/admin/painel/exportacoes/:id", async (c) => {
		const e = await getExportacao(c.env.DB, c.req.param("id"));
		if (!e) return falhaDoPainel(c, 404, "Exportação inexistente ou já vencida.");
		return c.json(await exportacaoJson(c, await avancarExportacao(c.env, e)));
	});

	// ---------- Download pelo link assinado ----------

	app.get("/exportacoes/:id/:arquivo", async (c) => {
		const negado = () => c.json({ erro: { codigo: "link_invalido", mensagem: "Este link de download não vale mais. Consulte a exportação para receber um novo." } }, 403);
		if (!secretIsStrong(c.env.VAULT_SECRET)) return negado();
		const { id, arquivo } = c.req.param();
		const valida = await assinaturaValida(c.env.VAULT_SECRET, id, arquivo, Number(c.req.query("expira")), c.req.query("assinatura") ?? "");
		if (!valida) return negado();
		const e = await getExportacao(c.env.DB, id);
		if (!e || e.status !== "pronta") return negado();

		if (arquivo === "planilha") {
			const objeto = await lerPlanilha(c.env, e);
			if (!objeto) return negado();
			return c.body(objeto.body, 200, {
				"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				"content-disposition": `attachment; filename="${nomeDaPlanilha(e)}"`,
			});
		}
		const parte = /^parte-(\d{1,4})$/.exec(arquivo);
		const zip = parte ? await zipDaParte(c.env, e, Number(parte[1])) : null;
		if (!zip || !parte) return negado();
		return c.body(zip, 200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${nomeDaParte(e, Number(parte[1]))}"` });
	});
}
