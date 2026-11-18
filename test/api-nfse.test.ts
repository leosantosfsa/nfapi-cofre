import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { gunzipBase64, gzipBase64 } from "../src/nfse";
import type { TransmitRequest } from "../src/protocol";
import { type Transport, TransportError, type TransportResult } from "../src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "./helpers";

const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
const CHAVE = `35${"0".repeat(46)}77`;
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}"><nNFSe>77</nNFSe></infNFSe></NFSe>`;
const EVENTO_XML = `<evento xmlns="http://www.sped.fazenda.gov.br/nfse"><infEvento Id="EVT${CHAVE}101101"/></evento>`;

type Resposta = { status: number; corpo: unknown };
type Json = Record<string, any>;

/** Faz o papel da SEFIN Nacional atrás do transporte mTLS. */
const sefin = {
	chamadas: [] as TransmitRequest[],
	responder: (async () => ({ status: 500, corpo: {} })) as (req: TransmitRequest) => Promise<Resposta>,
};
const autorizar = async (req: TransmitRequest): Promise<Resposta> =>
	req.url.endsWith("/eventos")
		? { status: 201, corpo: { eventoXmlGZipB64: await gzipBase64(EVENTO_XML) } }
		: { status: 201, corpo: { chaveAcesso: CHAVE, nfseXmlGZipB64: await gzipBase64(NFSE_XML), alertas: [] } };

const transporte: Transport = {
	async transmit(request): Promise<TransportResult> {
		sefin.chamadas.push(request);
		const { status, corpo } = await sefin.responder(request);
		const bytes = new TextEncoder().encode(typeof corpo === "string" ? corpo : JSON.stringify(corpo));
		return {
			status,
			headers: {},
			bodyB64: btoa(String.fromCharCode(...bytes)),
			tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" },
			ms: 5,
		};
	},
};

const app = createApp(() => transporte);

const admin = (path: string, init: RequestInit = {}) =>
	app.request(COFRE + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${env.VAULT_SECRET}` } }, env);

async function cliente(method: string, path: string, chave?: string, body?: unknown) {
	const headers: Record<string, string> = {};
	if (chave) headers.authorization = `Bearer ${chave}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await app.request(COFRE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const text = await res.text();
	const isJson = (res.headers.get("content-type") ?? "").includes("json");
	return { status: res.status, json: (isJson && text ? JSON.parse(text) : null) as Json, text };
}

async function criarChave(escopo: "completo" | "homologacao" = "completo") {
	const res = await admin("/admin/chaves", { method: "POST", body: JSON.stringify({ nome: "Sistema de teste", escopo }) });
	return ((await res.json()) as Json).chave as Json;
}

async function instalarCertificado() {
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await admin("/admin/certificate", { method: "POST", body: form });
}

const pedido = (extra: Json = {}) => ({
	prestador: { codigoMunicipio: "3550308", regimeTributario: { simplesNacional: "me_epp", apuracaoSimples: 1 } },
	tomador: { cnpj: "99888777000166", nome: "Cliente Ltda" },
	servico: { codigoMunicipioPrestacao: "3550308", codigoTributacaoNacional: "010701", descricao: "Suporte técnico" },
	valores: { servico: 1500 },
	tributacao: { issqn: { aliquota: 2 }, totalTributos: { tipo: "percentual_simples", percentual: 6 } },
	...extra,
});

let chave: string;
const emitir = (extra: Json = {}) => cliente("POST", "/v1/nfse", chave, pedido(extra));
const envios = () => sefin.chamadas.filter((c) => c.method === "POST" && !c.url.endsWith("/eventos"));
const eventos = () => sefin.chamadas.filter((c) => c.url.endsWith("/eventos"));
const motivo = { motivo: "erro_emissao", justificativa: "Nota emitida com o valor incorreto" };

beforeEach(async () => {
	sefin.chamadas = [];
	sefin.responder = autorizar;
	await env.DB.batch(
		["emissions", "series", "api_keys", "certificate", "settings", "audit", "documents"].map((t) =>
			env.DB.prepare(`DELETE FROM ${t}`),
		),
	);
	await instalarCertificado();
	chave = (await criarChave()).valor;
});

describe("o cofre como API de emissão", () => {
	it("emite a NFS-e sozinho: monta, assina, transmite e arquiva", async () => {
		const { status, json } = await emitir();
		expect(status).toBe(201);
		expect(json).toMatchObject({
			ambiente: "homologacao",
			situacao: "autorizada",
			serie: "1",
			numero: 1,
			chaveAcesso: CHAVE,
			numeroNfse: "77",
			xmlDisponivel: true,
			idDps: `DPS35503082${CNPJ_TESTE}00001000000000000001`,
		});

		// Uma única chamada ao governo, direto do cofre.
		expect(sefin.chamadas).toHaveLength(1);
		expect(envios()[0]?.url).toBe("https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/nfse");
		const corpo = JSON.parse(atob(envios()[0]?.bodyB64 ?? "")) as { dpsXmlGZipB64: string };
		const dps = await gunzipBase64(corpo.dpsXmlGZipB64);
		expect(dps).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><DPS /);
		expect(dps).toContain("<tpAmb>2</tpAmb>");
		expect(dps).toContain("<finNFSe>0</finNFSe>");
		expect(dps).toContain(`<prest><CNPJ>${CNPJ_TESTE}</CNPJ>`);
		expect(dps).toMatch(/<\/infDPS><Signature /);

		const xml = await cliente("GET", `/v1/nfse/${json.id}/xml`, chave);
		expect(xml.text).toBe(NFSE_XML);
		expect((await cliente("GET", `/v1/nfse/${json.id}`, chave)).json.situacao).toBe("autorizada");
		expect((await emitir()).json.numero).toBe(2);
		expect((await cliente("GET", "/v1/nfse", chave)).json.nfse).toHaveLength(2);

		// A nota aparece no painel do emitente com os dados e os arquivos.
		const notas = ((await (await admin("/admin/notas")).json()) as Json).notas;
		expect(notas[0]).toMatchObject({ chaveAcesso: CHAVE, numeroNfse: "77", valor: 1500, situacao: "autorizada" });
	});

	it("a mesma referência nunca gera duas notas, e a rejeição reaproveita o número", async () => {
		const primeira = await emitir({ referencia: "pedido-1" });
		const repetida = await emitir({ referencia: "pedido-1" });
		expect([primeira.status, repetida.status]).toEqual([201, 200]);
		expect(repetida.json.id).toBe(primeira.json.id);
		expect(envios()).toHaveLength(1);

		// A mesma referência com outro conteúdo é recusada, em vez de devolver a nota antiga.
		const alterada = await emitir({ referencia: "pedido-1", valores: { servico: 999 } });
		expect(alterada.status).toBe(409);
		expect(alterada.json.erro.codigo).toBe("referencia_com_conteudo_diferente");
		expect(envios()).toHaveLength(1);

		sefin.responder = async () => ({ status: 400, corpo: { erros: [{ Codigo: "E0312", Descricao: "Código de tributação inválido" }] } });
		const recusada = await emitir({ referencia: "pedido-2" });
		expect(recusada.status).toBe(422);
		expect(recusada.json.erro).toMatchObject({ codigo: "nfse_rejeitada", mensagem: "Código de tributação inválido" });
		expect(recusada.json.nfse).toMatchObject({ situacao: "rejeitada", numero: 2 });

		sefin.responder = autorizar;
		const corrigida = await emitir({ referencia: "pedido-2" });
		expect(corrigida.status).toBe(201);
		expect(corrigida.json).toMatchObject({ id: recusada.json.nfse.id, numero: 2 });
	});

	it("produção só sai com a trava liberada, e a chave de teste nunca emite em produção", async () => {
		const bloqueada = await emitir({ ambiente: "producao", referencia: "prod-1" });
		expect(bloqueada.status).toBe(422);
		expect(bloqueada.json.erro.codigo).toBe("producao_bloqueada");
		expect(sefin.chamadas).toHaveLength(0);

		await admin("/admin/settings", { method: "PUT", body: JSON.stringify({ allowProduction: true }) });
		const liberada = await emitir({ ambiente: "producao", referencia: "prod-1" });
		expect(liberada.status).toBe(201);
		expect(envios()[0]?.url).toBe("https://sefin.nfse.gov.br/SefinNacional/nfse");

		// Mesmo com a produção liberada no cofre, a chave de homologação não passa.
		const deTeste = (await criarChave("homologacao")).valor as string;
		const negada = await cliente("POST", "/v1/nfse", deTeste, pedido({ ambiente: "producao" }));
		expect(negada.status).toBe(403);
		expect(negada.json.erro.codigo).toBe("chave_somente_homologacao");
		expect((await cliente("POST", `/v1/nfse/${liberada.json.id}/cancelar`, deTeste, motivo)).status).toBe(403);
		expect((await cliente("POST", "/v1/nfse", deTeste, pedido())).status).toBe(201);
		expect(envios()).toHaveLength(2);
	});

	it("sem resposta do governo, a retomada consulta a DPS antes de reenviar", async () => {
		sefin.responder = async () => {
			throw new TransportError(504, "tempo_esgotado", "Sem resposta em 60000 ms.");
		};
		const perdida = await emitir({ referencia: "pedido-9" });
		expect(perdida.status).toBe(502);
		expect(perdida.json.nfse.situacao).toBe("indefinida");

		sefin.chamadas = [];
		sefin.responder = async (req) =>
			req.url.includes("/dps/")
				? { status: 200, corpo: { chaveAcesso: CHAVE } }
				: { status: 200, corpo: { chaveAcesso: CHAVE, nfseXmlGZipB64: await gzipBase64(NFSE_XML) } };
		const recuperada = await emitir({ referencia: "pedido-9" });
		expect(recuperada.status).toBe(201);
		expect(recuperada.json).toMatchObject({ id: perdida.json.nfse.id, situacao: "autorizada" });
		expect(sefin.chamadas.map((c) => c.method)).toEqual(["GET", "GET"]);
	});

	it("cancela pela API e pelo painel, sem depender de outro serviço", async () => {
		const nota = (await emitir()).json;
		expect((await cliente("POST", `/v1/nfse/${nota.id}/cancelar`, chave, { motivo: "outros", justificativa: "curta" })).status).toBe(400);

		const cancelada = await cliente("POST", `/v1/nfse/${nota.id}/cancelar`, chave, motivo);
		expect(cancelada.status).toBe(200);
		expect(cancelada.json.situacao).toBe("cancelada");
		expect(eventos()).toHaveLength(1);
		expect(eventos()[0]?.url).toBe(`https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/nfse/${CHAVE}/eventos`);
		const corpo = JSON.parse(atob(eventos()[0]?.bodyB64 ?? "")) as { pedidoRegistroEventoXmlGZipB64: string };
		const evento = await gunzipBase64(corpo.pedidoRegistroEventoXmlGZipB64);
		expect(evento).toContain(`<infPedReg Id="PRE${CHAVE}101101"><tpAmb>2</tpAmb>`);
		expect(evento).toMatch(/<\/infPedReg><Signature /);

		// Repetir não reenvia; o painel mostra a nota cancelada com o evento arquivado.
		expect((await cliente("POST", `/v1/nfse/${nota.id}/cancelar`, chave, motivo)).status).toBe(200);
		expect(eventos()).toHaveLength(1);
		const notas = ((await (await admin("/admin/notas")).json()) as Json).notas;
		expect(notas[0].situacao).toBe("cancelada");
		expect(notas[0].arquivos.map((a: Json) => a.tipo)).toEqual(["nfse", "dps", "cancelamento"]);
	});

	it("o painel cancela localmente as notas emitidas por este cofre", async () => {
		await emitir();
		const res = await admin("/admin/notas/cancelar", { method: "POST", body: JSON.stringify({ chaveAcesso: CHAVE, ...motivo }) });
		expect(res.status).toBe(200);
		expect(((await res.json()) as Json).nfse.situacao).toBe("cancelada");
		// Só o governo foi chamado: uma emissão e um evento.
		expect(sefin.chamadas.map((c) => c.url.split("/").pop())).toEqual(["nfse", "eventos"]);

		sefin.responder = async () => ({ status: 400, corpo: { erros: [{ Codigo: "E0840", Descricao: "Prazo expirado" }] } });
		const outra = (await emitir()).json;
		expect(outra.erro.codigo).toBe("nfse_rejeitada");
	});

	it("exige chave de API válida, e a chave não dá acesso ao painel", async () => {
		expect((await cliente("POST", "/v1/nfse", undefined, pedido())).status).toBe(401);
		expect((await cliente("GET", "/v1/nfse", "nfapi_chave-inexistente-000000000000000000000000000")).status).toBe(401);
		// O segredo do cofre não é chave de API.
		expect((await cliente("GET", "/v1/nfse", env.VAULT_SECRET)).status).toBe(401);

		const invalido = await emitir({ valores: { servico: -1 } });
		expect(invalido.status).toBe(400);
		expect(invalido.json.erro.codigo).toBe("requisicao_invalida");

		const outra = await criarChave();
		expect((await cliente("GET", "/v1/nfse", outra.valor)).status).toBe(200);
		await admin(`/admin/chaves/${outra.id}`, { method: "DELETE" });
		expect((await cliente("GET", "/v1/nfse", outra.valor)).status).toBe(401);

		// A listagem de chaves nunca devolve o valor, e o banco guarda só o hash.
		const lista = ((await (await admin("/admin/chaves")).json()) as Json).chaves;
		expect(lista).toHaveLength(2);
		expect(JSON.stringify(lista)).not.toContain(chave);
		expect(JSON.stringify((await env.DB.prepare("SELECT * FROM api_keys").all()).results)).not.toContain(chave);
		expect((await app.request(`${COFRE}/admin/chaves`, {}, env)).status).toBe(401);

		// A chave de API não abre o painel do emitente.
		expect((await cliente("GET", "/admin/status", chave)).status).toBe(401);
		expect((await cliente("GET", "/admin/notas", chave)).status).toBe(401);
	});

	it("sem certificado instalado, explica o que falta", async () => {
		await env.DB.prepare("DELETE FROM certificate").run();
		const res = await emitir();
		expect(res.status).toBe(409);
		expect(res.json.erro.codigo).toBe("certificado_ausente");
	});
});
