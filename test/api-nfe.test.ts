import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { EXEMPLO_NFCE, EXEMPLO_NFE } from "../src/contrato-exemplos";
import { ajustes } from "../src/emissao/nfe";
import type { TransmitRequest } from "../src/protocol";
import { type Transport, TransportError, type TransportResult } from "../src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "./helpers";

const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
const SP = "https://homologacao.nfe.fazenda.sp.gov.br/ws";
type Json = Record<string, any>;
type Chamada = { servico: string; url: string; corpo: string; acao: string };

// ---------- SEFAZ simulada atrás do transporte mTLS ----------

const soap = (xml: string) =>
	`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>` +
	`<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">${xml}</nfeResultMsg></soap:Body></soap:Envelope>`;
const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const chaveDe = (corpo: string) => /Id="NFe([0-9A-Z]{44})"/.exec(corpo)?.[1] ?? /<chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(corpo)?.[1] ?? "";
const protocolo = (chave: string, cStat = "100", xMotivo = "Autorizado o uso da NF-e") =>
	`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><chNFe>${chave}</chNFe>` +
	`<dhRecbto>2026-11-16T12:31:00-03:00</dhRecbto><nProt>135260000000777</nProt><digVal>abc=</digVal><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo></infProt></protNFe>`;
const lote = (conteudo: string, cStat = "104") => soap(`<retEnviNFe ${NS} versao="4.00"><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>Lote processado</xMotivo>${conteudo}</retEnviNFe>`);
const rejeicao = (cStat: string, xMotivo: string) => (c: Chamada) => lote(protocolo(chaveDe(c.corpo), cStat, xMotivo));

const respostas: Record<string, (c: Chamada) => string> = {};
const padrao: Record<string, (c: Chamada) => string> = {
	autorizacao: (c) => lote(protocolo(chaveDe(c.corpo))),
	retautorizacao: (c) => soap(`<retConsReciNFe ${NS} versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>${protocolo(sefaz.ultimaChave)}</retConsReciNFe>`),
	consulta: (c) => soap(`<retConsSitNFe ${NS} versao="4.00"><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><chNFe>${chaveDe(c.corpo)}</chNFe>${protocolo(chaveDe(c.corpo))}</retConsSitNFe>`),
	evento: (c) =>
		soap(
			`<retEnvEvento ${NS} versao="1.00"><idLote>1</idLote><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>` +
				`<retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${chaveDe(c.corpo)}</chNFe><nProt>135260000000888</nProt></infEvento></retEvento></retEnvEvento>`,
		),
	inutilizacao: () => soap(`<retInutNFe ${NS} versao="4.00"><infInut><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><nProt>135260000000999</nProt></infInut></retInutNFe>`),
	status: () => soap(`<retConsStatServ ${NS} versao="4.00"><tpAmb>2</tpAmb><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><tMed>1</tMed></retConsStatServ>`),
};

const sefaz = { chamadas: [] as Chamada[], ultimaChave: "", falhar: null as null | ((c: Chamada) => void) };
const servicoDe = (url: string) => {
	const fim = (url.split("/").pop() ?? "").toLowerCase();
	if (fim.includes("retautorizacao")) return "retautorizacao";
	if (fim.includes("autorizacao")) return "autorizacao";
	if (fim.includes("consulta")) return "consulta";
	if (fim.includes("evento")) return "evento";
	if (fim.includes("inutilizacao")) return "inutilizacao";
	return "status";
};

const transporte: Transport = {
	async transmit(request: TransmitRequest): Promise<TransportResult> {
		const corpo = new TextDecoder().decode(Uint8Array.from(atob(request.bodyB64 ?? ""), (ch) => ch.charCodeAt(0)));
		const chamada = { servico: servicoDe(request.url), url: request.url, corpo, acao: request.headers?.["content-type"] ?? "" };
		sefaz.chamadas.push(chamada);
		if (chamada.servico === "autorizacao") sefaz.ultimaChave = chaveDe(corpo);
		sefaz.falhar?.(chamada);
		const xml = (respostas[chamada.servico] ?? (padrao[chamada.servico] as (c: Chamada) => string))(chamada);
		const bytes = new TextEncoder().encode(xml);
		let binario = "";
		for (const b of bytes) binario += String.fromCharCode(b);
		return { status: 200, headers: {}, bodyB64: btoa(binario), tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" }, ms: 5 };
	},
};

const app = createApp(() => transporte, { fetch: async () => Response.json({ version: "99.0.0" }) });

const admin = async (method: string, path: string, body?: unknown) => {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	return { status: res.status, json: (await res.json()) as Json };
};

async function cliente(method: string, path: string, body?: unknown, chave = chaveApi) {
	const headers: Record<string, string> = { authorization: `Bearer ${chave}` };
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await app.request(COFRE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const text = await res.text();
	return { status: res.status, json: ((res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null) as Json, text };
}

let chaveApi: string;
const serie = (dados: Json = {}) => admin("PUT", "/admin/series", { modelo: "nfe", ambiente: "homologacao", serie: 1, ...dados });
const proximo = async (modelo = "nfe") => ((await cliente("GET", "/v1/series")).json.series as Json[]).find((s) => s.modelo === modelo)?.proximoNumero;
const emitir = (mudancas: Json = {}) => cliente("POST", "/v1/nfe", { ...EXEMPLO_NFE, ...mudancas });
const chamadas = (servico: string) => sefaz.chamadas.filter((c) => c.servico === servico);
const documentos = async () => ((await env.DB.prepare("SELECT key FROM documents ORDER BY key").all()).results as { key: string }[]).map((d) => d.key.split("/").pop());

beforeEach(async () => {
	ajustes.esperaReciboMs = 0;
	sefaz.chamadas = [];
	sefaz.falhar = null;
	for (const k of Object.keys(respostas)) delete respostas[k];
	await env.DB.batch(
		["emissions", "series", "inutilizacoes", "api_keys", "certificate", "settings", "audit", "documents"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
	);
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await app.request(`${COFRE}/admin/certificate`, { method: "POST", headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: form }, env);
	chaveApi = (await admin("POST", "/admin/chaves", { nome: "ERP de teste" })).json.chave.valor;
});

describe("NF-e pelo cofre", () => {
	it("só emite em série cadastrada, e a série começa no número informado", async () => {
		const semSerie = await emitir();
		expect(semSerie.status).toBe(422);
		expect(semSerie.json.erro.codigo).toBe("serie_nao_cadastrada");
		expect(sefaz.chamadas).toHaveLength(0);

		expect((await serie({ proximoNumero: 100, descricao: "Matriz" })).json.serie).toMatchObject({ modelo: "nfe", serie: 1, proximoNumero: 100, descricao: "Matriz", cnpj: CNPJ_TESTE });
		const { status, json } = await emitir();
		expect(status).toBe(201);
		expect(json).toMatchObject({
			modelo: "nfe", ambiente: "homologacao", referencia: "pedido-1001", serie: 1, numero: 100, situacao: "autorizada",
			protocolo: "135260000000777", valor: 700, xmlDisponivel: true, mensagens: [{ codigo: "100", descricao: "Autorizado o uso da NF-e" }],
		});
		expect(json.chaveAcesso).toMatch(new RegExp(`^35\\d{4}${CNPJ_TESTE}55001000000100`));
		// As datas que o DANFE imprime: a de emissão (do XML) e a de autorização (da SEFAZ).
		expect(json.emitidaEm).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/);
		expect(json.autorizadaEm).toBe("2026-11-16T12:31:00-03:00");
		expect(await proximo()).toBe(101);

		// Uma única chamada, síncrona, ao autorizador de SP.
		expect(sefaz.chamadas).toHaveLength(1);
		const envio = sefaz.chamadas[0] as Chamada;
		expect(envio.url).toBe(`${SP}/nfeautorizacao4.asmx`);
		expect(envio.acao).toContain('action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote"');
		expect(envio.corpo).toContain("<indSinc>1</indSinc><NFe ");
		expect(envio.corpo).toContain("<nNF>100</nNF>");
		expect(envio.corpo).toMatch(/<\/infNFe><Signature /);

		// O arquivo é a nota com o protocolo; a cópia de trabalho não fica para trás.
		const xml = await cliente("GET", `/v1/nfe/${json.id}/xml`);
		expect(xml.text).toMatch(/^<nfeProc xmlns="http:\/\/www\.portalfiscal\.inf\.br\/nfe" versao="4\.00"><NFe /);
		expect(xml.text).toContain("<nProt>135260000000777</nProt>");
		expect(await documentos()).toEqual([`${json.chaveAcesso}-nfe.xml`]);

		// A nota aparece no painel do emitente.
		const nota = (await admin("GET", "/admin/notas")).json.notas[0];
		expect(nota).toMatchObject({ modelo: "nfe", chaveAcesso: json.chaveAcesso, numeroNfse: "100", serie: "1", valor: 700, situacao: "autorizada" });
		expect((await cliente("GET", "/v1/nfe?referencia=pedido-1001")).json.nfe).toHaveLength(1);
		// A referência é única por ambiente: a pesquisa aceita o filtro.
		expect((await cliente("GET", "/v1/nfe?referencia=pedido-1001&ambiente=homologacao")).json.nfe).toHaveLength(1);
		expect((await cliente("GET", "/v1/nfe?referencia=pedido-1001&ambiente=producao")).json.nfe).toHaveLength(0);
		expect((await cliente("GET", "/v1/nfe?ambiente=teste")).status).toBe(400);
		expect((await cliente("GET", `/v1/nfse/${json.id}`)).status).toBe(404);
	});

	it("a mesma referência devolve a mesma nota; com outro conteúdo, é recusada", async () => {
		await serie();
		const primeira = await emitir();
		const repetida = await emitir();
		expect([primeira.status, repetida.status]).toEqual([201, 200]);
		expect(repetida.json.id).toBe(primeira.json.id);
		expect(sefaz.chamadas).toHaveLength(1);

		const alterada = await emitir({ naturezaOperacao: "Outra operação" });
		expect(alterada.status).toBe(409);
		expect(alterada.json.erro.codigo).toBe("referencia_com_conteudo_diferente");
		expect(sefaz.chamadas).toHaveLength(1);
		expect(await proximo()).toBe(2);
	});

	it("a rejeição devolve o número à série, e a nota corrigida reaproveita a referência", async () => {
		await serie({ proximoNumero: 10 });
		respostas.autorizacao = rejeicao("225", "Rejeicao: Falha no Schema XML da NFe");
		const recusada = await emitir();
		expect(recusada.status).toBe(422);
		expect(recusada.json.erro).toMatchObject({ codigo: "nfe_rejeitada", mensagem: "Rejeicao: Falha no Schema XML da NFe" });
		expect(recusada.json.nfe).toMatchObject({ situacao: "rejeitada", numero: 10, mensagens: [{ codigo: "225" }] });
		expect(await proximo()).toBe(10);
		expect(await documentos()).toEqual([]);

		delete respostas.autorizacao;
		const corrigida = await emitir({ naturezaOperacao: "Venda corrigida" });
		expect(corrigida.status).toBe(201);
		expect(corrigida.json).toMatchObject({ id: recusada.json.nfe.id, numero: 10, situacao: "autorizada" });

		// Duplicidade com outra chave: o número existe na SEFAZ e não volta para a série.
		respostas.autorizacao = rejeicao("539", "Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso");
		const duplicada = await emitir({ referencia: "pedido-1002" });
		expect(duplicada.json.nfe.numero).toBe(11);
		expect(await proximo()).toBe(12);
	});

	it("resposta perdida: a retomada consulta pela chave e fecha a nota sem reenviar", async () => {
		await serie();
		sefaz.falhar = (c) => {
			if (c.servico === "autorizacao") throw new TransportError(504, "tempo_esgotado", "Sem resposta em 60000 ms.");
		};
		const perdida = await emitir();
		expect(perdida.status).toBe(502);
		expect(perdida.json.erro.codigo).toBe("sem_resposta_conclusiva");
		expect(perdida.json.nfe).toMatchObject({ situacao: "indefinida", numero: 1, xmlDisponivel: false });
		// Enquanto não há resposta, a mesma referência não aceita outro conteúdo.
		expect((await emitir({ naturezaOperacao: "Outra" })).json.erro.codigo).toBe("referencia_com_conteudo_diferente");

		sefaz.falhar = null;
		sefaz.chamadas = [];
		const retomada = await emitir();
		expect(retomada.status).toBe(201);
		expect(retomada.json).toMatchObject({
			id: perdida.json.nfe.id, numero: 1, situacao: "autorizada", chaveAcesso: perdida.json.nfe.chaveAcesso,
			protocolo: "135260000000777", autorizadaEm: "2026-11-16T12:31:00-03:00", emitidaEm: perdida.json.nfe.emitidaEm,
		});
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["consulta"]);
		expect(sefaz.chamadas[0]?.url).toBe(`${SP}/nfeconsultaprotocolo4.asmx`);
		const xml = await cliente("GET", `/v1/nfe/${retomada.json.id}/xml`);
		expect(xml.text).toContain(`Id="NFe${perdida.json.nfe.chaveAcesso}"`);
		expect(await documentos()).toEqual([`${retomada.json.chaveAcesso}-nfe.xml`]);
	});

	it("resposta perdida e nota inexistente na SEFAZ: refaz com o mesmo número; e há a rota de consulta", async () => {
		await serie();
		sefaz.falhar = (c) => {
			if (c.servico === "autorizacao") throw new TransportError(504, "tempo_esgotado", "Sem resposta.");
		};
		const perdida = (await emitir()).json.nfe;
		const semReferencia = (await emitir({ referencia: undefined })).json.nfe;
		expect([perdida.numero, semReferencia.numero]).toEqual([1, 2]);

		sefaz.falhar = null;
		respostas.consulta = () => soap(`<retConsSitNFe ${NS} versao="4.00"><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo></retConsSitNFe>`);
		// A emissão sem referência é fechada pela rota de consulta: a nota não existe.
		const consultada = await cliente("POST", `/v1/nfe/${semReferencia.id}/consultar`);
		expect(consultada.json).toMatchObject({ situacao: "rejeitada", mensagens: [{ codigo: "217" }] });
		expect(await proximo()).toBe(2);

		sefaz.chamadas = [];
		const refeita = await emitir();
		expect(refeita.status).toBe(201);
		// As duas tentativas não existem para a SEFAZ: a série volta ao início, sem lacuna.
		expect(refeita.json).toMatchObject({ id: perdida.id, numero: 1 });
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["consulta", "autorizacao"]);
		expect(await proximo()).toBe(2);
	});

	it("lote ainda em processamento: consulta o recibo até ter o resultado", async () => {
		await serie();
		respostas.autorizacao = () => lote("<infRec><nRec>351000000000001</nRec><tMed>1</tMed></infRec>", "103");
		const { status, json } = await emitir();
		expect(status).toBe(201);
		expect(json.situacao).toBe("autorizada");
		expect(sefaz.chamadas.map((c) => c.servico)).toEqual(["autorizacao", "retautorizacao"]);
		expect(chamadas("retautorizacao")[0]?.corpo).toContain("<nRec>351000000000001</nRec>");
	});

	it("cancela e registra cartas de correção", async () => {
		await serie();
		const nota = (await emitir()).json;
		expect((await cliente("POST", `/v1/nfe/${nota.id}/cancelar`, { justificativa: "curta" })).status).toBe(400);

		const carta1 = await cliente("POST", `/v1/nfe/${nota.id}/carta-correcao`, { correcao: "Endereço de entrega: Rua das Acácias, 45" });
		const carta2 = await cliente("POST", `/v1/nfe/${nota.id}/carta-correcao`, { correcao: "Endereço de entrega: Rua das Acácias, 54" });
		expect([carta1.status, carta2.status]).toEqual([200, 200]);
		expect(carta2.json.cartasCorrecao).toBe(2);
		expect(chamadas("evento")[1]?.corpo).toContain(`Id="ID110110${nota.chaveAcesso}02"`);
		expect(chamadas("evento")[1]?.url).toBe(`${SP}/nferecepcaoevento4.asmx`);

		const cancelada = await cliente("POST", `/v1/nfe/${nota.id}/cancelar`, { justificativa: "Pedido cancelado pelo cliente" });
		expect(cancelada.status).toBe(200);
		expect(cancelada.json).toMatchObject({ situacao: "cancelada", repetido: false });
		expect(carta1.json.repetido).toBe(false);
		const evento = chamadas("evento")[2] as Chamada;
		expect(evento.corpo).toContain(`<infEvento Id="ID110111${nota.chaveAcesso}01">`);
		expect(evento.corpo).toContain("<nProt>135260000000777</nProt><xJust>Pedido cancelado pelo cliente</xJust>");
		expect(evento.corpo).toMatch(/<\/infEvento><Signature /);

		// Repetir não reenvia, e a resposta avisa; os eventos ficam arquivados ao lado da nota.
		const repetida = await cliente("POST", `/v1/nfe/${nota.id}/cancelar`, { justificativa: "Pedido cancelado pelo cliente" });
		expect(repetida.status).toBe(200);
		expect(repetida.json).toMatchObject({ situacao: "cancelada", repetido: true });
		expect(chamadas("evento")).toHaveLength(3);
		expect(await documentos()).toEqual([`${nota.chaveAcesso}-cancelamento.xml`, `${nota.chaveAcesso}-cce-01.xml`, `${nota.chaveAcesso}-cce-02.xml`, `${nota.chaveAcesso}-nfe.xml`]);
		const painel = (await admin("GET", "/admin/notas")).json.notas[0];
		expect(painel.situacao).toBe("cancelada");

		// Os XML dos eventos saem pela API, para o sistema guardar e entregar.
		const xmlCancelamento = await cliente("GET", `/v1/nfe/${nota.id}/cancelamento/xml`);
		expect(xmlCancelamento.text).toMatch(/^<procEventoNFe xmlns="http:\/\/www\.portalfiscal\.inf\.br\/nfe" versao="1\.00"><evento /);
		expect(xmlCancelamento.text).toContain("<nProt>135260000000888</nProt>");
		expect((await cliente("GET", `/v1/nfe/${nota.id}/carta-correcao/2/xml`)).text).toContain(`Id="ID110110${nota.chaveAcesso}02"`);
		expect((await cliente("GET", `/v1/nfe/${nota.id}/carta-correcao/3/xml`)).status).toBe(404);
		expect((await cliente("POST", `/v1/nfe/${nota.id}/carta-correcao`, { correcao: "Tentativa depois do cancelamento" })).status).toBe(409);
	});

	it("o painel cancela a NF-e só com a justificativa", async () => {
		await serie();
		const nota = (await emitir()).json;
		const res = await admin("POST", "/admin/notas/cancelar", { chaveAcesso: nota.chaveAcesso, justificativa: "Cancelada pelo painel do emitente" });
		expect(res.status).toBe(200);
		expect(res.json.nfse.situacao).toBe("cancelada");
		expect(chamadas("evento")).toHaveLength(1);
	});

	it("evento rejeitado devolve o motivo da SEFAZ", async () => {
		await serie();
		const nota = (await emitir()).json;
		respostas.evento = () => soap(`<retEnvEvento ${NS} versao="1.00"><cStat>128</cStat><retEvento versao="1.00"><infEvento><cStat>501</cStat><xMotivo>Rejeicao: Prazo de cancelamento superior ao previsto na legislacao</xMotivo></infEvento></retEvento></retEnvEvento>`);
		const res = await cliente("POST", `/v1/nfe/${nota.id}/cancelar`, { justificativa: "Pedido cancelado pelo cliente" });
		expect(res.status).toBe(422);
		expect(res.json).toMatchObject({ erro: { codigo: "cancelamento_rejeitado" }, mensagens: [{ codigo: "501" }] });
		expect((await cliente("GET", `/v1/nfe/${nota.id}`)).json.situacao).toBe("autorizada");
	});

	it("produção só com a trava liberada, e a chave de teste nunca passa", async () => {
		await serie({ ambiente: "producao" });
		const bloqueada = await emitir({ ambiente: "producao" });
		expect(bloqueada.status).toBe(422);
		expect(bloqueada.json.erro.codigo).toBe("producao_bloqueada");
		expect(sefaz.chamadas).toHaveLength(0);
		expect(await proximo()).toBe(1);

		await admin("PUT", "/admin/settings", { allowProduction: true });
		const liberada = await emitir({ ambiente: "producao" });
		expect(liberada.status).toBe(201);
		expect(sefaz.chamadas[0]?.url).toBe("https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx");
		expect(sefaz.chamadas[0]?.corpo).toContain("<tpAmb>1</tpAmb>");

		const deTeste = (await admin("POST", "/admin/chaves", { nome: "IA", escopo: "homologacao" })).json.chave.valor;
		expect((await cliente("POST", "/v1/nfe", { ...EXEMPLO_NFE, ambiente: "producao", referencia: "x" }, deTeste)).status).toBe(403);
		expect((await cliente("POST", `/v1/nfe/${liberada.json.id}/cancelar`, { justificativa: "Pedido cancelado pelo cliente" }, deTeste)).status).toBe(403);
	});

	it("recusa pedido inválido apontando o campo, UF sem autorizador e emitente de outra empresa", async () => {
		await serie();
		const invalido = await emitir({ itens: [{ ...EXEMPLO_NFE.itens[0], ncm: "123" }] });
		expect(invalido.status).toBe(400);
		expect(invalido.json).toMatchObject({ erro: { codigo: "requisicao_invalida" }, campo: "itens.0.ncm" });

		const outraUf = await emitir({ emitente: { ...EXEMPLO_NFE.emitente, endereco: { ...EXEMPLO_NFE.emitente.endereco, uf: "MG" } } });
		expect(outraUf.status).toBe(422);
		expect(outraUf.json.erro.codigo).toBe("uf_nao_suportada");

		const outraEmpresa = await emitir({ emitente: { ...EXEMPLO_NFE.emitente, cnpj: "99888777000166" } });
		expect(outraEmpresa.json.erro.codigo).toBe("emitente_divergente");
		expect(sefaz.chamadas).toHaveLength(0);
		expect((await cliente("POST", "/v1/nfe", EXEMPLO_NFE, "nfapi_chave-inexistente-000000000000000000000000000")).status).toBe(401);
	});
});

describe("NFC-e pelo cofre", () => {
	const nfce = (mudancas: Json = {}) => cliente("POST", "/v1/nfce", { ...EXEMPLO_NFCE, ...mudancas });

	it("emite com QR Code, em séries próprias por caixa", async () => {
		await serie({ modelo: "nfce", serie: 1, descricao: "Caixa 1" });
		await serie({ modelo: "nfce", serie: 2, descricao: "Caixa 2", proximoNumero: 500 });
		// Com mais de uma série, o pedido precisa dizer qual.
		expect((await nfce({ serie: undefined })).json.erro.codigo).toBe("serie_obrigatoria");
		expect((await nfce({ serie: 3 })).json.erro.codigo).toBe("serie_nao_cadastrada");

		const caixa1 = await nfce();
		const caixa2 = await nfce({ serie: 2, referencia: "caixa2-venda-1" });
		expect([caixa1.status, caixa2.status]).toEqual([201, 201]);
		expect(caixa1.json).toMatchObject({ modelo: "nfce", serie: 1, numero: 1, valor: 59.9, situacao: "autorizada" });
		expect(caixa2.json).toMatchObject({ serie: 2, numero: 500 });
		expect(caixa1.json.qrCode).toBe(`https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${caixa1.json.chaveAcesso}|3|2`);
		expect(caixa1.json.urlConsulta).toBe("https://www.homologacao.nfce.fazenda.sp.gov.br/consulta");

		const envio = sefaz.chamadas[0] as Chamada;
		expect(envio.url).toBe("https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx");
		expect(envio.corpo).toContain("<mod>65</mod>");
		expect(envio.corpo).toMatch(/<\/infNFe><infNFeSupl><qrCode><!\[CDATA\[/);

		// O cupom (DANFE NFC-e) em JSON, para o caixa imprimir na bobina.
		const cupom = (await cliente("GET", `/v1/nfce/${caixa1.json.id}/cupom`)).json;
		expect(cupom).toMatchObject({
			id: caixa1.json.id, situacao: "autorizada", modelo: "nfce", contingencia: false, pendenteDeAutorizacao: false, via: "consumidor",
			numero: 1, serie: 1, protocolo: "135260000000777", valorAPagar: 59.9, chaveAcesso: caixa1.json.chaveAcesso, qrCode: caixa1.json.qrCode,
			urlConsulta: "https://www.homologacao.nfce.fazenda.sp.gov.br/consulta",
		});
		expect(cupom.secoes.map((s: Json) => s.divisao)).toEqual(["cabecalho", "itens", "totais", "consulta", "consumidor", "identificacao", "qrcode", "mensagem_fiscal", "mensagem_contribuinte"]);
		const linhas = (divisao: string) => cupom.secoes.find((s: Json) => s.divisao === divisao).linhas as Json[];
		expect(linhas("cabecalho")[0]).toEqual({ tipo: "texto", texto: "Loja Exemplo Ltda", alinhamento: "centro", negrito: true, tamanho: "normal" });
		expect(linhas("cabecalho").map((l) => l.texto)).toEqual([
			"Loja Exemplo Ltda", "CNPJ: 11.222.333/0001-81", "Rua das Flores, 100, Centro, São Paulo - SP", "Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica",
		]);
		expect(linhas("itens")).toEqual([
			{
				tipo: "item", numero: 1, codigo: "789", descricao: "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL", quantidade: 1, unidade: "UN",
				valorUnitario: 59.9, valorTotal: 59.9, quantidadeTexto: "1", valorUnitarioTexto: "59,90", valorTotalTexto: "59,90",
			},
		]);
		expect(linhas("totais")).toEqual([
			{ tipo: "par", rotulo: "Qtde. total de itens", valor: "1", negrito: false },
			{ tipo: "par", rotulo: "Valor total R$", valor: "59,90", negrito: false },
			{ tipo: "par", rotulo: "FORMA PAGAMENTO", valor: "VALOR PAGO R$", negrito: false },
			{ tipo: "par", rotulo: "Dinheiro", valor: "100,00", negrito: false },
			{ tipo: "par", rotulo: "Troco R$", valor: "40,10", negrito: false },
		]);
		expect(linhas("consulta")[2]).toEqual({ tipo: "chave", chave: caixa1.json.chaveAcesso });
		expect(linhas("consumidor")[0]?.texto).toBe("CONSUMIDOR CPF: 123.456.789-09");
		expect(linhas("identificacao").map((l) => l.texto)).toEqual([
			expect.stringMatching(/^NFC-e n\. 1 Série 1 \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/), "Via Consumidor", "Protocolo de autorização: 135260000000777", "Data de autorização 16/11/2026 12:31:00",
		]);
		expect(linhas("qrcode")).toEqual([{ tipo: "qrcode", texto: caixa1.json.qrCode, tamanhoMinimoMm: 25 }]);
		expect(linhas("mensagem_fiscal")[0]?.texto).toBe("EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL");
		expect(linhas("mensagem_contribuinte")[0]).toMatchObject({ tipo: "par", valor: "12,50" });
		expect((await cliente("GET", `/v1/nfce/${caixa1.json.id}/cupom?via=cozinha`)).status).toBe(400);

		// NF-e e NFC-e não se misturam: rotas, séries e listas são separadas.
		expect((await cliente("GET", `/v1/nfe/${caixa1.json.id}`)).status).toBe(404);
		expect((await cliente("POST", `/v1/nfce/${caixa1.json.id}/carta-correcao`, { correcao: "Não existe carta na NFC-e" })).status).toBe(404);
		expect((await cliente("GET", "/v1/nfce")).json.nfce).toHaveLength(2);
		const cancelada = await cliente("POST", `/v1/nfce/${caixa1.json.id}/cancelar`, { justificativa: "Venda desfeita no caixa" });
		expect(cancelada.json.situacao).toBe("cancelada");
		expect(chamadas("evento")[0]?.url).toBe("https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx");
	});
});

describe("DANFE e DANFE NFC-e em PDF", () => {
	const MM = 72 / 25.4;
	/** Baixa um PDF e o abre para conferir folhas e medidas. */
	async function baixarPdf(caminho: string, cabecalhos: Record<string, string> = { authorization: `Bearer ${chaveApi}` }) {
		const res = await app.request(COFRE + caminho, { headers: cabecalhos }, env);
		if (res.status !== 200) return { status: res.status, tipo: res.headers.get("content-type"), bytes: 0, folhas: [] as { w: number; h: number }[] };
		const bytes = new Uint8Array(await res.arrayBuffer());
		const { PDFDocument } = await import("pdf-lib");
		const doc = await PDFDocument.load(bytes);
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
		return { status: 200, tipo: res.headers.get("content-type"), bytes: bytes.length, folhas: doc.getPages().map((p) => ({ w: Math.round(p.getWidth()), h: Math.round(p.getHeight()) })) };
	}
	const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
	const logotipo = (method: string, corpo?: Uint8Array) =>
		app.request(`${COFRE}/admin/logotipo`, { method, headers: { authorization: `Bearer ${env.VAULT_SECRET}`, "content-type": "image/png" }, body: corpo }, env);

	it("gera o DANFE da NF-e em A4, com folhas de continuação e a nota cancelada", async () => {
		await serie();
		const nota = (await emitir()).json;
		const danfe = await baixarPdf(`/v1/nfe/${nota.id}/danfe`);
		expect(danfe).toMatchObject({ status: 200, tipo: "application/pdf", folhas: [{ w: Math.round(210 * MM), h: Math.round(297 * MM) }] });

		// Itens que não cabem na primeira folha continuam nas seguintes.
		const item = (EXEMPLO_NFE as Json).itens[0];
		const muitos = Array.from({ length: 70 }, (_, i) => ({ ...item, codigo: `P${i + 1}`, descricao: `Produto de teste número ${i + 1}` }));
		const grande = (await emitir({ referencia: "pedido-grande", itens: muitos, cobranca: undefined, pagamentos: [{ forma: "15", valor: 700 * 70, indicador: "a_prazo" }] })).json;
		expect(grande.situacao, JSON.stringify(grande)).toBe("autorizada");
		expect((await baixarPdf(`/v1/nfe/${grande.id}/danfe`)).folhas.length).toBeGreaterThan(1);

		// Informações complementares que não cabem no quadro continuam numa folha a mais.
		const longa = (await emitir({ referencia: "pedido-texto-longo", informacoesComplementares: "Mercadoria sujeita a conferência no ato da entrega. ".repeat(95).trim() })).json;
		expect((await baixarPdf(`/v1/nfe/${longa.id}/danfe`)).folhas).toHaveLength(2);

		// A nota cancelada continua com DANFE (com a marca de cancelada), e o painel baixa o mesmo PDF.
		await cliente("POST", `/v1/nfe/${nota.id}/cancelar`, { justificativa: "Pedido cancelado pelo cliente" });
		expect((await baixarPdf(`/v1/nfe/${nota.id}/danfe`)).status).toBe(200);
		const arquivo = ((await admin("GET", "/admin/notas")).json.notas as Json[]).find((n) => n.chaveAcesso === nota.chaveAcesso)?.arquivos.find((a: Json) => a.tipo === "nfe");
		const doPainel = await baixarPdf(`/admin/notas/pdf?key=${encodeURIComponent(arquivo.key)}&cancelada=1`, { authorization: `Bearer ${env.VAULT_SECRET}` });
		expect(doPainel.folhas).toHaveLength(1);

		// Sem chave, com id de outro modelo ou inexistente, não há PDF.
		expect((await baixarPdf(`/v1/nfe/${nota.id}/danfe`, {})).status).toBe(401);
		expect((await baixarPdf(`/v1/nfce/${nota.id}/danfce`)).status).toBe(404);
		expect((await baixarPdf("/v1/nfe/nao-existe/danfe")).status).toBe(404);
	}, 30_000);

	it("gera o DANFE NFC-e na largura da bobina", async () => {
		await serie({ modelo: "nfce", serie: 1 });
		const venda = (await cliente("POST", "/v1/nfce", EXEMPLO_NFCE)).json;
		const de80 = await baixarPdf(`/v1/nfce/${venda.id}/danfce`);
		const de58 = await baixarPdf(`/v1/nfce/${venda.id}/danfce?largura=58`);
		expect(de80).toMatchObject({ status: 200, tipo: "application/pdf" });
		// Um ponto do PDF por ponto da impressora: 576 na bobina de 80 mm e 384 na de 58 mm.
		expect(de80.folhas.map((f) => f.w)).toEqual([576]);
		expect(de58.folhas.map((f) => f.w)).toEqual([384]);
		expect((de58.folhas[0] as { h: number }).h).toBeGreaterThan((de80.folhas[0] as { h: number }).h);
		expect((await baixarPdf(`/v1/nfce/${venda.id}/danfce?largura=70`)).status).toBe(400);
		expect((await baixarPdf(`/v1/nfce/${venda.id}/danfce?via=cozinha`)).status).toBe(400);
		expect((await baixarPdf(`/v1/nfe/${venda.id}/danfe`)).status).toBe(404);
	});

	it("o logotipo é configuração do cofre e entra nos dois documentos", async () => {
		await serie({ modelo: "nfce", serie: 1 });
		const venda = (await cliente("POST", "/v1/nfce", EXEMPLO_NFCE)).json;
		const semLogo = await baixarPdf(`/v1/nfce/${venda.id}/danfce`);
		expect((await cliente("GET", "/v1/cofre/logotipo")).status).toBe(404);
		expect((await cliente("GET", "/v1/cofre")).json.logotipo).toBe(false);

		// Só imagem PNG ou JPEG, de até 300 KB.
		expect((await logotipo("PUT", new TextEncoder().encode("isto não é uma imagem"))).status).toBe(400);
		expect((await logotipo("PUT", new Uint8Array(301 * 1024))).status).toBe(400);
		const salvo = await logotipo("PUT", PNG);
		expect(salvo.status).toBe(200);
		expect(((await salvo.json()) as Json).logotipo).toMatchObject({ tipo: "image/png", largura: 1, altura: 1 });

		const imagem = await app.request(`${COFRE}/v1/cofre/logotipo`, { headers: { authorization: `Bearer ${chaveApi}` } }, env);
		expect(imagem.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await imagem.arrayBuffer())).toEqual(PNG);
		expect((await cliente("GET", "/v1/cofre")).json.logotipo).toBe(true);
		const comLogo = await baixarPdf(`/v1/nfce/${venda.id}/danfce`);
		expect(comLogo.bytes).toBeGreaterThan(semLogo.bytes);
		expect((comLogo.folhas[0] as { h: number }).h).toBeGreaterThan((semLogo.folhas[0] as { h: number }).h);

		expect((await logotipo("DELETE")).status).toBe(200);
		expect((await logotipo("GET")).status).toBe(404);
		expect((await baixarPdf(`/v1/nfce/${venda.id}/danfce`)).folhas).toEqual(semLogo.folhas);
	});
});

describe("séries, inutilização e estado do cofre", () => {
	it("o próximo número não pode voltar para um já usado; filial precisa ser da mesma raiz", async () => {
		await serie({ proximoNumero: 50 });
		await emitir();
		const voltar = await serie({ proximoNumero: 50 });
		expect(voltar.status).toBe(409);
		expect(voltar.json.error.code).toBe("numero_ja_utilizado");
		expect((await serie({ proximoNumero: 60 })).json.serie.proximoNumero).toBe(60);
		expect((await serie({ serie: 890 })).status).toBe(400);
		expect((await serie({ cnpj: "99888777000166" })).json.error.code).toBe("emitente_divergente");
		expect((await serie({ serie: 2, cnpj: `${CNPJ_TESTE.slice(0, 8)}000262` })).json.serie.cnpj).toBe(`${CNPJ_TESTE.slice(0, 8)}000262`);
		expect((await cliente("GET", "/v1/series")).json.series).toHaveLength(2);
		expect((await app.request(`${COFRE}/admin/series`, {}, env)).status).toBe(401);
	});

	it("inutiliza a faixa onde o serviço existe, e a série segue depois dela", async () => {
		await serie({ proximoNumero: 5 });
		const pedido = { modelo: "nfe", ambiente: "homologacao", uf: "RJ", serie: 1, numeroInicial: 5, numeroFinal: 7, justificativa: "Números pulados por falha" };
		const res = await cliente("POST", "/v1/inutilizacoes", pedido);
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ modelo: "nfe", serie: 1, numeroInicial: 5, numeroFinal: 7, protocolo: "135260000000999" });
		expect(chamadas("inutilizacao")[0]?.url).toBe("https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx");
		expect(chamadas("inutilizacao")[0]?.corpo).toContain(`<infInut Id="ID3326${CNPJ_TESTE}55001000000005000000007">`);
		expect(await proximo()).toBe(8);

		// Faixa adiante: a série não salta agora, mas pula a faixa quando chegar nela.
		await cliente("POST", "/v1/inutilizacoes", { ...pedido, numeroInicial: 9, numeroFinal: 10 });
		expect(await proximo()).toBe(8);
		expect((await emitir()).json.numero).toBe(8);
		expect((await emitir({ referencia: "pedido-1002" })).json.numero).toBe(11);

		// Número de nota autorizada não pode ser inutilizado.
		const emUso = await cliente("POST", "/v1/inutilizacoes", { ...pedido, numeroInicial: 8, numeroFinal: 8 });
		expect(emUso.status).toBe(409);
		expect(emUso.json.erro.codigo).toBe("faixa_em_uso");

		// Repetir a mesma faixa devolve o registro, sem chamar a SEFAZ de novo.
		sefaz.chamadas = [];
		const repetida = await cliente("POST", "/v1/inutilizacoes", pedido);
		expect(repetida.status).toBe(200);
		expect(repetida.json).toMatchObject({ id: res.json.id, repetido: true });
		expect(sefaz.chamadas).toHaveLength(0);

		// A resposta se perdeu e a SEFAZ já tinha a faixa (cStat 563): fica registrada sem protocolo.
		respostas.inutilizacao = () => soap(`<retInutNFe ${NS} versao="4.00"><infInut><cStat>563</cStat><xMotivo>Rejeicao: Ja existe pedido de Inutilizacao com a mesma faixa de inutilizacao</xMotivo></infInut></retInutNFe>`);
		const jaNaSefaz = await cliente("POST", "/v1/inutilizacoes", { ...pedido, numeroInicial: 20, numeroFinal: 21 });
		expect(jaNaSefaz.status).toBe(200);
		expect(jaNaSefaz.json).toMatchObject({ repetido: true, protocolo: null, xmlDisponivel: false });

		// Consulta e XML das inutilizações.
		const lista = (await cliente("GET", "/v1/inutilizacoes?modelo=nfe&serie=1&ambiente=homologacao")).json.inutilizacoes as Json[];
		expect(lista.map((i) => [i.numeroInicial, i.numeroFinal])).toEqual([[20, 21], [9, 10], [5, 7]]);
		expect((await cliente("GET", "/v1/inutilizacoes?ambiente=producao")).json.inutilizacoes).toHaveLength(0);
		expect((await cliente("GET", `/v1/inutilizacoes/${res.json.id}`)).json).toMatchObject({ numeroInicial: 5, protocolo: "135260000000999", xmlDisponivel: true });
		expect((await cliente("GET", `/v1/inutilizacoes/${res.json.id}/xml`)).text).toMatch(/^<ProcInutNFe /);
		expect((await cliente("GET", `/v1/inutilizacoes/${jaNaSefaz.json.id}/xml`)).status).toBe(404);
	});

	it("em SP a inutilização foi extinta: o cofre explica e não chama a SEFAZ", async () => {
		const res = await cliente("POST", "/v1/inutilizacoes", { modelo: "nfe", uf: "SP", serie: 1, numeroInicial: 5, numeroFinal: 7, justificativa: "Números pulados por falha" });
		expect(res.status).toBe(422);
		expect(res.json.erro.codigo).toBe("inutilizacao_extinta");
		expect(sefaz.chamadas).toHaveLength(0);
	});

	it("mostra o estado do cofre à chave de API, sem segredos", async () => {
		const { status, json, text } = await cliente("GET", "/v1/cofre");
		expect(status).toBe(200);
		expect(json).toMatchObject({
			atualizacao: { versaoPublicada: "99.0.0", pendente: true },
			certificado: { documento: { kind: "cnpj", id: CNPJ_TESTE } },
			producaoLiberada: false,
			chave: { escopo: "completo", ambientes: ["homologacao"] },
			documentos: { nfse: true, nfce: { ufs: ["SP"] } },
		});
		expect(json.documentos.nfe.ufs).toContain("RJ");
		expect(json.certificado.diasRestantes).toBeGreaterThan(0);
		expect(text).not.toContain(env.VAULT_SECRET);
		expect(text).not.toContain("PRIVATE KEY");

		const sp = await cliente("GET", "/v1/sefaz/status?uf=SP");
		expect(sp.json).toMatchObject({ modelo: "nfe", uf: "SP", ambiente: "homologacao", autorizador: "SP", emOperacao: true, mensagem: { codigo: "107" }, tempoMedioSegundos: 1 });
		expect(chamadas("status")[0]?.url).toBe(`${SP}/nfestatusservico4.asmx`);
		expect((await cliente("GET", "/v1/sefaz/status?uf=MG")).status).toBe(422);
		expect((await app.request(`${COFRE}/v1/cofre`, {}, env)).status).toBe(401);
	});

	it("publica o contrato da API sem pedir chave", async () => {
		const res = await app.request(`${COFRE}/v1/openapi.json`, {}, env);
		expect(res.status).toBe(200);
		const contrato = (await res.json()) as Json;
		expect(contrato.openapi).toBe("3.1.0");
		expect(Object.keys(contrato.paths)).toEqual(expect.arrayContaining(["/v1/nfe", "/v1/nfce", "/v1/nfse", "/v1/series", "/v1/cofre", "/v1/inutilizacoes"]));
	});
});
