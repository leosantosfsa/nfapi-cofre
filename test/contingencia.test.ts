import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { executarAgendado } from "../src/agendador";
import { createApp } from "../src/app";
import { EXEMPLO_NFCE, EXEMPLO_NFE } from "../src/contrato-exemplos";
import { ajustes } from "../src/emissao/nfe";
import type { TransmitRequest } from "../src/protocol";
import { type Transport, TransportError, type TransportResult } from "../src/transport";
import { SENHA_TESTE, pfxModerno } from "./helpers";

const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
type Json = Record<string, any>;
type Chamada = { servico: string; url: string; corpo: string; timeoutMs?: number };

// ---------- SEFAZ simulada, que pode ficar fora do ar ----------

const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const soap = (xml: string) =>
	`<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">${xml}</nfeResultMsg></soap:Body></soap:Envelope>`;
const chaveDe = (corpo: string) => /Id="NFe([0-9A-Z]{44})"/.exec(corpo)?.[1] ?? /<chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(corpo)?.[1] ?? "";
const protocolo = (chave: string, cStat = "100", xMotivo = "Autorizado o uso da NF-e") =>
	`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-11-16T19:00:00-03:00</dhRecbto><nProt>135260000000777</nProt><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo></infProt></protNFe>`;
const lote = (conteudo: string, cStat = "104") => soap(`<retEnviNFe ${NS} versao="4.00"><cStat>${cStat}</cStat><xMotivo>Lote processado</xMotivo>${conteudo}</retEnviNFe>`);
const naoConsta = () => soap(`<retConsSitNFe ${NS} versao="4.00"><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo></retConsSitNFe>`);
const autorizadaNaConsulta = (c: Chamada) => soap(`<retConsSitNFe ${NS} versao="4.00"><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>${protocolo(chaveDe(c.corpo))}</retConsSitNFe>`);

const sefaz = {
	chamadas: [] as Chamada[],
	/** Serviços que não respondem (tempo esgotado). */
	fora: new Set<string>(),
	respostas: {} as Record<string, (c: Chamada) => string>,
};
const padrao: Record<string, (c: Chamada) => string> = {
	autorizacao: (c) => lote(protocolo(chaveDe(c.corpo))),
	consulta: naoConsta,
	evento: (c) =>
		soap(`<retEnvEvento ${NS} versao="1.00"><cStat>128</cStat><retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${chaveDe(c.corpo)}</chNFe><nProt>135260000000888</nProt></infEvento></retEvento></retEnvEvento>`),
	status: () => soap(`<retConsStatServ ${NS} versao="4.00"><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><tMed>1</tMed></retConsStatServ>`),
};
const servicoDe = (url: string) => {
	const fim = (url.split("/").pop() ?? "").toLowerCase();
	if (fim.includes("autorizacao")) return "autorizacao";
	if (fim.includes("consulta")) return "consulta";
	if (fim.includes("evento")) return "evento";
	return "status";
};
const transporte: Transport = {
	async transmit(request: TransmitRequest): Promise<TransportResult> {
		const corpo = new TextDecoder().decode(Uint8Array.from(atob(request.bodyB64 ?? ""), (ch) => ch.charCodeAt(0)));
		const chamada = { servico: servicoDe(request.url), url: request.url, corpo, timeoutMs: request.timeoutMs };
		sefaz.chamadas.push(chamada);
		if (sefaz.fora.has(chamada.servico)) throw new TransportError(504, "tempo_esgotado", "Sem resposta da SEFAZ.");
		const xml = (sefaz.respostas[chamada.servico] ?? (padrao[chamada.servico] as (c: Chamada) => string))(chamada);
		let binario = "";
		for (const b of new TextEncoder().encode(xml)) binario += String.fromCharCode(b);
		return { status: 200, headers: {}, bodyB64: btoa(binario), tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" }, ms: 5 };
	},
};

const app = createApp(() => transporte, { fetch: async () => Response.json({ version: "0.0.1" }) });
const admin = async (method: string, path: string, body?: unknown) => {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	return { status: res.status, json: (await res.json()) as Json };
};
let chaveApi: string;
async function cliente(method: string, path: string, body?: unknown) {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${chaveApi}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const text = await res.text();
	return { status: res.status, json: ((res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null) as Json, text };
}
const nfce = (mudancas: Json = {}) => cliente("POST", "/v1/nfce", { ...EXEMPLO_NFCE, ...mudancas });
const processar = async () => (await admin("POST", "/admin/contingencia/processar")).json;
const chamadas = (servico: string) => sefaz.chamadas.filter((c) => c.servico === servico);
const proximo = async () => ((await cliente("GET", "/v1/series")).json.series as Json[]).find((s) => s.modelo === "nfce")?.proximoNumero;
const QR_OFFLINE = /^https:\/\/www\.homologacao\.nfce\.fazenda\.sp\.gov\.br\/qrcode\?p=\d{34}9\d{9}\|3\|2\|\d{2}\|59\.90\|2\|12345678909\|[A-Za-z0-9+/]+={0,2}$/;

beforeEach(async () => {
	ajustes.esperaReciboMs = 0;
	sefaz.chamadas = [];
	sefaz.fora = new Set();
	sefaz.respostas = {};
	await env.DB.batch(
		["emissions", "series", "inutilizacoes", "api_keys", "certificate", "settings", "audit", "documents"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
	);
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await app.request(`${COFRE}/admin/certificate`, { method: "POST", headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: form }, env);
	chaveApi = (await admin("POST", "/admin/chaves", { nome: "PDV de teste" })).json.chave.valor;
	await admin("PUT", "/admin/series", { modelo: "nfce", ambiente: "homologacao", serie: 1, proximoNumero: 10 });
});

describe("contingência offline da NFC-e", () => {
	it("forçada: emite sem falar com a SEFAZ e transmite o mesmo XML depois", async () => {
		const { status, json } = await nfce({ contingencia: "forcada" });
		expect(status).toBe(201);
		expect(json).toMatchObject({ modelo: "nfce", situacao: "contingencia", numero: 10, protocolo: null, autorizadaEm: null, xmlDisponivel: true });
		expect(json.contingencia).toMatchObject({ pendente: true, tentativasDeTransmissao: 0, notaNormalEmConferencia: null });
		expect(json.chaveAcesso[34]).toBe("9");
		expect(json.qrCode).toMatch(QR_OFFLINE);
		expect(sefaz.chamadas).toHaveLength(0);

		// O arquivo, por enquanto, é a nota assinada, sem protocolo.
		const xml = (await cliente("GET", `/v1/nfce/${json.id}/xml`)).text;
		expect(xml).toMatch(/^<NFe /);
		expect(xml).toContain("<tpEmis>9</tpEmis>");
		expect(xml).toMatch(/<verProc>[^<]+<\/verProc><dhCont>[^<]+<\/dhCont><xJust>Contingencia solicitada pelo sistema emissor<\/xJust>/);
		expect(xml).toContain("<infNFeSupl><qrCode><![CDATA[");

		// Repetir a referência devolve a mesma nota; cancelar só depois da autorização.
		const repetida = await nfce({ contingencia: "forcada" });
		expect([repetida.status, repetida.json.id]).toEqual([200, json.id]);
		expect((await cliente("POST", `/v1/nfce/${json.id}/cancelar`, { justificativa: "Venda desfeita no caixa" })).status).toBe(409);
		expect((await cliente("GET", "/v1/cofre")).json.contingencia).toEqual({ notasPendentes: 1 });
		expect((await admin("GET", "/admin/notas")).json.notas[0].situacao).toBe("contingencia");

		// O cupom da nota em contingência: os dizeres em dois lugares, sem protocolo, e a via do estabelecimento.
		const cupom = (await cliente("GET", `/v1/nfce/${json.id}/cupom?via=estabelecimento`)).json;
		expect(cupom).toMatchObject({ situacao: "contingencia", contingencia: true, pendenteDeAutorizacao: true, via: "estabelecimento", protocolo: null, qrCode: json.qrCode });
		const textos = (divisao: string) => (cupom.secoes.find((s: Json) => s.divisao === divisao).linhas as Json[]).map((l) => l.texto ?? l.tipo);
		expect(textos("cabecalho").slice(-4)).toEqual(["separador", "EMITIDA EM CONTINGÊNCIA", "Pendente de autorização", "separador"]);
		expect(textos("identificacao").slice(1)).toEqual(["Via do Estabelecimento", "EMITIDA EM CONTINGÊNCIA", "Pendente de autorização"]);
		expect((await cliente("GET", `/v1/nfce/${json.id}/cupom`)).json.via).toBe("consumidor");

		// A fila: confere o status da SEFAZ e transmite o XML que já estava assinado.
		expect(await processar()).toEqual({ resumo: { autorizadas: 1, rejeitadas: 0, aguardando: 0 }, notasPendentes: 0 });
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["status", "autorizacao"]);
		expect(chamadas("autorizacao")[0]?.corpo).toContain(xml);
		const autorizada = (await cliente("GET", `/v1/nfce/${json.id}`)).json;
		expect(autorizada).toMatchObject({ situacao: "autorizada", protocolo: "135260000000777", chaveAcesso: json.chaveAcesso, qrCode: json.qrCode });
		expect(autorizada.contingencia.pendente).toBe(false);
		expect((await cliente("GET", `/v1/nfce/${json.id}/xml`)).text).toMatch(/^<nfeProc /);

		// Depois de autorizada, o cupom ganha o protocolo e perde os dizeres de pendência.
		const depois = (await cliente("GET", `/v1/nfce/${json.id}/cupom`)).json;
		expect(depois).toMatchObject({ situacao: "autorizada", contingencia: true, pendenteDeAutorizacao: false, protocolo: "135260000000777" });
		expect(JSON.stringify(depois.secoes)).not.toContain("Pendente de autorização");
		expect(JSON.stringify(depois.secoes)).toContain("Protocolo de autorização: 135260000000777");
	});

	it("automática: a SEFAZ não responde, a venda sai em contingência com número novo", async () => {
		sefaz.fora = new Set(["autorizacao", "status", "consulta"]);
		const { status, json } = await nfce({ contingencia: "automatica" });
		expect(status).toBe(201);
		expect(json).toMatchObject({ situacao: "contingencia", numero: 11 });
		// A nota normal (número 10) pode ter chegado à SEFAZ: fica para conferir.
		const normal = chaveDe(chamadas("autorizacao")[0]?.corpo ?? "");
		expect(normal[34]).toBe("1");
		expect(json.contingencia).toMatchObject({ pendente: true, notaNormalEmConferencia: normal });
		expect(json.contingencia.motivo).toContain("tempo_esgotado");
		// Com a contingência como saída, o caixa espera menos pela SEFAZ.
		expect(chamadas("autorizacao")[0]?.timeoutMs).toBe(20_000);

		// A venda seguinte nem tenta a SEFAZ: sai direto em contingência.
		sefaz.chamadas = [];
		const seguinte = await nfce({ contingencia: "automatica", referencia: "caixa1-venda-5002" });
		expect(seguinte.json).toMatchObject({ situacao: "contingencia", numero: 12 });
		expect(seguinte.json.contingencia.desde).toBe(json.contingencia.desde);
		expect(sefaz.chamadas).toHaveLength(0);

		// Enquanto a SEFAZ segue fora, a fila só confere o status, uma vez.
		expect((await processar()).resumo).toEqual({ autorizadas: 0, rejeitadas: 0, aguardando: 2 });
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["status"]);

		// A SEFAZ volta. A nota normal não consta lá: nada a cancelar.
		sefaz.fora = new Set();
		sefaz.chamadas = [];
		expect(await processar()).toEqual({ resumo: { autorizadas: 2, rejeitadas: 0, aguardando: 0 }, notasPendentes: 0 });
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["status", "autorizacao", "consulta", "autorizacao"]);
		expect(chamadas("consulta")[0]?.corpo).toContain(`<chNFe>${normal}</chNFe>`);
		const final = (await cliente("GET", `/v1/nfce/${json.id}`)).json;
		expect(final).toMatchObject({ situacao: "autorizada", numero: 11 });
		expect(final.contingencia).toMatchObject({ notaNormalEmConferencia: null, notaNormalCancelada: null });

		// Com a SEFAZ de volta, a próxima venda sai pelo caminho normal, e não há mais nada na fila.
		sefaz.chamadas = [];
		const normalDeNovo = await nfce({ contingencia: "automatica", referencia: "caixa1-venda-5003" });
		expect(normalDeNovo.json).toMatchObject({ situacao: "autorizada", numero: 13, contingencia: null });
		expect(await executarAgendado(env, transporte)).toBeNull();
	});

	it("a nota normal acabou autorizada: é cancelada por substituição, apontando para a de contingência", async () => {
		sefaz.fora = new Set(["autorizacao"]);
		const { json } = await nfce({ contingencia: "automatica" });
		const normal = chaveDe(chamadas("autorizacao")[0]?.corpo ?? "");

		sefaz.fora = new Set();
		sefaz.respostas.consulta = autorizadaNaConsulta;
		sefaz.chamadas = [];
		expect((await processar()).resumo.autorizadas).toBe(1);
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["status", "autorizacao", "consulta", "evento"]);
		const evento = chamadas("evento")[0]?.corpo ?? "";
		expect(evento).toContain(`<infEvento Id="ID110112${normal}01">`);
		expect(evento).toContain("<descEvento>Cancelamento por substituicao</descEvento><cOrgaoAutor>35</cOrgaoAutor><tpAutor>1</tpAutor>");
		expect(evento).toContain(`<nProt>135260000000777</nProt><xJust>NFC-e substituida por nota emitida em contingencia</xJust><chNFeRef>${json.chaveAcesso}</chNFeRef>`);
		expect(evento).toMatch(/<\/infEvento><Signature /);

		const final = (await cliente("GET", `/v1/nfce/${json.id}`)).json;
		expect(final.contingencia).toMatchObject({ notaNormalEmConferencia: null, notaNormalCancelada: normal });
		// Resolvido: a fila não volta a consultar.
		sefaz.chamadas = [];
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(sefaz.chamadas).toHaveLength(0);
	});

	it("serviço paralisado (cStat 108) também leva à contingência, sem nota normal a conferir", async () => {
		sefaz.respostas.autorizacao = () => lote("", "108");
		const { status, json } = await nfce({ contingencia: "automatica" });
		expect(status).toBe(201);
		expect(json).toMatchObject({ situacao: "contingencia", numero: 11 });
		expect(json.contingencia).toMatchObject({ notaNormalEmConferencia: null });
		expect(json.contingencia.motivo).toContain("108");
	});

	it("sem pedir contingência, a queda da SEFAZ continua devolvendo 502", async () => {
		sefaz.fora = new Set(["autorizacao"]);
		const padraoNunca = await nfce();
		expect(padraoNunca.status).toBe(502);
		expect(padraoNunca.json.nfce.situacao).toBe("indefinida");
		expect((await nfce({ contingencia: "talvez", referencia: "x" })).status).toBe(400);
	});

	it("rejeitada na transmissão: mantém o número, e a nota corrigida sai com a mesma data", async () => {
		const { json } = await nfce({ contingencia: "forcada" });
		sefaz.respostas.autorizacao = (c) => lote(protocolo(chaveDe(c.corpo), "778", "Rejeicao: Informado NCM inexistente"));
		expect((await processar()).resumo).toEqual({ autorizadas: 0, rejeitadas: 1, aguardando: 0 });
		const rejeitada = (await cliente("GET", `/v1/nfce/${json.id}`)).json;
		expect(rejeitada).toMatchObject({ situacao: "rejeitada", numero: 10, mensagens: [{ codigo: "778" }] });
		// O número é de uma nota entregue ao consumidor: não volta para a série.
		expect(await proximo()).toBe(11);
		// A fila não insiste numa nota rejeitada.
		sefaz.chamadas = [];
		await processar();
		expect(chamadas("autorizacao")).toHaveLength(0);

		delete sefaz.respostas.autorizacao;
		const corrigida = await nfce({ contingencia: "automatica", itens: [{ ...EXEMPLO_NFCE.itens[0], ncm: "61099000" }] });
		expect(corrigida.status).toBe(201);
		expect(corrigida.json).toMatchObject({ id: json.id, situacao: "autorizada", numero: 10, emitidaEm: json.emitidaEm });
		expect(corrigida.json.chaveAcesso[34]).toBe("9");
		const reenviada = chamadas("autorizacao").at(-1)?.corpo ?? "";
		expect(reenviada).toContain("<NCM>61099000</NCM>");
		expect(reenviada).toContain(`<dhCont>${json.contingencia.desde}</dhCont>`);
		expect(await proximo()).toBe(11);
	});

	it("respeita a trava de produção e não existe na NF-e", async () => {
		await admin("PUT", "/admin/series", { modelo: "nfce", ambiente: "producao", serie: 1 });
		const bloqueada = await nfce({ ambiente: "producao", contingencia: "forcada" });
		expect(bloqueada.status).toBe(422);
		expect(bloqueada.json.erro.codigo).toBe("producao_bloqueada");

		// Na NF-e a opção é ignorada: a nota sai pelo caminho normal.
		await admin("PUT", "/admin/series", { modelo: "nfe", ambiente: "homologacao", serie: 1 });
		const nfe = await cliente("POST", "/v1/nfe", { ...EXEMPLO_NFE, contingencia: "forcada" });
		expect(nfe.json).toMatchObject({ situacao: "autorizada", contingencia: null });
		expect(nfe.json.chaveAcesso[34]).toBe("1");
	});
});
