// Documentos auxiliares em PDF e o logotipo do emitente.
//
//   GET    /v1/nfe/:id/danfe      DANFE da NF-e, A4
//   GET    /v1/nfce/:id/danfce    DANFE NFC-e na largura da bobina (?largura=80|58, ?via=)
//   GET    /v1/cofre/logotipo     a imagem do logotipo, para o sistema do caixa imprimir no cupom
//   GET    /admin/logotipo        idem, para a tela /setup
//   PUT    /admin/logotipo        envia o logotipo (PNG ou JPEG, até 300 KB)
//   DELETE /admin/logotipo        remove o logotipo
//
// O PDF é gerado a cada pedido, a partir do XML arquivado: não fica guardado.
// O gerador de PDF só é carregado quando uma destas rotas é chamada.

import type { Context, Hono } from "hono";
import { autenticar, erro } from "./api-nfse";
import type { Ctx } from "./app";
import { CupomError, montarCupom } from "./danfe/cupom";
import * as banco from "./emissao/banco";
import { LogotipoError, lerLogotipo, removerLogotipo, salvarLogotipo } from "./logotipo";
import * as store from "./store";

type C = Context<Ctx>;

const pdf = (c: C, bytes: Uint8Array, nome: string) =>
	c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
		"content-type": "application/pdf",
		"content-disposition": `inline; filename="${nome}.pdf"`,
		"cache-control": "private, no-store",
	});

/** A emissão do modelo pedido e o XML arquivado dela, ou a resposta de erro. */
async function notaArquivada(c: C, doc: "nfe" | "nfce"): Promise<{ emission: banco.Emission; xml: string } | Response> {
	const chave = await autenticar(c);
	if (chave instanceof Response) return chave;
	const emission = await banco.getEmission(c.env.DB, c.req.param("id") ?? "");
	if (emission?.kind !== doc) return erro(c, 404, "nao_encontrado", "Emissão inexistente.");
	const objeto = emission.documentKey ? await store.getDocument(c.env.DOCS, emission.documentKey) : null;
	if (!objeto) {
		return erro(c, 409, "nfe_nao_autorizada", doc === "nfe" ? "Só há DANFE para nota autorizada." : "Só há DANFE NFC-e para nota autorizada ou emitida em contingência.");
	}
	return { emission, xml: await objeto.text() };
}

export function registrarApiDanfe(app: Hono<Ctx>) {
	app.get("/v1/nfe/:id/danfe", async (c) => {
		const nota = await notaArquivada(c, "nfe");
		if (nota instanceof Response) return nota;
		const { DanfeError, gerarDanfePdf } = await import("./danfe/danfe-pdf");
		try {
			const bytes = await gerarDanfePdf(nota.xml, { cancelada: nota.emission.status === "cancelada", logotipo: await lerLogotipo(c.env.DOCS) });
			return pdf(c, bytes, `danfe-${nota.emission.accessKey ?? nota.emission.id}`);
		} catch (err) {
			if (!(err instanceof DanfeError)) throw err;
			return erro(c, 409, "nfe_nao_autorizada", err.message);
		}
	});

	app.get("/v1/nfce/:id/danfce", async (c) => {
		const largura = c.req.query("largura") ?? "80";
		if (largura !== "80" && largura !== "58") return erro(c, 400, "requisicao_invalida", 'O parâmetro "largura" aceita 80 ou 58 (milímetros da bobina).');
		const via = c.req.query("via") ?? "consumidor";
		if (via !== "consumidor" && via !== "estabelecimento") return erro(c, 400, "requisicao_invalida", 'O parâmetro "via" aceita consumidor ou estabelecimento.');
		const nota = await notaArquivada(c, "nfce");
		if (nota instanceof Response) return nota;
		try {
			const cupom = montarCupom(nota.xml, { via });
			const { gerarDanfcePdf } = await import("./danfe/danfce-pdf");
			const bytes = await gerarDanfcePdf(cupom, { largura: largura === "58" ? 58 : 80, logotipo: await lerLogotipo(c.env.DOCS) });
			return pdf(c, bytes, `danfce-${cupom.chaveAcesso}`);
		} catch (err) {
			if (!(err instanceof CupomError)) throw err;
			return erro(c, 409, "nfe_nao_autorizada", err.message);
		}
	});

	// O mesmo PDF para a tela /setup, a partir do arquivo da nota listado em /admin/notas.
	app.get("/admin/notas/pdf", async (c) => {
		const recusar = (status: 400 | 404 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);
		const key = c.req.query("key") ?? "";
		const modelo = /^(nfe|nfce)\//.exec(key)?.[1];
		if (!store.isValidDocumentKey(key) || !modelo) return recusar(400, "chave_invalida", "Arquivo inválido.");
		const objeto = await store.getDocument(c.env.DOCS, key);
		if (!objeto) return recusar(404, "nao_encontrado", "Arquivo inexistente.");
		const xml = await objeto.text();
		const logotipo = await lerLogotipo(c.env.DOCS);
		const { DanfeError, gerarDanfePdf } = await import("./danfe/danfe-pdf");
		try {
			if (modelo === "nfe") return pdf(c, await gerarDanfePdf(xml, { cancelada: c.req.query("cancelada") === "1", logotipo }), "danfe");
			const { gerarDanfcePdf } = await import("./danfe/danfce-pdf");
			return pdf(c, await gerarDanfcePdf(montarCupom(xml), { largura: 80, logotipo }), "danfce");
		} catch (err) {
			if (!(err instanceof DanfeError) && !(err instanceof CupomError)) throw err;
			return recusar(409, "documento_sem_pdf", err.message);
		}
	});

	// ---------- Logotipo ----------

	const imagem = async (c: C) => {
		const logotipo = await lerLogotipo(c.env.DOCS);
		if (!logotipo) return null;
		return c.body(logotipo.bytes as Uint8Array<ArrayBuffer>, 200, { "content-type": logotipo.tipo, "cache-control": "private, no-store" });
	};

	app.get("/v1/cofre/logotipo", async (c) => {
		const chave = await autenticar(c);
		if (chave instanceof Response) return chave;
		return (await imagem(c)) ?? erro(c, 404, "nao_encontrado", "Este cofre não tem logotipo cadastrado.");
	});

	app.get("/admin/logotipo", async (c) => (await imagem(c)) ?? c.json({ error: { code: "nao_encontrado", message: "Nenhum logotipo cadastrado." } }, 404));

	app.put("/admin/logotipo", async (c) => {
		try {
			const salvo = await salvarLogotipo(c.env.DOCS, new Uint8Array(await c.req.arrayBuffer()));
			await store.audit(c.env.DB, { action: "logotipo.salvar", actor: "admin", outcome: "ok", detail: salvo });
			return c.json({ logotipo: salvo });
		} catch (err) {
			if (!(err instanceof LogotipoError)) throw err;
			return c.json({ error: { code: "requisicao_invalida", message: err.message } }, 400);
		}
	});

	app.delete("/admin/logotipo", async (c) => {
		await removerLogotipo(c.env.DOCS);
		await store.audit(c.env.DB, { action: "logotipo.remover", actor: "admin", outcome: "ok" });
		return c.json({ ok: true });
	});
}
