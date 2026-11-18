// Rotas do cofre.
//
//   /setup, /admin/*  -> o emitente, autenticado pelo VAULT_SECRET
//   /v1/nfse...       -> os sistemas do emitente, com chave de API (api-nfse.ts)
//
// O cofre é a API de emissão: guarda o certificado, monta e assina os
// documentos, fala com o governo e arquiva os XML. Não há serviço intermediário.

import { type Context, Hono } from "hono";
import { z } from "zod";
import { registrarApiDanfe } from "./api-danfe";
import { registrarApiNfe } from "./api-nfe";
import { cancelarPeloPainel, registrarApiNfse } from "./api-nfse";
import { registrarApiPainel } from "./api-painel";
import { registrarApiRecebidas } from "./api-recebidas";
import { registrarApiRelatorios } from "./api-relatorios";
import { registrarAtualizacao } from "./atualizacao";
import { isAdminSecret, secretIsStrong } from "./crypto";
import { PfxError, parsePfx } from "./pfx";
import { VAULT_VERSION } from "./protocol";
import { runSelfTest } from "./selftest";
import { SETUP_CSS, SETUP_HTML, SETUP_JS } from "./setup/page";
import * as store from "./store";
import type { Transport } from "./transport";

export interface AppEnv {
	DB: D1Database;
	DOCS: R2Bucket;
	VAULT_SECRET: string;
	/** Identificação da versão publicada no Cloudflare: muda a cada build, mesmo sem mudar a versão do cofre. */
	CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}

export type Ctx = { Bindings: AppEnv; Variables: { actor: string } };
type C = Context<Ctx>;
type Status = 400 | 401 | 404 | 409 | 413 | 422 | 500 | 503;

export interface AppDeps {
	/** Chamadas de saída que não vão ao governo (GitHub, Cloudflare). Trocado nos testes. */
	fetch?: typeof fetch;
}

// As mensagens de validação dos pedidos saem em português.
z.config(z.locales.ptBR());

const MAX_PFX_BYTES = 64 * 1024;

function fail(c: C, status: Status, code: string, message: string) {
	// A API dos sistemas clientes (/v1) responde sempre no formato do contrato.
	if (c.req.path.startsWith("/v1/")) return c.json({ erro: { codigo: code, mensagem: message } }, status);
	return c.json({ error: { code, message } }, status);
}

function parseJson<T>(body: ArrayBuffer): T | undefined {
	try {
		const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
		return value && typeof value === "object" ? (value as T) : undefined;
	} catch {
		return undefined;
	}
}

export function createApp(makeTransport: (env: AppEnv) => Transport, deps: AppDeps = {}) {
	const app = new Hono<Ctx>();
	const callFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));

	app.onError((err, c) => {
		console.error("erro não tratado:", err instanceof Error ? err.message : err);
		return fail(c, 500, "erro_interno", "Erro interno do cofre.");
	});
	app.notFound((c) => fail(c, 404, "nao_encontrado", "Rota inexistente."));

	app.use("*", async (c, next) => {
		await next();
		c.header("x-content-type-options", "nosniff");
		c.header("referrer-policy", "no-referrer");
		c.header("x-frame-options", "DENY");
		if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
	});

	// ---------- Público ----------

	app.get("/", (c) => c.redirect("/setup"));
	app.get("/health", (c) => c.json({ ok: true, version: VAULT_VERSION }));

	const CSP =
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
	app.get("/setup", (c) => {
		c.header("content-security-policy", CSP);
		return c.html(SETUP_HTML);
	});
	app.get("/setup/app.js", (c) => c.body(SETUP_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
	app.get("/setup/app.css", (c) => c.body(SETUP_CSS, 200, { "content-type": "text/css; charset=utf-8" }));

	// ---------- Segredo configurado? ----------

	const requireSecret = async (c: C, next: () => Promise<void>) => {
		if (!secretIsStrong(c.env.VAULT_SECRET)) {
			return fail(c, 503, "cofre_nao_configurado", "VAULT_SECRET ausente ou curto demais (mínimo de 32 caracteres).");
		}
		await next();
	};
	app.use("/admin/*", requireSecret);
	app.use("/v1/*", requireSecret);

	// ---------- Administração (emitente) ----------

	app.use("/admin/*", async (c, next) => {
		const header = c.req.header("authorization") ?? "";
		const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
		if (!provided || !(await isAdminSecret(provided, c.env.VAULT_SECRET))) {
			return fail(c, 401, "nao_autenticado", "Segredo do cofre incorreto.");
		}
		c.set("actor", "admin");
		await next();
	});

	app.get("/admin/status", async (c) => {
		const [certificate, allowProduction] = await Promise.all([
			store.getCertificateInfo(c.env.DB),
			store.getAllowProduction(c.env.DB),
		]);
		return c.json({ version: VAULT_VERSION, certificate, allowProduction });
	});

	app.post("/admin/certificate", async (c) => {
		const form = await c.req.formData().catch(() => null);
		const file = form?.get("pfx");
		const password = form?.get("password");
		if (!(file instanceof File) || typeof password !== "string") {
			return fail(c, 400, "requisicao_invalida", "Envie o arquivo .pfx e a senha.");
		}
		if (file.size === 0 || file.size > MAX_PFX_BYTES) {
			return fail(c, 413, "arquivo_invalido", "O arquivo .pfx está vazio ou é grande demais.");
		}
		try {
			const parsed = parsePfx(new Uint8Array(await file.arrayBuffer()), password);
			if (parsed.notAfter.getTime() < Date.now()) {
				return fail(c, 422, "certificado_vencido", "Este certificado já venceu.");
			}
			const info = await store.saveCertificate(c.env.DB, c.env.VAULT_SECRET, parsed);
			await store.audit(c.env.DB, {
				action: "certificado.instalar",
				actor: "admin",
				outcome: "ok",
				detail: { holder: info.holder.id, notAfter: info.notAfter },
			});
			return c.json({ certificate: info });
		} catch (err) {
			if (err instanceof PfxError) return fail(c, 422, err.code, err.message);
			throw err;
		}
	});

	app.delete("/admin/certificate", async (c) => {
		await store.deleteCertificate(c.env.DB);
		await store.audit(c.env.DB, { action: "certificado.remover", actor: "admin", outcome: "ok" });
		return c.json({ ok: true });
	});

	app.put("/admin/settings", async (c) => {
		const input = parseJson<{ allowProduction?: unknown }>(await c.req.arrayBuffer());
		if (typeof input?.allowProduction !== "boolean") {
			return fail(c, 400, "requisicao_invalida", "Informe allowProduction (true ou false).");
		}
		await store.setAllowProduction(c.env.DB, input.allowProduction);
		await store.audit(c.env.DB, {
			action: "producao.alterar",
			actor: "admin",
			outcome: "ok",
			detail: { allowProduction: input.allowProduction },
		});
		return c.json({ allowProduction: input.allowProduction });
	});

	app.post("/admin/selftest", async (c) => {
		const cert = await store.loadCertificate(c.env.DB, c.env.VAULT_SECRET);
		if (!cert) return fail(c, 409, "certificado_ausente", "Instale o certificado antes de testar.");
		const results = await runSelfTest(makeTransport(c.env), cert.secrets);
		await store.audit(c.env.DB, {
			action: "autoteste",
			actor: "admin",
			outcome: results.every((r) => r.ok) ? "ok" : "falha",
			detail: { results: results.map((r) => ({ host: r.host, ok: r.ok })) },
		});
		return c.json({ results });
	});

	// ---------- Notas emitidas (painel do emitente) ----------

	app.get("/admin/notas", async (c) => c.json({ notas: await store.listNotas(c.env.DB) }));

	// Download de um arquivo da nota (XML da NFS-e, da DPS ou do evento).
	app.get("/admin/notas/arquivo", async (c) => {
		const key = c.req.query("key") ?? "";
		if (!store.isValidDocumentKey(key) || !/^(nfse|nfe|nfce)\//.test(key)) {
			return fail(c, 400, "chave_invalida", "Arquivo inválido.");
		}
		const object = await store.getDocument(c.env.DOCS, key);
		if (!object) return fail(c, 404, "nao_encontrado", "Arquivo inexistente.");
		const nome = (key.split("/").pop() ?? "arquivo.xml").replace(/[^A-Za-z0-9._-]/g, "_");
		return c.body(object.body, 200, {
			"content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"content-disposition": `attachment; filename="${nome}"`,
		});
	});

	app.post("/admin/notas/cancelar", async (c) => {
		const input = parseJson<{ chaveAcesso?: unknown }>(await c.req.arrayBuffer());
		if (typeof input?.chaveAcesso !== "string") {
			return fail(c, 400, "requisicao_invalida", "Informe a chave de acesso, o motivo e a justificativa.");
		}
		const resposta = await cancelarPeloPainel(c, makeTransport(c.env), input.chaveAcesso, input);
		return (
			resposta ??
			fail(c, 404, "nao_encontrado", "Esta nota não foi emitida por este cofre. Cancele-a pelo portal nacional.")
		);
	});

	app.get("/admin/audit", async (c) => {
		const limit = Number(c.req.query("limit") ?? 50);
		return c.json({ entries: await store.listAudit(c.env.DB, Number.isFinite(limit) ? limit : 50) });
	});

	registrarAtualizacao(app, callFetch);
	registrarApiNfse(app, makeTransport);
	registrarApiNfe(app, makeTransport, callFetch);
	registrarApiDanfe(app);
	registrarApiRecebidas(app, makeTransport);
	registrarApiPainel(app);
	registrarApiRelatorios(app);

	return app;
}
