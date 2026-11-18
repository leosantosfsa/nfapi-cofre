// Atualização do cofre pelo botão "Atualizar" da tela /setup.
//
// O cofre roda a partir de um repositório Git do próprio emitente, publicado
// pelo Cloudflare (Workers Builds). Atualizar significa disparar um novo build:
// durante o build, tools/atualizar.mjs busca a versão publicada pelo NFapi e a
// instala. O disparo usa um "Deploy Hook", uma URL secreta que o emitente cria
// uma vez no painel do Cloudflare e guarda aqui (cifrada).

import type { Context, Hono } from "hono";
import type { Ctx } from "./app";
import { decryptJson, encryptJson } from "./crypto";
import { VAULT_VERSION } from "./protocol";
import * as store from "./store";

/** De onde vêm as versões publicadas. */
export const CANAL = { repo: "Quevenapp/nfapi", ref: "cofre-estavel", dir: "vault" } as const;

const HOOK_RE = /^https:\/\/api\.cloudflare\.com\/client\/v4\/workers\/builds\/deploy_hooks\/[A-Za-z0-9_-]{8,128}$/;
const CACHE_MS = 10 * 60 * 1000;

type C = Context<Ctx>;
const fail = (c: C, status: 400 | 409 | 502, code: string, message: string) =>
	c.json({ error: { code, message } }, status);

/** Compara versões "x.y.z". Positivo quando `a` é mais nova que `b`. */
export function compararVersoes(a: string, b: string): number {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Versão publicada no canal estável (com cache curto no D1). */
async function versaoPublicada(c: C, callFetch: typeof fetch, forcar: boolean): Promise<string | null> {
	const cache = await store.getSetting(c.env.DB, "versao_publicada");
	if (cache && !forcar) {
		const { versao, em } = JSON.parse(cache) as { versao: string; em: number };
		if (Date.now() - em < CACHE_MS) return versao;
	}
	try {
		const url = `https://raw.githubusercontent.com/${CANAL.repo}/${CANAL.ref}/${CANAL.dir}/package.json`;
		const res = await callFetch(url, { headers: { accept: "application/json" } });
		if (!res.ok) return null;
		const versao = ((await res.json()) as { version?: unknown }).version;
		if (typeof versao !== "string" || !/^\d+\.\d+\.\d+$/.test(versao)) return null;
		await store.setSetting(c.env.DB, "versao_publicada", JSON.stringify({ versao, em: Date.now() }));
		return versao;
	} catch {
		return null;
	}
}

async function lerGatilho(c: C): Promise<string | null> {
	const guardado = await store.getSetting(c.env.DB, "gatilho_de_build");
	if (!guardado) return null;
	try {
		const { iv, ciphertext } = JSON.parse(guardado) as { iv: string; ciphertext: string };
		return (await decryptJson<{ url: string }>(c.env.VAULT_SECRET, iv, ciphertext)).url;
	} catch {
		return null;
	}
}

/** Versão instalada, versão publicada e se há atualização a instalar. */
export async function estadoDaAtualizacao(c: C, callFetch: typeof fetch, forcar = false) {
	const publicada = await versaoPublicada(c, callFetch, forcar);
	return {
		instalada: VAULT_VERSION,
		publicada,
		haAtualizacao: publicada ? compararVersoes(publicada, VAULT_VERSION) > 0 : false,
	};
}

// ---------- Andamento da atualização pedida ----------

/** Depois disso sem a versão nova no ar, o painel avisa que o build está demorando. */
const DEMORA_MS = 10 * 60 * 1000;
/** Depois disso o cofre esquece a atualização pedida. */
const VALIDADE_MS = 60 * 60 * 1000;

interface Pedido {
	/** Versão e build que estavam no ar quando o gatilho foi disparado. */
	de: string;
	implantacao: string | null;
	/** Versão publicada no canal naquele momento, quando era mais nova. */
	para: string | null;
	em: number;
	concluidaEm?: number;
}

/** Identificação do build que está respondendo (nula fora do Cloudflare). */
const implantacaoAtual = (c: C): string | null => c.env.CF_VERSION_METADATA?.id || null;

/**
 * Em que pé está a atualização pedida pelo botão. O cofre não enxerga o build
 * do Cloudflare: ele sabe que terminou quando quem responde já é outra versão
 * (ou outro build da mesma versão).
 */
async function andamentoDaAtualizacao(c: C, agora = Date.now()) {
	const guardado = await store.getSetting(c.env.DB, "atualizacao_pedida");
	if (!guardado) return null;
	let p: Pedido;
	try {
		p = JSON.parse(guardado) as Pedido;
	} catch {
		return null;
	}
	if (agora - p.em > VALIDADE_MS) return null;
	const atual = implantacaoAtual(c);
	const noAr = VAULT_VERSION !== p.de || (p.implantacao !== null && atual !== null && atual !== p.implantacao);
	if (noAr && !p.concluidaEm) {
		p.concluidaEm = agora;
		await store.setSetting(c.env.DB, "atualizacao_pedida", JSON.stringify(p));
	}
	return {
		situacao: noAr ? ("concluida" as const) : agora - p.em > DEMORA_MS ? ("demorando" as const) : ("em_andamento" as const),
		de: p.de,
		para: noAr ? VAULT_VERSION : p.para,
		iniciadaEm: new Date(p.em).toISOString(),
		concluidaEm: p.concluidaEm ? new Date(p.concluidaEm).toISOString() : null,
	};
}

export function registrarAtualizacao(app: Hono<Ctx>, callFetch: typeof fetch) {
	app.get("/admin/atualizacao", async (c) => {
		return c.json({
			...(await estadoDaAtualizacao(c, callFetch, c.req.query("verificar") === "1")),
			gatilhoConfigurado: (await lerGatilho(c)) !== null,
			canal: `${CANAL.repo}@${CANAL.ref}`,
			/** Build que respondeu: a página aberta compara com o que ela carregou para saber se ficou velha. */
			implantacao: implantacaoAtual(c),
			andamento: await andamentoDaAtualizacao(c),
		});
	});

	// A URL do gatilho é uma credencial: quem a tem dispara builds. Fica cifrada.
	app.put("/admin/atualizacao/gatilho", async (c) => {
		const input = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
		const url = typeof input?.url === "string" ? input.url.trim() : "";
		if (!HOOK_RE.test(url)) {
			return fail(c, 400, "gatilho_invalido", "Cole a URL do gancho de implantação (Deploy Hook) criada no painel do Cloudflare, em Configurações > Compilações.");
		}
		await store.setSetting(c.env.DB, "gatilho_de_build", JSON.stringify(await encryptJson(c.env.VAULT_SECRET, { url })));
		await store.audit(c.env.DB, { action: "atualizacao.gatilho", actor: "admin", outcome: "ok" });
		return c.json({ gatilhoConfigurado: true });
	});

	app.post("/admin/atualizacao", async (c) => {
		const gatilho = await lerGatilho(c);
		if (!gatilho) {
			return fail(c, 409, "gatilho_ausente", "Configure o gancho de implantação (Deploy Hook) antes de atualizar.");
		}
		let res: Response;
		try {
			res = await callFetch(gatilho, { method: "POST" });
		} catch (err) {
			return fail(c, 502, "cloudflare_inacessivel", `Não foi possível disparar o build: ${err instanceof Error ? err.message : String(err)}`);
		}
		await store.audit(c.env.DB, {
			action: "atualizacao.disparar",
			actor: "admin",
			outcome: res.ok ? "ok" : `http_${res.status}`,
			detail: { de: VAULT_VERSION },
		});
		if (!res.ok) {
			return fail(c, 502, "gatilho_recusado", `O Cloudflare recusou o gatilho (HTTP ${res.status}). Confira se o gancho de implantação ainda existe.`);
		}
		const { publicada, haAtualizacao } = await estadoDaAtualizacao(c, callFetch);
		const pedido: Pedido = { de: VAULT_VERSION, implantacao: implantacaoAtual(c), para: haAtualizacao ? publicada : null, em: Date.now() };
		await store.setSetting(c.env.DB, "atualizacao_pedida", JSON.stringify(pedido));
		return c.json({
			ok: true,
			mensagem: "Build iniciado. A nova versão entra no ar em um a três minutos.",
			andamento: await andamentoDaAtualizacao(c),
		});
	});
}
