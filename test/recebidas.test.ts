import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { executarAgendado } from "../src/agendador";
import { createApp } from "../src/app";
import { EXEMPLO_NFE } from "../src/contrato-exemplos";
import { ajustes } from "../src/emissao/nfe";
import { montarChave } from "../src/nfe/chave";
import { gzipBase64 } from "../src/nfse";
import type { TransmitRequest } from "../src/protocol";
import { type Transport, TransportError, type TransportResult } from "../src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "./helpers";

const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
type Json = Record<string, any>;

// ---------- Ambiente Nacional simulado ----------

const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const FORNECEDOR = "44555666000181";
const chaveDoFornecedor = (numero: number) => montarChave({ cUF: "35", emissao: "2026-11-10", cnpj: FORNECEDOR, modelo: "55", serie: 1, numero, tpEmis: "1", cNF: "87654321" });
const dataRecente = (diasAtras: number) => `${new Date(Date.now() - diasAtras * 86_400_000).toISOString().slice(0, 19)}-03:00`;

const resumo = (chave: string, { situacao = "1", autorizadaEm = dataRecente(1), valor = "1520.75" } = {}) =>
	`<resNFe ${NS} versao="1.01"><chNFe>${chave}</chNFe><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor de Teste Ltda</xNome><IE>123456789012</IE>` +
	`<dhEmi>${autorizadaEm}</dhEmi><tpNF>1</tpNF><vNF>${valor}</vNF><digVal>abc=</digVal><dhRecbto>${autorizadaEm}</dhRecbto><nProt>135260000001234</nProt><cSitNFe>${situacao}</cSitNFe></resNFe>`;
const notaCompleta = (chave: string) =>
	`<nfeProc ${NS} versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00"><ide><dhEmi>2026-11-10T09:30:00-03:00</dhEmi><tpNF>1</tpNF></ide>` +
	`<emit><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor de Teste Ltda</xNome><IE>123456789012</IE></emit><dest><CNPJ>${CNPJ_TESTE}</CNPJ><xNome>Empresa de Teste</xNome></dest>` +
	"<total><ICMSTot><vNF>1520.75</vNF></ICMSTot></total></infNFe></NFe>" +
	`<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><dhRecbto>2026-11-10T09:31:00-03:00</dhRecbto><nProt>135260000001234</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const cancelamento = (chave: string) =>
	`<procEventoNFe ${NS} versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${chave}01"><cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>${FORNECEDOR}</CNPJ><chNFe>${chave}</chNFe>` +
	'<dhEvento>2026-11-11T08:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento></detEvento></infEvento></evento>' +
	`<retEvento versao="1.00"><infEvento><cStat>135</cStat><chNFe>${chave}</chNFe><nProt>135260000009999</nProt></infEvento></retEvento></procEventoNFe>`;

interface Chamada {
	servico: "distribuicao" | "evento" | "autorizacao";
	url: string;
	corpo: string;
}
const an = {
	chamadas: [] as Chamada[],
	/** Documentos na fila de distribuição do CNPJ, em ordem de NSU. */
	fila: [] as { nsu: number; schema: string; xml: string }[],
	/** Notas que a consulta por chave devolve. */
	porChave: {} as Record<string, string>,
	fora: false,
	/** Resposta forçada; null deixa o pedido seguir para a fila simulada. */
	distribuicao: null as null | ((corpo: string) => string | null),
	evento: null as null | ((corpo: string) => string),
};
const envelope = (xml: string) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>${xml}</soap:Body></soap:Envelope>`;
const retDist = (conteudo: string) =>
	envelope(`<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult><retDistDFeInt ${NS} versao="1.01"><tpAmb>2</tpAmb><verAplic>1.4.0</verAplic>${conteudo}</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse>`);
const nsu15 = (n: number) => String(n).padStart(15, "0");
const consumoIndevido = (ultNsu?: number) =>
	retDist(`<cStat>656</cStat><xMotivo>Rejeicao: Consumo Indevido. Deve ser utilizado o ultNSU nas solicitacoes subsequentes. Tente apos 1 hora</xMotivo>${ultNsu === undefined ? "" : `<ultNSU>${nsu15(ultNsu)}</ultNSU><maxNSU>${nsu15(ultNsu)}</maxNSU>`}`);

async function distribuir(corpo: string): Promise<string> {
	const forcada = an.distribuicao?.(corpo);
	if (forcada) return forcada;
	const maior = an.fila.reduce((m, d) => Math.max(m, d.nsu), 0);
	const porNsu = /<consNSU><NSU>(\d{15})<\/NSU>/.exec(corpo)?.[1];
	if (porNsu) {
		const doc = an.fila.find((d) => d.nsu === Number(porNsu));
		if (!doc) return retDist("<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>");
		return retDist(`<cStat>138</cStat><xMotivo>Documento localizado</xMotivo><loteDistDFeInt><docZip NSU="${nsu15(doc.nsu)}" schema="${doc.schema}">${await gzipBase64(doc.xml)}</docZip></loteDistDFeInt>`);
	}
	const porChave = /<consChNFe><chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(corpo)?.[1];
	if (porChave) {
		const xml = an.porChave[porChave];
		if (!xml) return retDist("<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>");
		return retDist(`<cStat>138</cStat><xMotivo>Documento localizado</xMotivo><loteDistDFeInt><docZip schema="procNFe_v4.00.xsd">${await gzipBase64(xml)}</docZip></loteDistDFeInt>`);
	}
	const ult = Number(/<ultNSU>(\d{15})<\/ultNSU>/.exec(corpo)?.[1] ?? "x");
	const lote = an.fila.filter((d) => d.nsu > ult).slice(0, 50);
	if (lote.length === 0) return retDist(`<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo><ultNSU>${nsu15(ult)}</ultNSU><maxNSU>${nsu15(maior)}</maxNSU>`);
	const docs = await Promise.all(lote.map(async (d) => `<docZip NSU="${nsu15(d.nsu)}" schema="${d.schema}">${await gzipBase64(d.xml)}</docZip>`));
	return retDist(
		`<cStat>138</cStat><xMotivo>Documento(s) localizado(s)</xMotivo><ultNSU>${nsu15(lote[lote.length - 1]?.nsu ?? 0)}</ultNSU><maxNSU>${nsu15(maior)}</maxNSU><loteDistDFeInt>${docs.join("")}</loteDistDFeInt>`,
	);
}
const retEvento = (cStat: string, xMotivo: string, corpo: string) =>
	envelope(
		`<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><retEnvEvento ${NS} versao="1.00"><cStat>128</cStat><retEvento versao="1.00"><infEvento><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>` +
			`<chNFe>${/<chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(corpo)?.[1]}</chNFe><nProt>891260000000555</nProt></infEvento></retEvento></retEnvEvento></nfeResultMsg>`,
	);
const autorizada = (corpo: string) => {
	const chave = /Id="NFe([0-9A-Z]{44})"/.exec(corpo)?.[1];
	return envelope(
		`<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><retEnviNFe ${NS} versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>` +
			`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-11-16T19:00:00-03:00</dhRecbto><nProt>135260000000777</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe></nfeResultMsg>`,
	);
};

const transporte: Transport = {
	async transmit(request: TransmitRequest): Promise<TransportResult> {
		const corpo = new TextDecoder().decode(Uint8Array.from(atob(request.bodyB64 ?? ""), (ch) => ch.charCodeAt(0)));
		const servico = request.url.includes("NFeDistribuicaoDFe") ? "distribuicao" : request.url.includes("fazenda.gov.br/NFeRecepcaoEvento4") ? "evento" : "autorizacao";
		an.chamadas.push({ servico, url: request.url, corpo });
		if (an.fora) throw new TransportError(504, "tempo_esgotado", "Sem resposta do Ambiente Nacional.");
		const xml =
			servico === "distribuicao" ? await distribuir(corpo) : servico === "evento" ? (an.evento ?? ((c) => retEvento("135", "Evento registrado e vinculado a NF-e", c)))(corpo) : autorizada(corpo);
		let binario = "";
		for (const b of new TextEncoder().encode(xml)) binario += String.fromCharCode(b);
		return { status: 200, headers: {}, bodyB64: btoa(binario), tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" }, ms: 5 };
	},
};

const app = createApp(() => transporte, { fetch: async () => Response.json({ version: "0.0.1" }) });
const admin = async (method: string, path: string, body?: unknown) => {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const text = await res.text();
	return { status: res.status, json: ((res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : null) as Json, text, res };
};
let chaveApi: string;
async function cliente(method: string, path: string, body?: unknown, chave = chaveApi) {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${chave}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const text = new TextDecoder().decode(bytes);
	return { status: res.status, json: ((res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null) as Json, text, tipo: res.headers.get("content-type") };
}
const chamadas = (servico: Chamada["servico"]) => an.chamadas.filter((c) => c.servico === servico);
const configurar = (mudancas: Json = {}) => admin("PUT", "/admin/distribuicao", { ambiente: "homologacao", uf: "SP", consultaAutomatica: false, ...mudancas });
const sincronizar = () => cliente("POST", "/v1/distribuicao/sincronizar", { ambiente: "homologacao" });
const recebidas = async (query = "") => (await cliente("GET", `/v1/nfe-recebidas${query}`)).json;
/** Faz a espera exigida pelo Ambiente Nacional já ter passado. */
const vencerEspera = () => env.DB.prepare("UPDATE dfe_cursores SET next_at = 0").run();
const cursor = async () => (await cliente("GET", "/v1/distribuicao")).json.distribuicoes[0] as Json;

beforeEach(async () => {
	ajustes.esperaReciboMs = 0;
	Object.assign(an, { chamadas: [], fila: [], porChave: {}, fora: false, distribuicao: null, evento: null });
	await env.DB.batch(
		["emissions", "series", "inutilizacoes", "api_keys", "certificate", "settings", "audit", "documents", "dfe_cursores", "dfe_documentos", "recebidas"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
	);
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await app.request(`${COFRE}/admin/certificate`, { method: "POST", headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: form }, env);
	chaveApi = (await admin("POST", "/admin/chaves", { nome: "ERP de teste" })).json.chave.valor;
});

describe("distribuição de DF-e: notas recebidas", () => {
	it("exige a configuração, baixa os resumos e respeita a hora de espera", async () => {
		const [a, b] = [chaveDoFornecedor(101), chaveDoFornecedor(102)];
		const resumoDeA = resumo(a);
		an.fila = [
			{ nsu: 11, schema: "resNFe_v1.01.xsd", xml: resumoDeA },
			{ nsu: 12, schema: "resNFe_v1.01.xsd", xml: resumo(b, { valor: "80.00" }) },
			{ nsu: 13, schema: "procEventoNFe_v1.00.xsd", xml: cancelamento(b) },
		];
		expect((await sincronizar()).json.erro.codigo).toBe("distribuicao_nao_configurada");
		expect((await configurar()).json.distribuicao).toMatchObject({ cnpj: CNPJ_TESTE, ambiente: "homologacao", uf: "SP", consultaAutomatica: false, cienciaAutomatica: false, ultimoNsu: 0, proximaConsulta: null, bloqueada: false });

		const r = await sincronizar();
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ consultou: true, lotes: 1, documentos: 3, notasNovas: 2 });
		expect(r.json.distribuicao).toMatchObject({ ultimoNsu: 13, maiorNsu: 13, mensagem: { codigo: "138" }, bloqueada: false });
		expect(Date.parse(r.json.distribuicao.proximaConsulta) - Date.now()).toBeGreaterThan(60 * 60_000);
		expect(chamadas("distribuicao")).toHaveLength(1);
		expect(chamadas("distribuicao")[0]?.url).toBe("https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx");
		expect(chamadas("distribuicao")[0]?.corpo).toContain(`<tpAmb>2</tpAmb><cUFAutor>35</cUFAutor><CNPJ>${CNPJ_TESTE}</CNPJ><distNSU><ultNSU>000000000000000</ultNSU></distNSU>`);

		const lista = await recebidas();
		expect(lista.recebidas.map((n: Json) => [n.chaveAcesso, n.situacao, n.valor, n.xmlDisponivel])).toEqual([
			[a, "autorizada", 1520.75, false],
			[b, "cancelada", 80, false],
		]);
		expect(lista).toMatchObject({ haMais: false, ultimaSequencia: lista.recebidas[1].sequencia });
		expect(lista.recebidas[0]).toMatchObject({
			ambiente: "homologacao", cnpj: CNPJ_TESTE, papel: "destinatario", serie: 1, numero: 101, tipoOperacao: "saida", protocolo: "135260000001234",
			emitente: { documento: FORNECEDOR, nome: "Fornecedor de Teste Ltda", ie: "123456789012" }, manifestacao: null, manifestacoes: [],
		});
		// Só o resumo: ainda não há XML nem DANFE.
		expect((await cliente("GET", `/v1/nfe-recebidas/${lista.recebidas[0].id}/xml`)).json.erro.codigo).toBe("xml_indisponivel");
		expect((await cliente("GET", `/v1/nfe-recebidas/${lista.recebidas[0].id}/danfe`)).status).toBe(409);
		// A nota cancelada traz o evento que a cancelou.
		const cancelada = (await cliente("GET", `/v1/nfe-recebidas/${lista.recebidas[1].id}`)).json;
		expect(cancelada.eventos).toHaveLength(1);
		expect(cancelada.eventos[0]).toMatchObject({ tipo: "evento", nsu: 13, evento: { codigo: "110111", sequencia: 1, descricao: "Cancelamento", protocolo: "135260000009999", autor: FORNECEDOR } });

		// Dentro da hora de espera nada sai do cofre, por mais que o cliente peça.
		for (let i = 0; i < 3; i++) expect((await sincronizar()).json).toMatchObject({ consultou: false, documentos: 0 });
		expect(chamadas("distribuicao")).toHaveLength(1);

		// Leitura incremental: nada mudou depois da última sequência.
		expect((await recebidas(`?depois=${lista.ultimaSequencia}`)).recebidas).toEqual([]);
		expect((await recebidas(`?chaveAcesso=${b}`)).recebidas).toHaveLength(1);
		expect((await recebidas("?ambiente=producao")).recebidas).toEqual([]);
		expect((await cliente("GET", "/v1/nfe-recebidas?ambiente=teste")).status).toBe(400);
		expect((await app.request(`${COFRE}/v1/nfe-recebidas`, {}, env)).status).toBe(401);

		// O registro bruto dos documentos, com o XML de cada um.
		const docs = (await cliente("GET", "/v1/distribuicao/documentos")).json;
		expect(docs.documentos.map((d: Json) => [d.nsu, d.tipo, d.schema])).toEqual([[11, "resumo_nfe", "resNFe_v1.01.xsd"], [12, "resumo_nfe", "resNFe_v1.01.xsd"], [13, "evento", "procEventoNFe_v1.00.xsd"]]);
		expect((await cliente("GET", `/v1/distribuicao/documentos/${docs.documentos[0].sequencia}/xml`)).text).toBe(resumoDeA);
		expect((await cliente("GET", "/v1/distribuicao/documentos/999999/xml")).status).toBe(404);
	});

	it("continua do último NSU, em lotes de 50, e depois de 'nenhum documento' espera uma hora", async () => {
		an.fila = Array.from({ length: 120 }, (_, i) => ({ nsu: i + 1, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(1000 + i)) }));
		await configurar();
		const r = await sincronizar();
		expect(r.json).toMatchObject({ consultou: true, lotes: 3, documentos: 120, notasNovas: 120, distribuicao: { ultimoNsu: 120, maiorNsu: 120 } });
		expect(chamadas("distribuicao").map((c) => /<ultNSU>(\d+)</.exec(c.corpo)?.[1])).toEqual([nsu15(0), nsu15(50), nsu15(100)]);

		// Paginação da leitura pelo cliente.
		const p1 = await recebidas("?limite=100");
		expect([p1.recebidas.length, p1.haMais]).toEqual([100, true]);
		const p2 = await recebidas(`?limite=100&depois=${p1.ultimaSequencia}`);
		expect([p2.recebidas.length, p2.haMais]).toEqual([20, false]);

		// Hora vencida e nada novo: 137, e a espera recomeça.
		await vencerEspera();
		expect((await sincronizar()).json).toMatchObject({ consultou: true, documentos: 0, distribuicao: { ultimoNsu: 120, mensagem: { codigo: "137", descricao: "Nenhum documento localizado" } } });
		expect(chamadas("distribuicao")[3]?.corpo).toContain(`<ultNSU>${nsu15(120)}</ultNSU>`);
		expect((await sincronizar()).json.consultou).toBe(false);

		// Chega uma nota nova: a próxima consulta traz só ela, e quem lê pela sequência a vê.
		an.fila.push({ nsu: 121, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(5000)) });
		await vencerEspera();
		expect((await sincronizar()).json).toMatchObject({ documentos: 1, notasNovas: 1 });
		expect((await recebidas(`?depois=${p2.ultimaSequencia}`)).recebidas.map((n: Json) => n.numero)).toEqual([5000]);
	});

	it("o mesmo lote entregue duas vezes não duplica nada", async () => {
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(1)) }];
		await configurar();
		await sincronizar();
		await env.DB.prepare("UPDATE dfe_cursores SET next_at = 0, ult_nsu = 0").run();
		expect((await sincronizar()).json).toMatchObject({ consultou: true, documentos: 0, notasNovas: 0 });
		expect((await recebidas()).recebidas).toHaveLength(1);
		expect((await cliente("GET", "/v1/distribuicao/documentos")).json.documentos).toHaveLength(1);
	});

	it("consumo indevido (656) bloqueia tudo por uma hora e adota o NSU devolvido", async () => {
		await configurar();
		an.distribuicao = () => consumoIndevido(77);
		const r = (await sincronizar()).json;
		expect(r).toMatchObject({ consultou: true, documentos: 0, distribuicao: { bloqueada: true, ultimoNsu: 77, documentosARecuperar: 77, mensagem: { codigo: "656" } } });
		expect(Date.parse(r.distribuicao.proximaConsulta) - Date.now()).toBeGreaterThan(60 * 60_000);
		// Bloqueado: nem a consulta por chave sai.
		const porChave = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(1) });
		expect([porChave.status, porChave.json.erro.codigo]).toEqual([429, "consumo_indevido"]);
		expect(chamadas("distribuicao")).toHaveLength(1);
		expect((await admin("GET", "/admin/audit")).json.entries.some((e: Json) => e.action === "distribuicao.sequencia_adiantada" && e.detail.para === 77)).toBe(true);
	});

	it("outro sistema consultou na frente: segue do NSU devolvido e busca um a um o que ficou para trás", async () => {
		const [a, b, c, d] = [201, 202, 203, 204].map(chaveDoFornecedor) as [string, string, string, string];
		await configurar();
		an.fila = [{ nsu: 10, schema: "resNFe_v1.01.xsd", xml: resumo(a) }];
		expect((await sincronizar()).json.distribuicao).toMatchObject({ ultimoNsu: 10, documentosARecuperar: 0 });

		// O contador baixou até o NSU 13; a consulta do cofre, que ainda estava no 10, é recusada.
		// No intervalo, o cancelamento da nota B vem antes da própria nota.
		an.fila.push(
			{ nsu: 11, schema: "resNFe_v1.01.xsd", xml: resumo(b) },
			{ nsu: 12, schema: "procEventoNFe_v1.00.xsd", xml: cancelamento(c) },
			{ nsu: 13, schema: "resNFe_v1.01.xsd", xml: resumo(c) },
			{ nsu: 14, schema: "resNFe_v1.01.xsd", xml: resumo(d) },
		);
		const porSequencia = (corpo: string) => corpo.includes("<distNSU>");
		an.distribuicao = (corpo) => (porSequencia(corpo) ? consumoIndevido(13) : null);
		await vencerEspera();
		let r = (await sincronizar()).json;
		expect(r).toMatchObject({ consultou: true, documentos: 0, recuperados: 0, distribuicao: { bloqueada: true, ultimoNsu: 13, documentosARecuperar: 3 } });
		const registro = (await admin("GET", "/admin/audit")).json.entries.find((e: Json) => e.action === "distribuicao.sequencia_adiantada");
		expect(registro.detail).toMatchObject({ de: 10, para: 13, aRecuperar: 3, descartados: 0 });

		// Passado o bloqueio: primeiro os três que ficaram para trás, pelo NSU, depois a sequência.
		an.distribuicao = null;
		an.chamadas = [];
		await vencerEspera();
		r = (await sincronizar()).json;
		expect(r).toMatchObject({ consultou: true, lotes: 1, documentos: 4, recuperados: 3, notasNovas: 3 });
		expect(r.distribuicao).toMatchObject({ ultimoNsu: 14, documentosARecuperar: 0, bloqueada: false, consultasPorChave: { naUltimaHora: 3 } });
		expect(chamadas("distribuicao").map((ch) => /<(consNSU><NSU|distNSU><ultNSU)>0*(\d+)</.exec(ch.corpo)?.slice(1).join(" "))).toEqual([
			"consNSU><NSU 11", "consNSU><NSU 12", "consNSU><NSU 13", "distNSU><ultNSU 13",
		]);
		const lista = (await recebidas()).recebidas.map((n: Json) => [n.chaveAcesso, n.situacao]);
		// A nota C ficou cancelada, embora o cancelamento tenha chegado antes dela.
		expect(lista).toEqual([[a, "autorizada"], [b, "autorizada"], [c, "cancelada"], [d, "autorizada"]]);
		expect((await cliente("GET", "/v1/distribuicao/documentos")).json.documentos.map((doc: Json) => doc.nsu)).toEqual([10, 11, 12, 13, 14]);
	});

	it("a busca do que ficou para trás respeita a cota por hora e para se o Ambiente Nacional bloquear ou sumir", async () => {
		const [a, b, c] = [301, 302, 303].map(chaveDoFornecedor) as [string, string, string];
		await configurar();
		// O cofre nunca consultou; o outro sistema está no NSU 15. Só os NSU 3 e 5 ainda têm documento.
		an.fila = [
			{ nsu: 3, schema: "resNFe_v1.01.xsd", xml: resumo(a) },
			{ nsu: 5, schema: "resNFe_v1.01.xsd", xml: resumo(b) },
			{ nsu: 20, schema: "resNFe_v1.01.xsd", xml: resumo(c) },
		];
		const porSequencia = (corpo: string) => corpo.includes("<distNSU>");
		an.distribuicao = (corpo) => (porSequencia(corpo) ? consumoIndevido(15) : null);
		expect((await sincronizar()).json.distribuicao).toMatchObject({ ultimoNsu: 15, documentosARecuperar: 15, bloqueada: true });
		const enviados = (tag: string) => chamadas("distribuicao").filter((ch) => ch.corpo.includes(tag)).length;

		// Bloqueado, o agendador não toca em nada.
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(enviados("<consNSU>")).toBe(0);

		// Bloqueio vencido e consulta automática desligada: o agendador só busca o que ficou para
		// trás, 12 por hora, sem consultar a sequência.
		await vencerEspera();
		expect(await executarAgendado(env, transporte)).toEqual({ contingencia: null, recebidas: { documentos: 2, notasNovas: 2, cienciasRegistradas: 0 } });
		expect([enviados("<consNSU>"), enviados("<distNSU>")]).toEqual([12, 1]);
		expect(await cursor()).toMatchObject({ ultimoNsu: 15, documentosARecuperar: 3, proximaConsulta: null, consultasPorChave: { naUltimaHora: 12 } });
		expect(await executarAgendado(env, transporte)).toBeNull();

		// Na hora seguinte, o Ambiente Nacional não responde: o NSU fica na lista.
		await env.DB.prepare("UPDATE dfe_cursores SET pontuais = '[]'").run();
		an.fora = true;
		expect(await executarAgendado(env, transporte)).toMatchObject({ recebidas: { documentos: 0 } });
		expect(await cursor()).toMatchObject({ documentosARecuperar: 3, bloqueada: false, mensagem: { codigo: "tempo_esgotado" } });
		an.fora = false;

		// Depois, um bloqueio no meio da busca: para tudo por uma hora, e o NSU continua na lista.
		await vencerEspera();
		an.distribuicao = () => consumoIndevido();
		const bloqueada = (await sincronizar()).json;
		expect(bloqueada).toMatchObject({ documentos: 0, lotes: 0, distribuicao: { documentosARecuperar: 3, bloqueada: true, ultimoNsu: 15 } });

		// Por fim os NSU 13 a 15 não têm mais documento (137) e saem da lista; a sequência segue do 15.
		an.distribuicao = null;
		await vencerEspera();
		const fim = (await sincronizar()).json;
		expect(fim).toMatchObject({ documentos: 1, recuperados: 0, notasNovas: 1, distribuicao: { ultimoNsu: 20, documentosARecuperar: 0 } });
		expect((await recebidas()).recebidas.map((n: Json) => n.chaveAcesso)).toEqual([a, b, c]);
	});

	it("sem resposta ou serviço paralisado: tenta de novo em 15 minutos, sem mexer no NSU", async () => {
		await configurar();
		an.fora = true;
		let r = (await sincronizar()).json;
		expect(r).toMatchObject({ consultou: true, lotes: 0, distribuicao: { ultimoNsu: 0, bloqueada: false, mensagem: { codigo: "tempo_esgotado" } } });
		const espera = Date.parse(r.distribuicao.proximaConsulta) - Date.now();
		expect(espera).toBeGreaterThan(14 * 60_000);
		expect(espera).toBeLessThan(16 * 60_000);

		an.fora = false;
		an.distribuicao = () => retDist("<cStat>108</cStat><xMotivo>Servico Paralisado Momentaneamente (curto prazo)</xMotivo>");
		await vencerEspera();
		r = (await sincronizar()).json;
		expect(r.distribuicao.mensagem.codigo).toBe("108");
		expect(Date.parse(r.distribuicao.proximaConsulta) - Date.now()).toBeLessThan(16 * 60_000);
	});

	it("produção só com a trava liberada; chave de teste nunca toca a produção", async () => {
		expect((await configurar({ ambiente: "producao", consultaAutomatica: true })).json.error.code).toBe("producao_bloqueada");
		expect((await configurar({ ambiente: "producao" })).status).toBe(200);
		const bloqueado = await cliente("POST", "/v1/distribuicao/sincronizar", { ambiente: "producao" });
		expect([bloqueado.status, bloqueado.json.erro.codigo]).toEqual([422, "producao_bloqueada"]);
		const deTeste = (await admin("POST", "/admin/chaves", { nome: "teste", escopo: "homologacao" })).json.chave.valor;
		for (const [rota, corpo] of [
			["/v1/distribuicao/sincronizar", { ambiente: "producao" }],
			["/v1/distribuicao/consultar-chave", { ambiente: "producao", chaveAcesso: chaveDoFornecedor(1) }],
			["/v1/nfe-recebidas/manifestar", { ambiente: "producao", chaveAcesso: chaveDoFornecedor(1), tipo: "ciencia" }],
		] as const) {
			expect((await cliente("POST", rota, corpo, deTeste)).json.erro.codigo, rota).toBe("chave_somente_homologacao");
		}
		expect(an.chamadas).toHaveLength(0);
		// Filial de outra empresa não entra.
		expect((await configurar({ cnpj: "99888777000166" })).json.error.code).toBe("emitente_divergente");
	});
});

describe("manifestação do destinatário", () => {
	const preparar = async () => {
		const chave = chaveDoFornecedor(101);
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(chave) }];
		an.porChave[chave] = notaCompleta(chave);
		await configurar();
		await sincronizar();
		return { chave, id: (await recebidas()).recebidas[0].id as string };
	};

	it("a ciência assina o evento, manda ao Ambiente Nacional e já traz o XML completo", async () => {
		const { chave, id } = await preparar();
		const r = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ repetido: false, xmlDisponivel: true, papel: "destinatario", manifestacao: { tipo: "ciencia", sequencia: 1, protocolo: "891260000000555", justificativa: null, xmlDisponivel: true } });
		expect(r.json.manifestacao.origem).toMatch(/^chave:chv_/);

		const evento = chamadas("evento")[0] as Chamada;
		expect(evento.url).toBe("https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx");
		expect(evento.corpo).toContain(`<infEvento Id="ID210210${chave}01"><cOrgao>91</cOrgao><tpAmb>2</tpAmb><CNPJ>${CNPJ_TESTE}</CNPJ><chNFe>${chave}</chNFe>`);
		expect(evento.corpo).toContain('<tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento><Signature');
		// O XML veio pela consulta por chave, feita logo depois da ciência.
		expect(chamadas("distribuicao")[1]?.corpo).toContain(`<consChNFe><chNFe>${chave}</chNFe></consChNFe>`);
		expect((await cliente("GET", `/v1/nfe-recebidas/${id}/xml`)).text).toBe(notaCompleta(chave));
		const arquivado = (await cliente("GET", `/v1/nfe-recebidas/${id}/manifestacoes/ciencia/1/xml`)).text;
		expect(arquivado).toMatch(/^<procEventoNFe [^>]*versao="1.00"><evento /);
		expect(arquivado).toContain("<nProt>891260000000555</nProt>");
		expect((await cliente("GET", `/v1/nfe-recebidas/${id}/manifestacoes/confirmacao/1/xml`)).status).toBe(404);
		expect((await cursor()).consultasPorChave).toEqual({ naUltimaHora: 1, limite: 18 });

		// Repetir não envia nada; a ciência não cabe depois de outra manifestação.
		expect((await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" })).json).toMatchObject({ repetido: true });
		expect(chamadas("evento")).toHaveLength(1);
		expect((await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "confirmacao" })).json.manifestacao).toMatchObject({ tipo: "confirmacao", sequencia: 1 });
		const tardia = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect([tardia.status, tardia.json.erro.codigo]).toEqual([409, "manifestacao_ja_registrada"]);
	});

	it("manifestações conclusivas: retificação até duas vezes de cada tipo e justificativa na operação não realizada", async () => {
		const { chave, id } = await preparar();
		const manifestar = (corpo: Json) => cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, corpo);
		expect((await manifestar({ tipo: "nao_realizada" })).json.erro.codigo).toBe("justificativa_obrigatoria");
		expect((await manifestar({ tipo: "nao_realizada", justificativa: "curta" })).status).toBe(400);
		expect((await manifestar({ tipo: "devolucao" })).status).toBe(400);

		const justificativa = "Mercadoria recusada na entrega";
		expect((await manifestar({ tipo: "nao_realizada", justificativa })).json.manifestacao).toMatchObject({ tipo: "nao_realizada", sequencia: 1, justificativa });
		expect(chamadas("evento")[0]?.corpo).toContain(`<descEvento>Operacao nao Realizada</descEvento><xJust>${justificativa}</xJust>`);
		// Retificação: confirma, volta atrás, confirma de novo (sequência 2) e não há terceira.
		expect((await manifestar({ tipo: "confirmacao" })).json.manifestacao.sequencia).toBe(1);
		expect((await manifestar({ tipo: "desconhecimento" })).json.manifestacao.sequencia).toBe(1);
		expect((await manifestar({ tipo: "confirmacao" })).json.manifestacao.sequencia).toBe(2);
		expect(chamadas("evento")[3]?.corpo).toContain(`<infEvento Id="ID210200${chave}02">`);
		await manifestar({ tipo: "desconhecimento" });
		const terceira = await manifestar({ tipo: "confirmacao" });
		expect([terceira.status, terceira.json.erro.codigo]).toEqual([422, "limite_de_manifestacoes"]);
		const nota = (await cliente("GET", `/v1/nfe-recebidas/${id}`)).json;
		expect(nota.manifestacoes.map((m: Json) => `${m.tipo}:${m.sequencia}`)).toEqual(["nao_realizada:1", "confirmacao:1", "desconhecimento:1", "confirmacao:2", "desconhecimento:2"]);
		expect(nota.manifestacao.tipo).toBe("desconhecimento");
	});

	it("rejeição, duplicidade e falta de resposta do Ambiente Nacional", async () => {
		const { id } = await preparar();
		an.evento = (c) => retEvento("596", "Rejeicao: Evento apresentado fora do prazo: 10 dias", c);
		const rejeitada = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect([rejeitada.status, rejeitada.json.erro.codigo, rejeitada.json.mensagens[0].codigo]).toEqual([422, "manifestacao_rejeitada", "596"]);

		an.fora = true;
		const semResposta = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect([semResposta.status, semResposta.json.erro.codigo]).toEqual([502, "sem_resposta_conclusiva"]);
		an.fora = false;
		expect((await cliente("GET", `/v1/nfe-recebidas/${id}`)).json.manifestacoes).toEqual([]);

		// 573: a ciência já estava registrada (pelo portal, por exemplo). Fica anotada, sem XML.
		an.evento = (c) => retEvento("573", "Rejeicao: Duplicidade de Evento", c);
		const duplicada = (await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" })).json;
		expect(duplicada).toMatchObject({ repetido: true, manifestacao: { tipo: "ciencia", sequencia: 1, protocolo: null, xmlDisponivel: false } });
	});

	it("pela chave de acesso, mesmo de nota que o cofre ainda não recebeu", async () => {
		const chave = chaveDoFornecedor(900);
		const r = await cliente("POST", "/v1/nfe-recebidas/manifestar", { ambiente: "homologacao", chaveAcesso: chave, tipo: "confirmacao" });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ chaveAcesso: chave, cnpj: CNPJ_TESTE, situacao: null, xmlDisponivel: false, numero: 900, emitente: { documento: FORNECEDOR, nome: null }, manifestacao: { tipo: "confirmacao" } });
		// Sem a distribuição configurada, a data do evento sai no horário de Brasília.
		expect(chamadas("evento")[0]?.corpo).toMatch(/<dhEvento>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-03:00<\/dhEvento>/);
		expect(chamadas("distribuicao")).toHaveLength(0);
		// Quando o resumo chega, junta-se à mesma nota.
		an.fila = [{ nsu: 5, schema: "resNFe_v1.01.xsd", xml: resumo(chave) }];
		await configurar();
		expect((await sincronizar()).json).toMatchObject({ documentos: 1, notasNovas: 0 });
		expect((await recebidas()).recebidas).toHaveLength(1);
		expect((await recebidas()).recebidas[0]).toMatchObject({ id: r.json.id, situacao: "autorizada", valor: 1520.75, manifestacao: { tipo: "confirmacao" } });

		const invalida = await cliente("POST", "/v1/nfe-recebidas/manifestar", { ambiente: "homologacao", chaveAcesso: `${chave.slice(0, 43)}${chave[43] === "0" ? "1" : "0"}`, tipo: "ciencia" });
		expect([invalida.status, invalida.json.erro.codigo]).toEqual([422, "chave_de_acesso_invalida"]);
		const outraEmpresa = await cliente("POST", "/v1/nfe-recebidas/manifestar", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(901), tipo: "ciencia", cnpj: "99888777000166" });
		expect(outraEmpresa.json.erro.codigo).toBe("emitente_divergente");
	});
});

describe("consulta por chave e nota completa", () => {
	it("traz a nota de que o titular é terceiro, com XML e DANFE, e respeita o limite por hora", async () => {
		// Uma NF-e de verdade (emitida por este cofre em teste) faz o papel da nota de outra empresa.
		await admin("PUT", "/admin/series", { modelo: "nfe", ambiente: "homologacao", serie: 1 });
		const emitida = (await cliente("POST", "/v1/nfe", EXEMPLO_NFE)).json;
		expect(emitida.situacao).toBe("autorizada");
		const xml = (await cliente("GET", `/v1/nfe/${emitida.id}/xml`)).text;
		an.porChave[emitida.chaveAcesso] = xml;
		await configurar();

		const r = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: emitida.chaveAcesso });
		expect(r.status).toBe(200);
		// O destinatário da nota é outra empresa: o titular só tem acesso ao XML.
		expect(r.json).toMatchObject({ chaveAcesso: emitida.chaveAcesso, papel: "terceiro", xmlDisponivel: true, situacao: "autorizada", valor: 700, emitente: { documento: CNPJ_TESTE } });
		const danfe = await cliente("GET", `/v1/nfe-recebidas/${r.json.id}/danfe`);
		expect([danfe.status, danfe.tipo, danfe.text.slice(0, 5)]).toEqual([200, "application/pdf", "%PDF-"]);
		// Pedir de novo devolve a mesma nota, sem duplicar o documento.
		expect((await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: emitida.chaveAcesso })).json.id).toBe(r.json.id);
		expect((await cliente("GET", "/v1/distribuicao/documentos")).json.documentos).toHaveLength(1);
		// As notas recebidas não entram na lista de notas emitidas do painel.
		expect((await admin("GET", "/admin/notas")).json.notas.map((n: Json) => n.chaveAcesso)).toEqual([emitida.chaveAcesso]);

		const ausente = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(7) });
		expect([ausente.status, ausente.json.erro.codigo, ausente.json.mensagens[0].codigo]).toEqual([422, "nota_nao_localizada", "137"]);
		expect((await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: "123" })).status).toBe(400);

		// Limite: com 18 consultas na última hora, a 19ª nem sai do cofre.
		const agora = Date.now();
		await env.DB.prepare("UPDATE dfe_cursores SET pontuais = ?").bind(JSON.stringify(Array.from({ length: 18 }, (_, i) => agora - i * 1000))).run();
		const antes = chamadas("distribuicao").length;
		const limite = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(8) });
		expect([limite.status, limite.json.erro.codigo]).toEqual([429, "limite_de_consultas"]);
		expect(chamadas("distribuicao")).toHaveLength(antes);
	});
});

describe("agendador: consulta e ciência automáticas", () => {
	it("desligado não faz nada; ligado, consulta na hora certa e dá ciência só do que cabe", async () => {
		const [nova, antiga, cancelada] = [chaveDoFornecedor(1), chaveDoFornecedor(2), chaveDoFornecedor(3)];
		an.fila = [
			{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(nova) },
			{ nsu: 2, schema: "resNFe_v1.01.xsd", xml: resumo(antiga, { autorizadaEm: dataRecente(30) }) },
			{ nsu: 3, schema: "resNFe_v1.01.xsd", xml: resumo(cancelada, { situacao: "3" }) },
		];
		await configurar();
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(an.chamadas).toHaveLength(0);

		// Consulta automática, sem ciência: baixa e não manifesta.
		await configurar({ consultaAutomatica: true });
		expect(await executarAgendado(env, transporte)).toEqual({ contingencia: null, recebidas: { documentos: 3, notasNovas: 3, cienciasRegistradas: 0 } });
		expect(chamadas("evento")).toHaveLength(0);
		// Dentro da hora de espera o agendador nem abre o certificado.
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(chamadas("distribuicao")).toHaveLength(1);

		// Com a ciência automática ligada, ela sai para a nota nova: não para a antiga
		// (fora do prazo de 10 dias) nem para a cancelada.
		expect((await configurar({ consultaAutomatica: true, cienciaAutomatica: true })).json.distribuicao.cienciaAutomatica).toBe(true);
		expect(await executarAgendado(env, transporte)).toEqual({ contingencia: null, recebidas: { documentos: 0, notasNovas: 0, cienciasRegistradas: 1 } });
		expect(chamadas("evento")).toHaveLength(1);
		expect(chamadas("evento")[0]?.corpo).toContain(`<infEvento Id="ID210210${nova}01">`);
		const notas = (await recebidas()).recebidas as Json[];
		expect(notas.map((n) => [n.numero, n.manifestacao?.tipo ?? null, n.manifestacao?.origem ?? null])).toEqual([[2, null, null], [3, null, null], [1, "ciencia", "agendador"]]);
		// A ciência automática não gasta a cota de consultas por chave: o XML chega pela sequência.
		expect(chamadas("distribuicao")).toHaveLength(1);
		expect(await executarAgendado(env, transporte)).toBeNull();

		// Uma hora depois, o XML liberado pela ciência chega na sequência.
		an.fila.push({ nsu: 4, schema: "procNFe_v4.00.xsd", xml: notaCompleta(nova) });
		await vencerEspera();
		expect(await executarAgendado(env, transporte)).toMatchObject({ recebidas: { documentos: 1, notasNovas: 0, cienciasRegistradas: 0 } });
		expect((await recebidas(`?chaveAcesso=${nova}`)).recebidas[0]).toMatchObject({ xmlDisponivel: true, papel: "destinatario", manifestacao: { tipo: "ciencia" } });
	});

	it("a ciência recusada fica anotada e não é tentada de novo", async () => {
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(1)) }];
		an.evento = (c) => retEvento("650", "Rejeicao: Evento de Ciencia da Emissao para NF-e Cancelada ou Denegada", c);
		await configurar({ consultaAutomatica: true, cienciaAutomatica: true });
		expect(await executarAgendado(env, transporte)).toMatchObject({ recebidas: { documentos: 1, cienciasRegistradas: 0 } });
		expect((await recebidas()).recebidas[0]).toMatchObject({ manifestacao: null, cienciaAutomaticaRecusada: { codigo: "650" } });
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(chamadas("evento")).toHaveLength(1);
	});
});

describe("painel: notas recebidas", () => {
	it("mostra o estado, lista as notas, manifesta e baixa os arquivos", async () => {
		const chave = chaveDoFornecedor(101);
		const resumoDaNota = resumo(chave);
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumoDaNota }];
		an.porChave[chave] = notaCompleta(chave);
		expect((await admin("GET", "/admin/distribuicao")).json).toEqual({ distribuicoes: [], recebidas: [] });
		expect((await admin("POST", "/admin/distribuicao/sincronizar", { ambiente: "homologacao" })).json.error.code).toBe("distribuicao_nao_configurada");
		await configurar();
		expect((await admin("POST", "/admin/distribuicao/sincronizar", { ambiente: "homologacao" })).json).toMatchObject({ consultou: true, notasNovas: 1 });
		expect((await admin("GET", "/admin/distribuicao")).json.recebidas).toEqual([{ environment: "homologacao", total: 1, semXml: 1 }]);

		const nota = (await admin("GET", "/admin/recebidas")).json.recebidas[0];
		expect(nota).toMatchObject({ chaveAcesso: chave, xmlDisponivel: false });
		const resumoBaixado = await admin("GET", `/admin/recebidas/arquivo?id=${nota.id}`);
		expect([resumoBaixado.status, resumoBaixado.res.headers.get("content-disposition"), resumoBaixado.text]).toEqual([200, `attachment; filename="${chave}-resumo.xml"`, resumoDaNota]);
		expect((await admin("GET", `/admin/recebidas/arquivo?id=${nota.id}&tipo=danfe`)).json.error.code).toBe("xml_indisponivel");

		const m = await admin("POST", "/admin/recebidas/manifestar", { id: nota.id, tipo: "ciencia" });
		expect(m.json).toMatchObject({ repetido: false, recebida: { xmlDisponivel: true, manifestacao: { tipo: "ciencia", origem: "admin" } } });
		expect((await admin("GET", `/admin/recebidas/arquivo?id=${nota.id}`)).res.headers.get("content-disposition")).toBe(`attachment; filename="${chave}-nfe.xml"`);
		expect((await admin("POST", "/admin/recebidas/manifestar", { id: "rcb_nao_existe", tipo: "ciencia" })).status).toBe(404);
		expect((await app.request(`${COFRE}/admin/recebidas`, {}, env)).status).toBe(401);
	});
});

/** Lê um ZIP inteiro: nome e conteúdo de cada entrada, pelo diretório central. */
async function abrirZip(zip: Uint8Array): Promise<Record<string, string>> {
	const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const fim = zip.length - 22;
	const saida: Record<string, string> = {};
	let p = v.getUint32(fim + 16, true);
	for (let i = 0; i < v.getUint16(fim + 10, true); i++) {
		const [metodo, comprimido, tamanhoDoNome, local] = [v.getUint16(p + 10, true), v.getUint32(p + 20, true), v.getUint16(p + 28, true), v.getUint32(p + 42, true)];
		const nome = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + tamanhoDoNome));
		const inicio = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
		const corpo = zip.slice(inicio, inicio + comprimido);
		const dados = metodo === 8 ? await new Response(new Blob([corpo]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer() : corpo;
		saida[nome] = new TextDecoder().decode(dados);
		p += 46 + tamanhoDoNome;
	}
	return saida;
}

describe("relatórios e exportação por período", () => {
	const HOJE = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
	const TUDO = "ambiente=homologacao&de=2026-01-01&ate=2026-12-31";
	/** Duas NF-e emitidas e duas recebidas: uma com o XML completo, outra cancelada. */
	async function cenario() {
		await admin("PUT", "/admin/series", { modelo: "nfe", ambiente: "homologacao", serie: 1 });
		const a = (await cliente("POST", "/v1/nfe", EXEMPLO_NFE)).json;
		const b = (await cliente("POST", "/v1/nfe", { ...EXEMPLO_NFE, referencia: "pedido-1002", destinatario: { ...EXEMPLO_NFE.destinatario, cnpj: FORNECEDOR, nome: "Outra Empresa de Teste" } })).json;
		const [ra, rb] = [chaveDoFornecedor(101), chaveDoFornecedor(102)];
		an.fila = [
			{ nsu: 11, schema: "resNFe_v1.01.xsd", xml: resumo(ra) },
			{ nsu: 12, schema: "resNFe_v1.01.xsd", xml: resumo(rb, { valor: "80.00" }) },
			{ nsu: 13, schema: "procEventoNFe_v1.00.xsd", xml: cancelamento(rb) },
		];
		an.porChave[ra] = notaCompleta(ra);
		await configurar();
		await sincronizar();
		const recebidaA = (await admin("GET", `/admin/painel/recebidas?busca=${ra}`)).json.itens[0];
		await admin("POST", "/admin/recebidas/manifestar", { id: recebidaA.id, tipo: "ciencia" });
		return { a, b, ra, rb };
	}

	it("soma o período por situação, dia, CFOP, natureza e destinatário, com os impostos lidos dos XML", async () => {
		const { a, b } = await cenario();
		const r = await cliente("GET", `/v1/relatorios/notas?ambiente=homologacao&de=${HOJE}&ate=${HOJE}`);
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ ambiente: "homologacao", periodo: { de: HOJE, ate: HOJE }, notasPorLer: 0 });
		const e = r.json.emitidas;
		expect(e.porSituacao).toEqual([{ modelo: "nfe", situacao: "autorizada", quantidade: 2, valor: 1400 }]);
		expect(e.autorizadas).toMatchObject({ quantidade: 2, valor: 1400, impostos: { total: 1400, iss: 0 } });
		expect(e.autorizadas.impostos.produtos).toBeGreaterThan(0);
		expect(e.porDia).toEqual([{ dia: HOJE, quantidade: 2, valor: 1400 }]);
		expect(e.porCfop).toHaveLength(1);
		expect(e.porCfop[0]).toMatchObject({ cfop: EXEMPLO_NFE.itens[0]?.cfop, quantidade: 2 });
		expect(e.porNatureza).toEqual([{ natureza: EXEMPLO_NFE.naturezaOperacao, quantidade: 2, valor: 1400 }]);
		expect(e.porDestinatario.map((d: Json) => [d.documento, d.nome, d.quantidade, d.valor]).sort()).toEqual([["44555666000181", "Outra Empresa de Teste", 1, 700], ["99888777000166", "Cliente Ltda", 1, 700]]);
		// Recebidas: a cancelada não entra nos totais; só a que tem XML soma impostos.
		const todas = (await cliente("GET", `/v1/relatorios/notas?${TUDO}`)).json.recebidas;
		expect(todas.autorizadas).toMatchObject({ quantidade: 1, valor: 1520.75, comXml: 1, impostos: { total: 1520.75 } });
		expect(todas.porSituacao.map((s: Json) => [s.situacao, s.quantidade]).sort()).toEqual([["autorizada", 1], ["cancelada", 1]]);
		expect(todas.porEmitente).toEqual([{ documento: FORNECEDOR, nome: "Fornecedor de Teste Ltda", quantidade: 1, valor: 1520.75 }]);
		// O resumo fiscal fica guardado: a nota não é lida de novo.
		const guardado = await env.DB.prepare("SELECT fiscal FROM emissions WHERE id = ?").bind(a.id).first<{ fiscal: string }>();
		expect(JSON.parse(guardado?.fiscal ?? "{}")).toMatchObject({ natureza: EXEMPLO_NFE.naturezaOperacao, valores: { total: 700 } });

		// Período e ambiente.
		expect((await cliente("GET", "/v1/relatorios/notas?ambiente=producao&de=2026-01-01&ate=2026-12-31")).json.emitidas.autorizadas).toMatchObject({ quantidade: 0, valor: 0 });
		for (const q of ["ambiente=homologacao&de=2026-11-30&ate=2026-11-01", "ambiente=homologacao&de=2026-02-30&ate=2026-03-31", "ambiente=homologacao&de=2025-01-01&ate=2026-12-31", "de=2026-01-01&ate=2026-01-31", "ambiente=homologacao&de=hoje&ate=2026-01-31"]) {
			const invalido = await cliente("GET", `/v1/relatorios/notas?${q}`);
			expect([invalido.status, invalido.json.erro.codigo], q).toEqual([400, "requisicao_invalida"]);
		}
		// Chave só de homologação não lê a produção; o painel tem o mesmo relatório.
		const deTeste = (await admin("POST", "/admin/chaves", { nome: "Testes", escopo: "homologacao" })).json.chave.valor;
		expect((await cliente("GET", "/v1/relatorios/notas?ambiente=producao&de=2026-01-01&ate=2026-12-31", undefined, deTeste)).json.erro.codigo).toBe("chave_somente_homologacao");
		expect((await admin("GET", `/admin/painel/relatorio?${TUDO}`)).json.emitidas.autorizadas.quantidade).toBe(2);
		expect((await admin("GET", "/admin/painel/relatorio?ambiente=homologacao")).status).toBe(400);

		// A listagem unificada, para o sistema cliente.
		const notas = (await cliente("GET", "/v1/notas?busca=outra%20empresa&ambiente=homologacao")).json;
		expect(notas).toMatchObject({ total: 1, valor: 700, pagina: 1, porPagina: 50, notas: [{ id: b.id, modelo: "nfe", destinatario: { documento: FORNECEDOR } }] });
		expect((await cliente("GET", "/v1/notas?modelo=cte")).json.erro.codigo).toBe("requisicao_invalida");
		expect((await cliente("GET", "/v1/notas?de=ontem")).status).toBe(400);
	});

	it("exporta os XML do período num ZIP com a planilha, por link que expira", async () => {
		const { a, b, ra, rb } = await cenario();
		const criada = await cliente("POST", "/v1/exportacoes", { ambiente: "homologacao", de: "2026-01-01", ate: "2026-12-31" });
		expect(criada.status).toBe(201);
		const exp = criada.json;
		expect(exp).toMatchObject({
			ambiente: "homologacao", periodo: { de: "2026-01-01", ate: "2026-12-31" }, incluir: ["nfse", "nfe", "nfce", "eventos", "inutilizacoes", "recebidas"],
			situacao: "pronta", notasPorLer: 0, arquivos: 6, conteudo: { nfe: 2, recebidas: 2, manifestacoes: 1, eventosRecebidos: 1 },
			planilha: { nome: "resumo-2026-01-01-a-2026-12-31.xlsx" },
		});
		expect(exp.partes).toHaveLength(1);
		expect(exp.partes[0]).toMatchObject({ parte: 1, nome: "notas-2026-01-01-a-2026-12-31.zip" });
		expect(Date.parse(exp.linksValemAte) - Date.now()).toBeGreaterThan(25 * 60_000);
		expect(Date.parse(exp.expiraEm) - Date.now()).toBeGreaterThan(23 * 3_600_000);

		// O link baixa sem chave de API.
		const baixar = (url: string) => app.request(url, {}, env);
		const zip = await baixar(exp.partes[0].url);
		expect([zip.status, zip.headers.get("content-type"), zip.headers.get("content-disposition")]).toEqual([200, "application/zip", 'attachment; filename="notas-2026-01-01-a-2026-12-31.zip"']);
		const arquivos = await abrirZip(new Uint8Array(await zip.arrayBuffer()));
		expect(Object.keys(arquivos).sort()).toEqual(
			[
				`emitidas/nfe/${a.chaveAcesso}-nfe.xml`, `emitidas/nfe/${b.chaveAcesso}-nfe.xml`,
				`recebidas/${ra}-nfe.xml`, `recebidas/eventos/${rb}-evento-110111-01.xml`, `recebidas/manifestacoes/${ra}-manifestacao-210210-01.xml`, `recebidas/resumos/${rb}-resumo.xml`,
				"resumo-2026-01-01-a-2026-12-31.xlsx",
			].sort(),
		);
		expect(arquivos[`emitidas/nfe/${a.chaveAcesso}-nfe.xml`]).toBe((await cliente("GET", `/v1/nfe/${a.id}/xml`)).text);
		expect(arquivos[`recebidas/${ra}-nfe.xml`]).toBe(notaCompleta(ra));

		// A planilha, sozinha: duas abas, com a chave de acesso como texto.
		const planilha = await baixar(exp.planilha.url);
		expect([planilha.status, planilha.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="resumo-2026-01-01-a-2026-12-31.xlsx"']);
		const xlsx = await abrirZip(new Uint8Array(await planilha.arrayBuffer()));
		expect(xlsx["xl/workbook.xml"]).toContain('name="Emitidas"');
		expect(xlsx["xl/workbook.xml"]).toContain('name="Recebidas"');
		expect(xlsx["xl/worksheets/sheet1.xml"]).toContain(`<t xml:space="preserve">${a.chaveAcesso}</t>`);
		expect(xlsx["xl/worksheets/sheet1.xml"]).toContain('<t xml:space="preserve">Outra Empresa de Teste</t>');
		expect(xlsx["xl/worksheets/sheet1.xml"]).toContain('s="2"><v>700</v>');
		expect(xlsx["xl/worksheets/sheet2.xml"]).toContain(`<t xml:space="preserve">${rb}</t>`);
		expect(xlsx["xl/worksheets/sheet2.xml"]).toContain('<t xml:space="preserve">Ciência da operação</t>');

		// Link adulterado, de outro arquivo ou vencido não baixa nada.
		const url = new URL(exp.partes[0].url);
		const assinatura = url.searchParams.get("assinatura") ?? "";
		const com = (mudar: (u: URL) => void) => {
			const u = new URL(url);
			mudar(u);
			return baixar(u.toString());
		};
		expect((await com((u) => u.searchParams.set("assinatura", assinatura.replace(/.$/, assinatura.endsWith("0") ? "1" : "0")))).status).toBe(403);
		expect((await com((u) => u.searchParams.set("expira", String(Number(u.searchParams.get("expira")) + 60_000)))).status).toBe(403);
		expect((await com((u) => { u.pathname = u.pathname.replace("parte-1", "planilha"); })).status).toBe(403);
		expect((await com((u) => { u.pathname = u.pathname.replace("parte-1", "parte-2"); })).status).toBe(403);
		expect((await baixar(`${COFRE}/exportacoes/${exp.id}/parte-1`)).status).toBe(403);
		await env.DB.prepare("UPDATE exportacoes SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, exp.id).run();
		expect(await (await baixar(exp.partes[0].url)).json()).toMatchObject({ erro: { codigo: "link_invalido" } });
		expect((await cliente("GET", `/v1/exportacoes/${exp.id}`)).status).toBe(404);
	});

	it("exporta só o que foi pedido, consulta de novo e respeita o escopo da chave", async () => {
		const { a, b } = await cenario();
		const exp = (await cliente("POST", "/v1/exportacoes", { ambiente: "homologacao", de: HOJE, ate: HOJE, incluir: ["nfe"] })).json;
		expect(exp).toMatchObject({ situacao: "pronta", arquivos: 2, conteudo: { nfe: 2 }, incluir: ["nfe"] });
		const arquivos = await abrirZip(new Uint8Array(await (await app.request(exp.partes[0].url, {}, env)).arrayBuffer()));
		expect(Object.keys(arquivos).sort()).toEqual([`emitidas/nfe/${a.chaveAcesso}-nfe.xml`, `emitidas/nfe/${b.chaveAcesso}-nfe.xml`, `resumo-${HOJE}-a-${HOJE}.xlsx`].sort());

		// Consultar devolve a mesma exportação com links novos; a lista mostra as válidas.
		const denovo = (await cliente("GET", `/v1/exportacoes/${exp.id}`)).json;
		expect(denovo).toMatchObject({ id: exp.id, situacao: "pronta", arquivos: 2 });
		expect((await app.request(denovo.planilha.url, {}, env)).status).toBe(200);
		expect((await cliente("GET", "/v1/exportacoes")).json.exportacoes.map((e: Json) => e.id)).toEqual([exp.id]);

		// Período sem nada: pronta, sem partes, só a planilha.
		const vazia = (await cliente("POST", "/v1/exportacoes", { ambiente: "homologacao", de: "2020-01-01", ate: "2020-01-31" })).json;
		expect(vazia).toMatchObject({ situacao: "pronta", arquivos: 0, partes: [] });
		expect((await app.request(vazia.planilha.url, {}, env)).status).toBe(200);

		// Pedido inválido e chave só de homologação.
		for (const pedido of [{ ambiente: "homologacao", de: HOJE }, { ambiente: "homologacao", de: HOJE, ate: HOJE, incluir: ["cte"] }, { ambiente: "homologacao", de: HOJE, ate: HOJE, incluir: [] }]) {
			expect((await cliente("POST", "/v1/exportacoes", pedido)).json.erro.codigo).toBe("requisicao_invalida");
		}
		const deTeste = (await admin("POST", "/admin/chaves", { nome: "Testes", escopo: "homologacao" })).json.chave.valor;
		expect((await cliente("POST", "/v1/exportacoes", { ambiente: "producao", de: HOJE, ate: HOJE }, deTeste)).json.erro.codigo).toBe("chave_somente_homologacao");
		expect((await cliente("GET", "/v1/exportacoes/exp_nao_existe")).status).toBe(404);

		// O painel cria e consulta pela rota dele.
		const doPainel = (await admin("POST", "/admin/painel/exportacoes", { ambiente: "homologacao", de: HOJE, ate: HOJE, incluir: ["recebidas"] })).json;
		expect(doPainel).toMatchObject({ situacao: "pronta", incluir: ["recebidas"] });
		expect((await admin("GET", `/admin/painel/exportacoes/${doPainel.id}`)).json.id).toBe(doPainel.id);
		expect((await admin("POST", "/admin/painel/exportacoes", { ambiente: "homologacao" })).status).toBe(400);
	});

	it("enquanto houver XML por ler, a exportação fica preparando e avança a cada consulta", async () => {
		const { a } = await cenario();
		const { completarFiscal } = await import("../src/relatorios");
		const periodo = { de: "2026-01-01", ate: "2026-12-31", environment: "homologacao" as const };
		// Três notas com XML (duas emitidas e uma recebida): uma por chamada.
		expect(await completarFiscal(env, periodo, 1)).toBe(2);
		expect(await completarFiscal(env, periodo, 1)).toBe(1);
		expect(await completarFiscal(env, periodo, 1)).toBe(0);
		// XML que sumiu do cofre: a nota fica marcada e não trava a exportação.
		await env.DB.prepare("UPDATE emissions SET fiscal = NULL, document_key = 'nfe/sumiu.xml' WHERE id = ?").bind(a.id).run();
		expect(await completarFiscal(env, periodo, 10)).toBe(0);
		expect((await env.DB.prepare("SELECT fiscal FROM emissions WHERE id = ?").bind(a.id).first<{ fiscal: string }>())?.fiscal).toBe("{}");
	});
});

describe("painel: visão geral, listagens e detalhe", () => {
	it("lista as notas emitidas com filtros, mostra o detalhe e soma o período", async () => {
		await admin("PUT", "/admin/series", { modelo: "nfe", ambiente: "homologacao", serie: 1 });
		const a = (await cliente("POST", "/v1/nfe", EXEMPLO_NFE)).json;
		const b = (await cliente("POST", "/v1/nfe", { ...EXEMPLO_NFE, referencia: "pedido-1002", destinatario: { ...EXEMPLO_NFE.destinatario, cnpj: FORNECEDOR, nome: "Outra Empresa de Teste" } })).json;
		expect([a.situacao, b.situacao]).toEqual(["autorizada", "autorizada"]);
		const emitidas = async (query = "") => (await admin("GET", `/admin/painel/emitidas${query}`)).json;
		const ids = async (query: string) => (await emitidas(query)).itens.map((n: Json) => n.id);

		const lista = await emitidas();
		expect(lista).toMatchObject({ total: 2, valor: 1400, pagina: 1, porPagina: 25, resumosPendentes: 0 });
		expect(lista.itens.map((n: Json) => [n.id, n.modelo, n.numero, n.situacao, n.valor, n.destinatario.documento, n.destinatario.nome, n.chaveAcesso])).toEqual([
			[b.id, "nfe", String(b.numero), "autorizada", 700, FORNECEDOR, "Outra Empresa de Teste", b.chaveAcesso],
			[a.id, "nfe", String(a.numero), "autorizada", 700, "99888777000166", "Cliente Ltda", a.chaveAcesso],
		]);

		// Busca: nome, documento com pontuação, número da nota, chave de acesso e referência.
		expect(await ids("?busca=outra%20empresa")).toEqual([b.id]);
		expect(await ids("?busca=99.888.777%2F0001-66")).toEqual([a.id]);
		expect(await ids(`?busca=${a.numero}`)).toEqual([a.id]);
		expect(await ids(`?busca=${b.chaveAcesso}`)).toEqual([b.id]);
		expect(await ids("?busca=pedido-1002")).toEqual([b.id]);
		expect(await ids("?busca=ninguem")).toEqual([]);
		// Filtros de situação, documento, ambiente e período.
		expect(await ids("?situacao=autorizada&modelo=nfe&ambiente=homologacao")).toHaveLength(2);
		for (const q of ["?situacao=cancelada", "?modelo=nfce", "?ambiente=producao", "?de=2999-01-01", "?ate=2000-01-01"]) expect(await ids(q), q).toEqual([]);
		// Paginação.
		expect(await emitidas("?porPagina=1&pagina=2")).toMatchObject({ total: 2, valor: 1400, pagina: 2, porPagina: 1, itens: [{ id: a.id }] });

		const detalhe = (await admin("GET", `/admin/painel/emitidas/${a.id}`)).json;
		expect(detalhe.nota).toMatchObject({ id: a.id, chaveAcesso: a.chaveAcesso, protocolo: a.protocolo, situacao: "autorizada", cartasCorrecao: 0, destinatario: { nome: "Cliente Ltda" }, mensagens: a.mensagens });
		expect(detalhe.arquivos.map((x: Json) => x.tipo)).toEqual(["nfe"]);
		expect((await admin("GET", `/admin/notas/arquivo?key=${encodeURIComponent(detalhe.arquivos[0].key)}`)).text).toContain(a.chaveAcesso);
		expect((await admin("GET", "/admin/painel/emitidas/nfe_nao_existe")).status).toBe(404);

		// Visão geral: sem ambiente informado, vale o que o cofre pode emitir (produção bloqueada).
		const resumoGeral = (await admin("GET", "/admin/painel/resumo")).json;
		expect(resumoGeral).toMatchObject({
			ambiente: "homologacao", producaoLiberada: false, contingenciaPendente: 0, resumosPendentes: 0,
			certificado: { holder: { id: CNPJ_TESTE } },
			emitidas: { autorizadas: { quantidade: 2, valor: 1400 }, canceladas: { quantidade: 0 }, naoAutorizadas: { quantidade: 0 }, pendentes: { quantidade: 0 } },
			recebidas: { quantidade: 0, semXml: 0 },
		});
		expect(resumoGeral.emitidas.porModelo).toEqual([{ modelo: "nfe", situacao: "autorizada", quantidade: 2, valor: 1400 }]);
		expect(resumoGeral.emitidas.porDia).toEqual([{ dia: lista.itens[0].emitidaEm.slice(0, 10), quantidade: 2, valor: 1400 }]);
		expect((await admin("GET", "/admin/painel/resumo?ambiente=producao")).json.emitidas.autorizadas).toEqual({ quantidade: 0, valor: 0 });
		expect((await admin("GET", "/admin/painel/resumo?de=2000-01-01&ate=2000-01-31")).json).toMatchObject({ periodo: { de: "2000-01-01", ate: "2000-01-31" }, emitidas: { autorizadas: { quantidade: 0 } } });
		expect((await app.request(`${COFRE}/admin/painel/resumo`, {}, env)).status).toBe(401);

		// Nota anterior ao painel (sem o destinatário gravado): o cofre o lê do XML arquivado.
		await env.DB.prepare("UPDATE emissions SET summarized = 0, recipient_doc = NULL, recipient_name = NULL WHERE id = ?").bind(a.id).run();
		const depois = await emitidas();
		expect(depois.resumosPendentes).toBe(0);
		expect(depois.itens.find((n: Json) => n.id === a.id).destinatario.documento).toBe("99888777000166");
	});

	it("a migração preenche a data, o dia e o valor das notas que já existiam", async () => {
		// Notas como as versões anteriores as gravavam: sem as colunas do painel.
		const criada = Date.UTC(2026, 10, 16, 1, 30); // 15/11, 22:30 em Brasília
		const inserir = (id: string, kind: string, numero: number, status: string, extra: Json, documentKey: string | null) =>
			env.DB.prepare(
				`INSERT INTO emissions (id, doc_id, kind, environment, serie, number, document_id, status, extra, document_key, created_at, updated_at)
				 VALUES (?, ?, ?, 'producao', '1', ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(id, CNPJ_TESTE, kind, numero, id, status, JSON.stringify(extra), documentKey, criada, criada)
				.run();
		await inserir("nfe_antiga", "nfe", 1, "autorizada", { emitidaEm: "2026-11-10T23:30:00-03:00", valor: 700 }, null);
		await inserir("nfs_antiga", "nfse", 2, "autorizada", {}, "nfse/producao/2026/11/antiga-nfse.xml");
		await inserir("nfe_recusada", "nfe", 3, "rejeitada", {}, null);
		await env.DB.prepare("INSERT INTO documents (key, content_type, size, sha256, meta, created_at) VALUES (?, 'application/xml', 1, 'x', ?, ?)")
			.bind("nfse/producao/2026/11/antiga-nfse.xml", JSON.stringify({ tipo: "nfse", valor: 1500, emitidaEm: "2026-11-16T01:30:00.000Z" }), criada)
			.run();

		const migracao = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0007"));
		const preenchimentos = (migracao?.queries ?? []).filter((q) => q.includes("UPDATE emissions"));
		expect(preenchimentos).toHaveLength(3);
		for (const q of preenchimentos) await env.DB.prepare(q).run();

		const { results } = await env.DB.prepare("SELECT id, issued_at, issued_day, value FROM emissions ORDER BY number").all();
		expect(results).toEqual([
			{ id: "nfe_antiga", issued_at: "2026-11-10T23:30:00-03:00", issued_day: "2026-11-10", value: 700 },
			// Data em UTC: o dia é o de Brasília.
			{ id: "nfs_antiga", issued_at: "2026-11-16T01:30:00.000Z", issued_day: "2026-11-15", value: 1500 },
			{ id: "nfe_recusada", issued_at: null, issued_day: "2026-11-15", value: null },
		]);
		// E o painel as encontra pelo período.
		const noDia = (await admin("GET", "/admin/painel/emitidas?de=2026-11-15&ate=2026-11-15&ambiente=producao")).json;
		expect(noDia.itens.map((n: Json) => [n.id, n.numero, n.numeroDps, n.situacao])).toEqual([["nfe_recusada", "3", null, "rejeitada"], ["nfs_antiga", null, 2, "autorizada"]]);
		expect(noDia.resumosPendentes).toBe(0);
	});

	it("a migração registra as NFS-e que o cofre só tinha como arquivo", async () => {
		// Como a API central antiga arquivava: a nota, a DPS e o evento, com os dados nos metadados.
		const chave = (numero: number) => `353870922${CNPJ_TESTE}${String(numero).padStart(13, "0")}26111234567890`;
		const emitida = "2026-11-16T17:00:00.000Z";
		const criada = Date.parse(emitida);
		const arquivar = (key: string, meta: Json) =>
			env.DB.prepare("INSERT INTO documents (key, content_type, size, sha256, meta, created_at) VALUES (?, 'application/xml', 1, 'x', ?, ?)").bind(key, JSON.stringify(meta), criada).run();
		for (const [dps, numero] of [[1, 5], [2, 6]] as const) {
			const base = `nfse/producao/2026/11/${chave(numero)}`;
			const meta = { tipo: "nfse", chaveAcesso: chave(numero), emissao: `nfs_central_${dps}`, ambiente: "producao", serie: "900", numeroDps: dps, numeroNfse: String(numero), valor: 1, emitidaEm: emitida };
			await arquivar(`${base}-nfse.xml`, meta);
			await arquivar(`${base}-dps.xml`, { ...meta, tipo: "dps" });
		}
		await arquivar(`nfse/producao/2026/11/${chave(6)}-cancelamento.xml`, { tipo: "cancelamento", chaveAcesso: chave(6), canceladaEm: emitida });
		await env.DOCS.put(
			`docs/nfse/producao/2026/11/${chave(5)}-nfse.xml`,
			`<NFSe><infNFSe Id="NFS${chave(5)}"><DPS><infDPS><toma><CNPJ>99888777000166</CNPJ><xNome>Cliente Ltda</xNome></toma></infDPS></DPS></infNFSe></NFSe>`,
		);
		expect((await admin("GET", "/admin/painel/emitidas?ambiente=producao")).json.total).toBe(0);

		const migracao = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009"));
		expect(migracao?.queries).toHaveLength(2);
		// Rodar duas vezes não duplica as notas.
		for (let vez = 0; vez < 2; vez++) for (const q of migracao?.queries ?? []) await env.DB.prepare(q).run();

		const { results } = await env.DB.prepare("SELECT doc_id, serie, number, document_id, status, fiscal_number, issued_day, value FROM emissions WHERE kind = 'nfse' ORDER BY number").all();
		expect(results).toEqual([
			{ doc_id: CNPJ_TESTE, serie: "900", number: 1, document_id: `DPS35387092${CNPJ_TESTE}00900000000000000001`, status: "autorizada", fiscal_number: "5", issued_day: "2026-11-16", value: 1 },
			{ doc_id: CNPJ_TESTE, serie: "900", number: 2, document_id: `DPS35387092${CNPJ_TESTE}00900000000000000002`, status: "cancelada", fiscal_number: "6", issued_day: "2026-11-16", value: 1 },
		]);
		// A série não repete as DPS já usadas.
		expect(await env.DB.prepare("SELECT last_number FROM series WHERE kind = 'nfse' AND environment = 'producao' AND serie = '900'").first()).toEqual({ last_number: 2 });

		// O painel as lista, com o tomador lido do XML, e mostra os arquivos no detalhe.
		const lista = (await admin("GET", "/admin/painel/emitidas?ambiente=producao&modelo=nfse&de=2026-11-16&ate=2026-11-16")).json;
		expect(lista).toMatchObject({ total: 2, valor: 2, resumosPendentes: 0 });
		expect(lista.itens.map((n: Json) => [n.numero, n.numeroDps, n.situacao, n.chaveAcesso, n.destinatario?.nome ?? null])).toEqual([
			["6", 2, "cancelada", chave(6), null],
			["5", 1, "autorizada", chave(5), "Cliente Ltda"],
		]);
		const detalhe = (await admin("GET", `/admin/painel/emitidas/${lista.itens[0].id}`)).json;
		expect(detalhe.arquivos.map((x: Json) => x.tipo)).toEqual(["nfse", "dps", "cancelamento"]);
	});

	it("lista as notas recebidas com filtros e mostra os eventos no detalhe", async () => {
		const [a, b] = [chaveDoFornecedor(101), chaveDoFornecedor(102)];
		an.fila = [
			{ nsu: 11, schema: "resNFe_v1.01.xsd", xml: resumo(a) },
			{ nsu: 12, schema: "resNFe_v1.01.xsd", xml: resumo(b, { valor: "80.00" }) },
			{ nsu: 13, schema: "procEventoNFe_v1.00.xsd", xml: cancelamento(b) },
		];
		an.porChave[a] = notaCompleta(a);
		await configurar();
		await sincronizar();
		const notas = async (query = "") => (await admin("GET", `/admin/painel/recebidas${query}`)).json;
		const chaves = async (query: string) => (await notas(query)).itens.map((n: Json) => n.chaveAcesso);

		expect(await notas()).toMatchObject({ total: 2, valor: 1600.75, semXml: 2, pagina: 1 });
		expect(await chaves("?busca=fornecedor%20de%20teste")).toHaveLength(2);
		expect(await chaves("?busca=102")).toEqual([b]);
		expect(await chaves(`?busca=${a}`)).toEqual([a]);
		expect(await chaves(`?busca=${FORNECEDOR}`)).toHaveLength(2);
		expect(await chaves("?situacao=cancelada")).toEqual([b]);
		expect(await chaves("?xml=completo")).toEqual([]);
		expect(await chaves("?ambiente=producao")).toEqual([]);
		expect(await chaves("?ate=2000-01-01")).toEqual([]);

		// Depois da ciência a nota A fica com o XML completo.
		const notaA = (await notas(`?busca=${a}`)).itens[0];
		await admin("POST", "/admin/recebidas/manifestar", { id: notaA.id, tipo: "ciencia" });
		expect(await chaves("?xml=completo")).toEqual([a]);
		expect(await chaves("?xml=resumo")).toEqual([b]);

		const notaB = (await notas(`?busca=${b}`)).itens[0];
		const detalhe = (await admin("GET", `/admin/painel/recebidas/${notaB.id}`)).json;
		expect(detalhe.nota).toMatchObject({ chaveAcesso: b, situacao: "cancelada" });
		expect(detalhe.eventos).toEqual([{ codigo: "110111", sequencia: 1, descricao: "Cancelamento", registradoEm: "2026-11-11T08:00:00-03:00", protocolo: "135260000009999", autor: FORNECEDOR }]);
		expect((await admin("GET", "/admin/painel/recebidas/rcb_nao_existe")).status).toBe(404);
		// A visão geral conta as recebidas do período.
		expect((await admin("GET", "/admin/painel/resumo?de=2000-01-01&ate=2999-12-31")).json.recebidas).toMatchObject({ quantidade: 2, semXml: 1 });
	});
});
