import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { compararVersoes } from "../src/atualizacao";
import { OperacaoError, abrirOperacoes } from "../src/operacoes";
import { type TransmitRequest, VAULT_VERSION } from "../src/protocol";
import type { CertificateSecrets } from "../src/store";
import type { Transport, TransportResult } from "../src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "./helpers";

const ORIGIN = "https://cofre.exemplo.workers.dev";
type Json = Record<string, any>;

/** Transporte simulado: registra o que recebeu e devolve uma resposta fixa. */
class FakeTransport implements Transport {
	calls: { request: TransmitRequest; cert: CertificateSecrets }[] = [];
	async transmit(request: TransmitRequest, cert: CertificateSecrets): Promise<TransportResult> {
		this.calls.push({ request, cert });
		return {
			status: 200,
			headers: { "content-type": "application/soap+xml" },
			bodyB64: btoa("<retorno><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retorno>"),
			tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" },
			ms: 12,
		};
	}
}

let transport: FakeTransport;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
	transport = new FakeTransport();
	app = createApp(() => transport);
	// O D1 local persiste entre os testes do arquivo: cada caso começa do zero.
	await env.DB.batch(
		["emissions", "series", "api_keys", "certificate", "settings", "audit", "documents"].map((t) =>
			env.DB.prepare(`DELETE FROM ${t}`),
		),
	);
});

const comSegredo = (init: RequestInit = {}): RequestInit => ({
	...init,
	headers: { ...init.headers, authorization: `Bearer ${env.VAULT_SECRET}` },
});
const admin = (path: string, init: RequestInit = {}) => app.request(ORIGIN + path, comSegredo(init), env);

async function instalarCertificado(senha = SENHA_TESTE) {
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", senha);
	return admin("/admin/certificate", { method: "POST", body: form });
}

/** Código do erro: o painel (/admin) responde `error.code`; a API dos clientes (/v1), `erro.codigo`. */
const erro = async (res: Response) => {
	const corpo = (await res.json()) as { error?: { code: string }; erro?: { codigo: string } };
	return corpo.error?.code ?? corpo.erro?.codigo;
};

const NFE = (tpAmb: 1 | 2, cnpj = CNPJ_TESTE) =>
	`<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe35261111222333000181550010000000011000000015" versao="4.00">` +
	`<ide><cUF>35</cUF><tpAmb>${tpAmb}</tpAmb></ide><emit><CNPJ>${cnpj}</CNPJ></emit></infNFe></NFe>`;

describe("acesso", () => {
	it("expõe só o mínimo sem autenticação", async () => {
		const health = await app.request(`${ORIGIN}/health`, {}, env);
		expect(await health.json()).toEqual({ ok: true, version: VAULT_VERSION });
		expect(VAULT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

		const setup = await app.request(`${ORIGIN}/setup`, {}, env);
		expect(setup.status).toBe(200);
		expect(setup.headers.get("content-security-policy")).toContain("script-src 'self'");
		const html = await setup.text();
		expect(html).toContain("Cofre NFapi");
		expect(html).toContain("Atualização");
		expect((await app.request(`${ORIGIN}/setup/app.js`, {}, env)).headers.get("content-type")).toContain("javascript");
	});

	it("exige o segredo do cofre nas rotas de administração", async () => {
		for (const rota of ["/admin/status", "/admin/notas", "/admin/chaves", "/admin/atualizacao", "/admin/audit"]) {
			expect((await app.request(ORIGIN + rota, {}, env)).status).toBe(401);
		}
		const errado = await app.request(
			`${ORIGIN}/admin/status`,
			{ headers: { authorization: "Bearer segredo-errado" } },
			env,
		);
		expect(errado.status).toBe(401);
		expect((await admin("/admin/status")).status).toBe(200);
	});

	it("recusa operar com VAULT_SECRET fraco", async () => {
		const fraco = { ...env, VAULT_SECRET: "curto" };
		const init = { headers: { authorization: "Bearer curto" } };
		for (const rota of ["/admin/status", "/v1/nfse"]) {
			const res = await app.request(ORIGIN + rota, init, fraco);
			expect(res.status).toBe(503);
			expect(await erro(res)).toBe("cofre_nao_configurado");
		}
		// Na API dos clientes, até os erros gerais seguem o formato do contrato.
		const v1 = (await (await app.request(`${ORIGIN}/v1/nfse`, init, fraco)).json()) as Record<string, unknown>;
		expect(Object.keys(v1)).toEqual(["erro"]);
		const rotaInexistente = await app.request(`${ORIGIN}/v1/nao-existe`, {}, env);
		expect(await rotaInexistente.json()).toEqual({ erro: { codigo: "nao_encontrado", mensagem: "Rota inexistente." } });
	});

	it("não tem mais as rotas da integração com a API central", async () => {
		await instalarCertificado();
		for (const [method, rota] of [
			["GET", "/v1/health"],
			["POST", "/v1/sign"],
			["POST", "/v1/transmit"],
			["PUT", "/v1/documents/nfe/x.xml"],
			["POST", "/admin/pairings"],
			["POST", "/admin/register"],
		] as const) {
			expect((await admin(rota, { method })).status).toBe(404);
		}
		const status = (await (await admin("/admin/status")).json()) as Json;
		expect(Object.keys(status).sort()).toEqual(["allowProduction", "certificate", "version"]);
	});
});

describe("certificado", () => {
	it("instala o PFX, mostra o titular e guarda a chave cifrada", async () => {
		const res = await instalarCertificado();
		expect(res.status).toBe(200);

		const status = (await (await admin("/admin/status")).json()) as {
			certificate: { holder: { id: string }; commonName: string };
		};
		expect(status.certificate.holder.id).toBe(CNPJ_TESTE);

		const row = await env.DB.prepare("SELECT * FROM certificate").first<Record<string, unknown>>();
		const dump = JSON.stringify(row);
		expect(dump).not.toContain("PRIVATE KEY");
		expect(dump).not.toContain(SENHA_TESTE);
	});

	it("informa senha incorreta sem instalar nada", async () => {
		const res = await instalarCertificado("senha-errada");
		expect(res.status).toBe(422);
		expect(await erro(res)).toBe("senha_incorreta");
		expect(await env.DB.prepare("SELECT id FROM certificate").first()).toBeNull();
	});
});

describe("travas das operações do cofre", () => {
	const abrir = () => abrirOperacoes(env, transport, "teste");
	const codigo = (promessa: Promise<unknown>) =>
		promessa.then(
			() => "sem erro",
			(err) => (err instanceof OperacaoError ? err.code : `inesperado: ${err}`),
		);

	it("sem certificado não há operação", async () => {
		expect(await codigo(abrir())).toBe("certificado_ausente");
	});

	it("assina homologação e mantém produção bloqueada até o emitente liberar", async () => {
		await instalarCertificado();
		const assinar = async (xml: string) => (await abrir()).sign({ xml, tag: "infNFe", profile: "rsa-sha1" });

		const hom = await assinar(NFE(2));
		expect(hom.environment).toBe("homologacao");
		expect(hom.xml).toContain("<SignatureValue>");

		expect(await codigo(assinar(NFE(1)))).toBe("producao_bloqueada");
		await admin("/admin/settings", { method: "PUT", body: JSON.stringify({ allowProduction: true }) });
		expect((await assinar(NFE(1))).environment).toBe("producao");
	});

	it("recusa assinar documento de outro emitente", async () => {
		await instalarCertificado();
		const ops = await abrir();
		expect(await codigo(ops.sign({ xml: NFE(2, "99888777000166"), tag: "infNFe", profile: "rsa-sha1" }))).toBe(
			"emitente_divergente",
		);
	});

	it("só transmite para o governo e grava o diário antes de seguir", async () => {
		await instalarCertificado();
		const ops = await abrir();
		const transmitir = (url: string) => ops.transmit({ url, bodyB64: btoa("<envelope/>"), ref: "emissao-1" });

		for (const url of ["https://evil.example.com/x", "https://gov.br.evil.com/x", "http://nfe.svrs.rs.gov.br/x"]) {
			expect(await codigo(transmitir(url))).toMatch(/^(host_nao_permitido|requisicao_invalida)$/);
		}
		expect(transport.calls).toHaveLength(0);

		const out = await transmitir("https://nfe-homologacao.svrs.rs.gov.br/ws/NFeAutorizacao4");
		expect(out.status).toBe(200);

		// O Container recebeu o certificado decifrado...
		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0]?.cert.privateKeyPem).toContain("BEGIN PRIVATE KEY");
		// ...e a troca completa ficou no R2 do emitente, sem material de chave.
		const journal = await env.DOCS.get(out.journalKey);
		const text = (await journal?.text()) ?? "";
		expect(text).toContain("emissao-1");
		expect(text).toContain("nfe-homologacao.svrs.rs.gov.br");
		expect(text).not.toContain("PRIVATE KEY");
	});
});

describe("arquivos das notas", () => {
	it("baixa só arquivos de notas; o diário e caminhos fora da área ficam inacessíveis", async () => {
		await instalarCertificado();
		const ops = await abrirOperacoes(env, transport, "teste");
		const key = "nfse/homologacao/2026/11/nota-NFSe.xml";
		await ops.putDocument(key, "<NFSe>autorizada</NFSe>", { contentType: "application/xml", meta: {} });

		const ok = await admin(`/admin/notas/arquivo?key=${encodeURIComponent(key)}`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-disposition")).toBe('attachment; filename="nota-NFSe.xml"');
		expect(await ok.text()).toBe("<NFSe>autorizada</NFSe>");

		for (const ruim of ["journal/2026/11/16/x.json", "nfse/../journal/x.json", "/nfse/x.xml", "outra/coisa.xml", ""]) {
			expect((await admin(`/admin/notas/arquivo?key=${encodeURIComponent(ruim)}`)).status).toBe(400);
		}
		expect((await admin("/admin/notas/arquivo?key=nfse/nao/existe.xml")).status).toBe(404);
	});
});

describe("atualização pelo botão", () => {
	const GATILHO = "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/abcdef0123456789abcdef0123456789";
	type Chamada = { url: string; method: string };

	/** Cofre com as chamadas de saída (GitHub e Cloudflare) simuladas. */
	function comRede(publicada: string | null, gatilho: () => Response = () => Response.json({ success: true })) {
		const chamadas: Chamada[] = [];
		const cofre = createApp(() => transport, {
			fetch: async (input, init) => {
				const url = String(input);
				chamadas.push({ url, method: init?.method ?? "GET" });
				if (url.startsWith("https://raw.githubusercontent.com/")) {
					return publicada ? Response.json({ name: "nfapi-cofre", version: publicada }) : new Response("", { status: 500 });
				}
				return gatilho();
			},
		});
		const pedir = (method: string, path: string, body?: unknown) =>
			cofre.request(ORIGIN + path, comSegredo({ method, body: body === undefined ? undefined : JSON.stringify(body) }), env);
		return { chamadas, pedir };
	}

	it("compara as versões por número", () => {
		expect(compararVersoes("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(compararVersoes("1.0.0", "1.0.0")).toBe(0);
		expect(compararVersoes("0.2.0", "0.2.1")).toBeLessThan(0);
	});

	it("mostra a versão publicada no canal estável e avisa quando há uma mais nova", async () => {
		const nova = comRede("99.0.0");
		const estado = (await (await nova.pedir("GET", "/admin/atualizacao")).json()) as Json;
		expect(estado).toEqual({
			instalada: VAULT_VERSION,
			publicada: "99.0.0",
			haAtualizacao: true,
			gatilhoConfigurado: false,
			canal: "Quevenapp/nfapi@cofre-estavel",
			implantacao: null,
			andamento: null,
		});
		expect(nova.chamadas).toEqual([
			{ url: "https://raw.githubusercontent.com/Quevenapp/nfapi/cofre-estavel/vault/package.json", method: "GET" },
		]);

		// A consulta fica em cache; "verificar novamente" força uma nova leitura.
		await nova.pedir("GET", "/admin/atualizacao");
		expect(nova.chamadas).toHaveLength(1);
		await nova.pedir("GET", "/admin/atualizacao?verificar=1");
		expect(nova.chamadas).toHaveLength(2);
	});

	it("não acusa atualização quando está em dia ou quando o GitHub não responde", async () => {
		const emDia = (await (await comRede(VAULT_VERSION).pedir("GET", "/admin/atualizacao?verificar=1")).json()) as Json;
		expect(emDia).toMatchObject({ publicada: VAULT_VERSION, haAtualizacao: false });

		await env.DB.prepare("DELETE FROM settings").run();
		const semRede = (await (await comRede(null).pedir("GET", "/admin/atualizacao")).json()) as Json;
		expect(semRede).toMatchObject({ publicada: null, haAtualizacao: false });
	});

	it("guarda o gatilho cifrado e dispara o build do Cloudflare", async () => {
		const { chamadas, pedir } = comRede("99.0.0");
		const semGatilho = await pedir("POST", "/admin/atualizacao");
		expect(semGatilho.status).toBe(409);
		expect(await erro(semGatilho)).toBe("gatilho_ausente");

		for (const url of [
			"https://evil.example.com/client/v4/workers/builds/deploy_hooks/abcdef0123456789",
			"http://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/abcdef0123456789",
			`${GATILHO}/../../../accounts`,
			`${GATILHO}?x=1`,
			"",
		]) {
			expect(await erro(await pedir("PUT", "/admin/atualizacao/gatilho", { url }))).toBe("gatilho_invalido");
		}
		expect(chamadas).toHaveLength(0);

		expect((await pedir("PUT", "/admin/atualizacao/gatilho", { url: GATILHO })).status).toBe(200);
		const guardado = await env.DB.prepare("SELECT value FROM settings WHERE key = 'gatilho_de_build'").first<{ value: string }>();
		expect(guardado?.value).not.toContain("deploy_hooks");
		expect(((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).gatilhoConfigurado).toBe(true);

		const disparo = await pedir("POST", "/admin/atualizacao");
		expect(disparo.status).toBe(200);
		expect(chamadas.at(-1)).toEqual({ url: GATILHO, method: "POST" });

		// A URL do gatilho é uma credencial: não aparece na auditoria nem nas respostas.
		const auditoria = await (await pedir("GET", "/admin/audit")).text();
		expect(auditoria).toContain("atualizacao.disparar");
		expect(auditoria).not.toContain("deploy_hooks");
	});

	it("avisa quando o Cloudflare recusa o gatilho", async () => {
		const { pedir } = comRede("99.0.0", () => new Response("not found", { status: 404 }));
		await pedir("PUT", "/admin/atualizacao/gatilho", { url: GATILHO });
		const res = await pedir("POST", "/admin/atualizacao");
		expect(res.status).toBe(502);
		expect(await erro(res)).toBe("gatilho_recusado");
		// Nada foi pedido: não há andamento a mostrar.
		expect(((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).andamento).toBeNull();
	});

	it("acompanha a atualização pedida até outro build responder", async () => {
		const { pedir } = comRede("99.0.0");
		const cofre = createApp(() => transport, { fetch: async () => new Response("", { status: 500 }) });
		// O mesmo cofre, respondendo por um build do Cloudflare.
		const noBuild = async (id: string) =>
			(await (await cofre.request(`${ORIGIN}/admin/atualizacao`, comSegredo({}), { ...env, CF_VERSION_METADATA: { id, tag: "", timestamp: "" } })).json()) as Json;
		await pedir("PUT", "/admin/atualizacao/gatilho", { url: GATILHO });

		const antes = Date.now();
		const disparo = (await (await pedir("POST", "/admin/atualizacao")).json()) as Json;
		expect(disparo.andamento).toMatchObject({ situacao: "em_andamento", de: VAULT_VERSION, para: "99.0.0", concluidaEm: null });
		expect(Date.parse(disparo.andamento.iniciadaEm)).toBeGreaterThanOrEqual(antes);
		expect(((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).andamento).toMatchObject({ situacao: "em_andamento" });

		// Passados dez minutos sem versão nova, o build está demorando; depois de uma hora o pedido é esquecido.
		const guardar = (p: Json) => env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'atualizacao_pedida'").bind(JSON.stringify(p)).run();
		const pedido = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'atualizacao_pedida'").first<{ value: string }>())?.value ?? "{}") as Json;
		expect(pedido).toMatchObject({ de: VAULT_VERSION, implantacao: null, para: "99.0.0" });
		await guardar({ ...pedido, em: Date.now() - 11 * 60_000 });
		expect(((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).andamento).toMatchObject({ situacao: "demorando" });
		await guardar({ ...pedido, em: Date.now() - 61 * 60_000 });
		expect(((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).andamento).toBeNull();

		// Outra versão respondendo: terminou.
		await guardar({ ...pedido, de: "0.0.1" });
		const concluida = ((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).andamento;
		expect(concluida).toMatchObject({ situacao: "concluida", de: "0.0.1", para: VAULT_VERSION });
		expect(concluida.concluidaEm).toEqual(expect.any(String));
		// A hora da conclusão fica gravada na primeira vez.
		expect(((await (await pedir("GET", "/admin/atualizacao")).json()) as Json).andamento.concluidaEm).toBe(concluida.concluidaEm);

		// A mesma versão publicada de novo: o que muda é o build.
		await guardar({ ...pedido, implantacao: "build-a", para: null });
		expect(await noBuild("build-a")).toMatchObject({ implantacao: "build-a", andamento: { situacao: "em_andamento", para: null } });
		expect(await noBuild("build-b")).toMatchObject({ implantacao: "build-b", andamento: { situacao: "concluida", para: VAULT_VERSION } });
	});
});

describe("auditoria", () => {
	it("registra as operações sem guardar conteúdo de documento", async () => {
		await instalarCertificado();
		const ops = await abrirOperacoes(env, transport, "chave:chv_teste");
		await ops.sign({ xml: NFE(2), tag: "infNFe", profile: "rsa-sha1" });
		await admin("/admin/selftest", { method: "POST" });

		const res = await admin("/admin/audit");
		const { entries } = (await res.json()) as { entries: { action: string; actor: string }[] };
		expect(entries.map((e) => e.action)).toEqual(["autoteste", "assinar", "certificado.instalar"]);
		expect(entries[1]?.actor).toBe("chave:chv_teste");
		expect(JSON.stringify(entries)).not.toContain("<infNFe");
	});
});
