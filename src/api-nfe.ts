// API de NF-e (modelo 55) e NFC-e (modelo 65) do cofre, com o mesmo desenho
// das rotas de NFS-e. {doc} é "nfe" ou "nfce".
//
//   POST /v1/{doc}                     emite
//   GET  /v1/{doc}                     lista (?referencia= pesquisa pela referência do cliente)
//   GET  /v1/{doc}/:id                 consulta o registro do cofre
//   POST /v1/{doc}/:id/consultar       consulta a SEFAZ e fecha uma emissão sem resposta
//   GET  /v1/{doc}/:id/xml             XML autorizado (nfeProc)
//   POST /v1/{doc}/:id/cancelar        cancela
//   POST /v1/nfe/:id/carta-correcao    carta de correção (só NF-e)
//   POST /v1/inutilizacoes             inutiliza uma faixa de numeração
//   GET  /v1/series                    séries cadastradas e o próximo número de cada uma
//   GET  /v1/cofre                     versão, atualização pendente, certificado e ambiente
//   GET  /v1/sefaz/status              status do serviço de autorização da UF
//
// O contrato completo está em docs/openapi.yaml.

import type { Context, Hono } from "hono";
import { z } from "zod";
import { executarAgendado } from "./agendador";
import { ambienteDoFiltro, autenticar, erro, iso, operacoes, problema } from "./api-nfse";
import type { AppEnv, Ctx } from "./app";
import { estadoDaAtualizacao } from "./atualizacao";
import { contratoOpenApi } from "./contrato";
import { CupomError, montarCupom } from "./danfe/cupom";
import * as banco from "./emissao/banco";
import { MODELO, cancelarNfe, corrigirNfe, emitirNfe, inutilizarNumeracao, sincronizarNfe, statusSefaz } from "./emissao/nfe";
import { autorizadorNfe, ufsAtendidas } from "./fiscal/dados";
import { temLogotipo } from "./logotipo";
import { CancelamentoNfe, CartaCorrecao, InutilizacaoInput, NfceInput, NfeInput, type PedidoNfe, UFS } from "./nfe/schema";
import * as store from "./store";
import type { Transport } from "./transport";

type C = Context<Ctx>;
type Doc = "nfe" | "nfce";

const AmbienteInput = z.enum(["homologacao", "producao"]);
const Cabecalho = z.object({
	ambiente: AmbienteInput.default("homologacao"),
	/** Identificador do pedido no sistema cliente: repetir a referência nunca gera duas notas. */
	referencia: z
		.string()
		.regex(/^[A-Za-z0-9._:-]{1,80}$/, "referencia: letras, números e . _ : - (até 80)")
		.optional(),
});

/** Dados da emissão em contingência offline; null quando a nota saiu pelo caminho normal. */
function contingenciaJson(e: banco.Emission) {
	const c = e.extra.contingencia as { desde?: string; motivo?: string; tentativas?: number; ultimaTentativa?: string } | undefined;
	if (!c) return null;
	const substituida = e.extra.substituida as { chave?: string } | undefined;
	const original = e.extra.original as { chave?: string; falha?: string } | undefined;
	return {
		/** A nota ainda aguarda a transmissão à SEFAZ? */
		pendente: e.status === "contingencia",
		desde: c.desde ?? null,
		motivo: c.motivo ?? null,
		tentativasDeTransmissao: c.tentativas ?? 0,
		ultimaTentativa: c.ultimaTentativa ?? null,
		/** Nota normal da mesma venda que ficou sem resposta e ainda será conferida. */
		notaNormalEmConferencia: original?.chave ?? null,
		/** Preenchido quando a conferência falhou e precisa de ação do emitente. */
		falhaNaConferencia: original?.falha ?? null,
		/** Nota normal que acabou autorizada e foi cancelada por substituição. */
		notaNormalCancelada: substituida?.chave ?? null,
	};
}

/** Na NFC-e, o pedido pode dizer o que fazer quando a SEFAZ não responde. */
const OpcoesNfce = z.object({ contingencia: z.enum(["nunca", "automatica", "forcada"]).default("nunca") });

export const nfeJson = (e: banco.Emission) => ({
	id: e.id,
	modelo: e.kind,
	ambiente: e.environment,
	referencia: e.reference,
	serie: Number(e.serie),
	numero: e.number,
	situacao: e.status,
	chaveAcesso: e.accessKey,
	protocolo: e.protocol,
	/** Data de emissão que está no XML (dhEmi) e data em que a SEFAZ autorizou (dhRecbto). */
	emitidaEm: typeof e.extra.emitidaEm === "string" ? e.extra.emitidaEm : null,
	autorizadaEm: typeof e.extra.autorizadaEm === "string" ? e.extra.autorizadaEm : null,
	valor: typeof e.extra.valor === "number" ? e.extra.valor : null,
	qrCode: typeof e.extra.qrCode === "string" ? e.extra.qrCode : null,
	urlConsulta: typeof e.extra.urlConsulta === "string" ? e.extra.urlConsulta : null,
	cartasCorrecao: typeof e.extra.cartas === "number" ? e.extra.cartas : 0,
	contingencia: contingenciaJson(e),
	/** Código e motivo devolvidos pela SEFAZ (cStat e xMotivo), ou o erro do cofre. */
	mensagens: e.messages,
	xmlDisponivel: e.documentKey !== null,
	criadaEm: iso(e.createdAt),
	atualizadaEm: iso(e.updatedAt),
});

const inutilizacaoJson = (i: banco.Inutilizacao) => ({
	id: i.id,
	modelo: i.kind,
	ambiente: i.environment,
	serie: Number(i.serie),
	numeroInicial: i.firstNumber,
	numeroFinal: i.lastNumber,
	protocolo: i.protocol,
	justificativa: i.justification,
	xmlDisponivel: i.documentKey !== null,
	criadaEm: iso(i.createdAt),
});

const serieJson = (s: banco.Serie) => ({
	modelo: s.kind,
	ambiente: s.environment,
	serie: Number(s.serie),
	proximoNumero: s.lastNumber + 1,
	descricao: s.label,
	cnpj: s.docId,
});

export function registrarApiNfe(app: Hono<Ctx>, makeTransport: (env: AppEnv) => Transport, callFetch: typeof fetch) {
	const somenteHomologacao = (c: C) => erro(c, 403, "chave_somente_homologacao", "Esta chave de API só opera em homologação.");

	// O contrato desta versão do cofre. É público: descreve a API, não contém dado do emitente.
	app.get("/v1/openapi.json", (c) => {
		c.header("cache-control", "public, max-age=300");
		return c.json(contratoOpenApi());
	});

	for (const doc of ["nfe", "nfce"] as const satisfies readonly Doc[]) {
		const base = `/v1/${doc}`;
		const Pedido = doc === "nfe" ? NfeInput : NfceInput;

		/** A emissão pedida, se for deste modelo. */
		const buscar = async (c: C) => {
			const emission = await banco.getEmission(c.env.DB, c.req.param("id") ?? "");
			return emission?.kind === doc ? emission : null;
		};
		const inexistente = (c: C) => erro(c, 404, "nao_encontrado", "Emissão inexistente.");

		app.post(base, async (c) => {
			const chave = await autenticar(c);
			if (chave instanceof Response) return chave;
			const corpo = await c.req.json().catch(() => null);
			const cabecalho = Cabecalho.safeParse(corpo);
			if (!cabecalho.success) return erro(c, 400, "requisicao_invalida", problema(cabecalho.error));
			const pedido = Pedido.safeParse(corpo);
			if (!pedido.success) return erro(c, 400, "requisicao_invalida", problema(pedido.error), { campo: pedido.error.issues[0]?.path.join(".") ?? null });
			const { ambiente, referencia } = cabecalho.data;
			if (chave.scope === "homologacao" && ambiente !== "homologacao") return somenteHomologacao(c);
			const opcoes = doc === "nfce" ? OpcoesNfce.safeParse(corpo) : null;
			if (opcoes && !opcoes.success) return erro(c, 400, "requisicao_invalida", problema(opcoes.error), { campo: "contingencia" });

			const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
			if (ops instanceof Response) return ops;
			const r = await emitirNfe(c.env.DB, ops, {
				ambiente,
				referencia,
				pedido: { ...pedido.data, modelo: MODELO[doc] } as PedidoNfe,
				contingencia: opcoes?.data?.contingencia,
			});
			switch (r.tipo) {
				case "autorizada":
				// Em contingência a nota vale para o consumidor (situacao "contingencia") e segue na fila.
				case "contingencia":
					return c.json(nfeJson(r.emission), r.nova ? 201 : 200);
				case "conflito":
					return erro(c, r.status, r.codigo, r.mensagem);
				case "nao_autorizada":
					return erro(c, r.status, r.codigo, r.mensagem, { [doc]: nfeJson(r.emission) });
			}
		});

		app.get(base, async (c) => {
			const chave = await autenticar(c);
			if (chave instanceof Response) return chave;
			const limite = Number(c.req.query("limite") ?? 50);
			const ambiente = ambienteDoFiltro(c);
			if (ambiente === null) return erro(c, 400, "requisicao_invalida", 'O filtro "ambiente" aceita homologacao ou producao.');
			const lista = await banco.listEmissions(c.env.DB, Number.isFinite(limite) ? limite : 50, {
				kind: doc,
				reference: c.req.query("referencia") || undefined,
				environment: ambiente,
			});
			return c.json({ [doc]: lista.map(nfeJson) });
		});

		app.get(`${base}/:id`, async (c) => {
			const chave = await autenticar(c);
			if (chave instanceof Response) return chave;
			const emission = await buscar(c);
			return emission ? c.json(nfeJson(emission)) : inexistente(c);
		});

		app.post(`${base}/:id/consultar`, async (c) => {
			const chave = await autenticar(c);
			if (chave instanceof Response) return chave;
			const emission = await buscar(c);
			if (!emission) return inexistente(c);
			if (emission.status !== "indefinida" && emission.status !== "contingencia") return c.json(nfeJson(emission));
			const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
			if (ops instanceof Response) return ops;
			return c.json(nfeJson(await sincronizarNfe(c.env.DB, ops, emission)));
		});

		app.get(`${base}/:id/xml`, async (c) => {
			const chave = await autenticar(c);
			if (chave instanceof Response) return chave;
			const emission = await buscar(c);
			if (!emission?.documentKey) return erro(c, 404, "nao_encontrado", "XML indisponível para esta emissão.");
			const object = await store.getDocument(c.env.DOCS, emission.documentKey);
			if (!object) return erro(c, 404, "nao_encontrado", "O XML não está mais no cofre.");
			return c.body(object.body, 200, { "content-type": "application/xml; charset=utf-8" });
		});

		const evento = (rota: string, Entrada: typeof CancelamentoNfe | typeof CartaCorrecao, executar: typeof cancelarNfe | typeof corrigirNfe) =>
			app.post(`${base}/:id/${rota}`, async (c) => {
				const chave = await autenticar(c);
				if (chave instanceof Response) return chave;
				const input = Entrada.safeParse(await c.req.json().catch(() => null));
				if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
				const emission = await buscar(c);
				if (!emission) return inexistente(c);
				if (chave.scope === "homologacao" && emission.environment !== "homologacao") return somenteHomologacao(c);
				const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
				if (ops instanceof Response) return ops;
				const r = await executar(c.env.DB, ops, emission, input.data as never);
				if (!r.ok) return erro(c, r.status, r.codigo, r.mensagem, { mensagens: r.mensagens });
				// `repetido`: o evento já estava registrado e nada novo foi enviado à SEFAZ.
				return c.json({ ...nfeJson(r.emission), repetido: r.repetido });
			});
		evento("cancelar", CancelamentoNfe, cancelarNfe);
		if (doc === "nfe") evento("carta-correcao", CartaCorrecao, corrigirNfe);

		/** XML de um evento arquivado ao lado da nota (procEventoNFe). */
		const xmlDoEvento = async (c: C, sufixo: string) => {
			const chave = await autenticar(c);
			if (chave instanceof Response) return chave;
			const emission = await buscar(c);
			const object = emission?.documentKey ? await store.getDocument(c.env.DOCS, emission.documentKey.replace(/-nfe\.xml$/, `-${sufixo}.xml`)) : null;
			if (!object) return erro(c, 404, "nao_encontrado", "Este evento não está arquivado no cofre.");
			return c.body(object.body, 200, { "content-type": "application/xml; charset=utf-8" });
		};
		app.get(`${base}/:id/cancelamento/xml`, (c) => xmlDoEvento(c, "cancelamento"));

		// Conteúdo do DANFE NFC-e em JSON, para o caixa imprimir na bobina.
		if (doc === "nfce") {
			app.get(`${base}/:id/cupom`, async (c) => {
				const chave = await autenticar(c);
				if (chave instanceof Response) return chave;
				const emission = await buscar(c);
				if (!emission) return inexistente(c);
				const object = emission.documentKey ? await store.getDocument(c.env.DOCS, emission.documentKey) : null;
				if (!object) return erro(c, 409, "nfe_nao_autorizada", "Só há cupom para nota autorizada ou emitida em contingência.");
				const via = c.req.query("via");
				if (via && via !== "consumidor" && via !== "estabelecimento") {
					return erro(c, 400, "requisicao_invalida", 'O parâmetro "via" aceita consumidor ou estabelecimento.');
				}
				try {
					const cupom = montarCupom(await object.text(), { via: via === "estabelecimento" ? "estabelecimento" : "consumidor" });
					return c.json({ id: emission.id, situacao: emission.status, ...cupom });
				} catch (err) {
					if (!(err instanceof CupomError)) throw err;
					return erro(c, 409, "nfe_nao_autorizada", err.message);
				}
			});
		}
		if (doc === "nfe") {
			app.get(`${base}/:id/carta-correcao/:sequencia/xml`, async (c) => {
				const sequencia = Number(c.req.param("sequencia"));
				if (!Number.isInteger(sequencia) || sequencia < 1 || sequencia > 20) return erro(c, 404, "nao_encontrado", "Carta de correção inexistente.");
				return xmlDoEvento(c, `cce-${String(sequencia).padStart(2, "0")}`);
			});
		}
	}

	app.post("/v1/inutilizacoes", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = InutilizacaoInput.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		if (chave.scope === "homologacao" && input.data.ambiente !== "homologacao") return somenteHomologacao(c);
		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		const r = await inutilizarNumeracao(c.env.DB, ops, input.data);
		if (!r.ok) return erro(c, r.status, r.codigo, r.mensagem, { mensagens: r.mensagens });
		// 200 quando a faixa já estava inutilizada (repetir o pedido é seguro).
		const corpo = { ...inutilizacaoJson(r.inutilizacao), repetido: r.repetida };
		return r.repetida ? c.json(corpo, 200) : c.json(corpo, 201);
	});

	app.get("/v1/inutilizacoes", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const ambiente = ambienteDoFiltro(c);
		if (ambiente === null) return erro(c, 400, "requisicao_invalida", 'O filtro "ambiente" aceita homologacao ou producao.');
		const modelo = c.req.query("modelo");
		const serie = c.req.query("serie");
		const lista = (await banco.listInutilizacoes(c.env.DB)).filter(
			(i) => (!ambiente || i.environment === ambiente) && (!modelo || i.kind === modelo) && (!serie || i.serie === String(Number(serie))),
		);
		return c.json({ inutilizacoes: lista.map(inutilizacaoJson) });
	});

	app.get("/v1/inutilizacoes/:id", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const i = await banco.getInutilizacao(c.env.DB, c.req.param("id"));
		return i ? c.json(inutilizacaoJson(i)) : erro(c, 404, "nao_encontrado", "Inutilização inexistente.");
	});

	app.get("/v1/inutilizacoes/:id/xml", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const i = await banco.getInutilizacao(c.env.DB, c.req.param("id"));
		const object = i?.documentKey ? await store.getDocument(c.env.DOCS, i.documentKey) : null;
		if (!object) return erro(c, 404, "nao_encontrado", "XML indisponível para esta inutilização.");
		return c.body(object.body, 200, { "content-type": "application/xml; charset=utf-8" });
	});

	app.get("/v1/series", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const cert = await store.getCertificateInfo(c.env.DB);
		return c.json({ series: cert ? (await listarSeries(c.env.DB, cert.holder.id)).map(serieJson) : [] });
	});

	// Estado do cofre para o sistema cliente mostrar no painel dele. Nunca inclui chaves nem segredos.
	app.get("/v1/cofre", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const [cert, producaoLiberada, atualizacao] = await Promise.all([
			store.getCertificateInfo(c.env.DB),
			store.getAllowProduction(c.env.DB),
			estadoDaAtualizacao(c, callFetch),
		]);
		return c.json({
			versao: atualizacao.instalada,
			atualizacao: { versaoPublicada: atualizacao.publicada, pendente: atualizacao.haAtualizacao },
			certificado: cert
				? {
						titular: cert.commonName,
						documento: cert.holder,
						validoAte: cert.notAfter,
						diasRestantes: Math.floor((Date.parse(cert.notAfter) - Date.now()) / 86_400_000),
					}
				: null,
			producaoLiberada,
			chave: { escopo: chave.scope, ambientes: chave.scope === "homologacao" || !producaoLiberada ? ["homologacao"] : ["homologacao", "producao"] },
			documentos: { nfse: true, nfe: { ufs: ufsAtendidas("55") }, nfce: { ufs: ufsAtendidas("65") } },
			contingencia: { notasPendentes: await banco.contarEmContingencia(c.env.DB) },
			/** Há logotipo cadastrado? A imagem sai em GET /v1/cofre/logotipo. */
			logotipo: await temLogotipo(c.env.DOCS),
		});
	});

	app.get("/v1/sefaz/status", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		const input = z
			.object({ modelo: z.enum(["nfe", "nfce"]).default("nfe"), uf: z.enum(UFS), ambiente: AmbienteInput.default("homologacao") })
			.safeParse({ modelo: c.req.query("modelo"), uf: c.req.query("uf"), ambiente: c.req.query("ambiente") });
		if (!input.success) return erro(c, 400, "requisicao_invalida", problema(input.error));
		const { modelo, uf, ambiente } = input.data;
		if (!autorizadorNfe(MODELO[modelo], uf, ambiente)) return erro(c, 422, "uf_nao_suportada", `A UF ${uf} ainda não está disponível neste cofre.`);
		const ops = await operacoes(c, makeTransport(c.env), `chave:${chave.id}`);
		if (ops instanceof Response) return ops;
		try {
			const status = await statusSefaz(ops, MODELO[modelo], uf, ambiente);
			return c.json({ modelo, uf, ambiente, ...status });
		} catch (err) {
			return c.json({ modelo, uf, ambiente, emOperacao: false, mensagem: { codigo: "sem_conexao", descricao: err instanceof Error ? err.message : String(err) }, tempoMedioSegundos: null });
		}
	});

	// ---------- Configuração do emitente (tela /setup) ----------

	// Roda agora o trabalho que o agendador faz a cada 5 minutos: confere a SEFAZ e transmite a fila.
	app.post("/admin/contingencia/processar", async (c) => {
		const resumo = await executarAgendado(c.env, makeTransport(c.env));
		return c.json({ resumo: resumo?.contingencia ?? { autorizadas: 0, rejeitadas: 0, aguardando: 0 }, notasPendentes: await banco.contarEmContingencia(c.env.DB) });
	});

	app.get("/admin/series", async (c) => {
		const cert = await store.getCertificateInfo(c.env.DB);
		return c.json({ series: cert ? (await listarSeries(c.env.DB, cert.holder.id)).map(serieJson) : [] });
	});

	app.put("/admin/series", async (c) => {
		const input = z
			.object({
				modelo: z.enum(["nfe", "nfce"]),
				ambiente: AmbienteInput,
				serie: z.number().int().min(0).max(889),
				/** Número da próxima nota; informe quando a empresa já emitiu por outro sistema. */
				proximoNumero: z.number().int().min(1).max(999_999_999).optional(),
				descricao: z.string().trim().max(60).optional(),
				/** CNPJ da filial dona da série; padrão: o titular do certificado. */
				cnpj: z.string().regex(/^[0-9A-Z]{12}\d{2}$/).optional(),
			})
			.safeParse(await c.req.json().catch(() => null));
		const recusar = (status: 400 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);
		if (!input.success) return recusar(400, "requisicao_invalida", problema(input.error));
		const cert = await store.getCertificateInfo(c.env.DB);
		if (!cert) return recusar(409, "certificado_ausente", "Instale o certificado antes de cadastrar séries.");
		const cnpj = input.data.cnpj ?? cert.holder.id;
		if (cert.holder.kind !== "cnpj" || cnpj.slice(0, 8) !== cert.holder.id.slice(0, 8)) {
			return recusar(400, "emitente_divergente", "A série precisa ser do titular do certificado (CNPJ) ou de uma filial de mesma raiz.");
		}
		const chaveSerie = { docId: cnpj, kind: input.data.modelo, environment: input.data.ambiente, serie: String(input.data.serie) };
		const salva = await banco.salvarSerie(c.env.DB, chaveSerie, {
			proximoNumero: input.data.proximoNumero,
			label: input.data.descricao === undefined ? undefined : input.data.descricao || null,
		});
		if (!salva) {
			const usado = await banco.maiorNumeroEmUso(c.env.DB, chaveSerie);
			return recusar(409, "numero_ja_utilizado", `Esta série já tem o número ${usado} em uso neste cofre: o próximo número precisa ser maior.`);
		}
		await store.audit(c.env.DB, { action: "serie.salvar", actor: "admin", outcome: "ok", detail: { ...serieJson(salva) } });
		return c.json({ serie: serieJson(salva) });
	});

}

/** Séries de NF-e e NFC-e do titular e das filiais de mesma raiz. */
async function listarSeries(db: D1Database, titular: string): Promise<banco.Serie[]> {
	return (await banco.listSeriesDaRaiz(db, titular.slice(0, 8))).filter((s) => s.kind !== "nfse");
}
