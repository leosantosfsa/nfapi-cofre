// Resumo fiscal lido do XML, o ZIP da exportação e a planilha de resumo, sem
// rede nem banco.

import { describe, expect, it } from "vitest";
import { EXEMPLO_NFE } from "../src/contrato-exemplos";
import { VALORES_ZERADOS, resumoFiscal, somarValores } from "../src/fiscal/resumo";
import { NfeInput, type PedidoNfe } from "../src/nfe/schema";
import { montarNfe } from "../src/nfe/xml";
import { planilhaXlsx } from "../src/planilha";
import { diasDoPeriodo } from "../src/relatorios-schema";
import { crc32, zipStream } from "../src/zip";
import { CNPJ_TESTE } from "../test/helpers";

type Json = Record<string, any>;
const { ambiente: _a, referencia: _r, ...BASE_NFE } = EXEMPLO_NFE as Json;
const contexto = { ambiente: "homologacao" as const, cnpj: CNPJ_TESTE, serie: 1, numero: 42, cNF: "87654321", versaoAplicativo: "NFapi-teste", agora: new Date("2026-11-16T15:30:00Z") };

/** Lê um ZIP inteiro: nome e conteúdo de cada entrada, pelo diretório central. */
async function abrirZip(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
	const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const fim = zip.length - 22;
	expect(v.getUint32(fim, true)).toBe(0x06054b50);
	const saida: Record<string, Uint8Array> = {};
	let p = v.getUint32(fim + 16, true);
	for (let i = 0; i < v.getUint16(fim + 10, true); i++) {
		expect(v.getUint32(p, true)).toBe(0x02014b50);
		const [metodo, crc, comprimido, original, tamanhoDoNome, local] = [v.getUint16(p + 10, true), v.getUint32(p + 16, true), v.getUint32(p + 20, true), v.getUint32(p + 24, true), v.getUint16(p + 28, true), v.getUint32(p + 42, true)];
		const nome = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + tamanhoDoNome));
		expect(v.getUint32(local, true)).toBe(0x04034b50);
		const inicio = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
		const corpo = zip.slice(inicio, inicio + comprimido);
		const dados = metodo === 8 ? new Uint8Array(await new Response(new Blob([corpo]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()) : corpo;
		expect([nome, dados.length, crc32(dados)]).toEqual([nome, original, crc]);
		saida[nome] = dados;
		p += 46 + tamanhoDoNome;
	}
	return saida;
}
const bytes = async (fluxo: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(fluxo).arrayBuffer());
const texto = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("resumo fiscal", () => {
	it("lê natureza, CFOP, destinatário e totais de uma NF-e", () => {
		const pedido: PedidoNfe = { ...NfeInput.parse(BASE_NFE), modelo: "55" };
		const montada = montarNfe(pedido, contexto);
		const r = resumoFiscal(montada.xml);
		expect(r).not.toBeNull();
		expect(r?.natureza).toBe(pedido.naturezaOperacao);
		expect(r?.valores.total).toBe(montada.total);
		expect(r?.valores.produtos).toBeGreaterThan(0);
		expect(r?.cfops.map((c) => c.cfop)).toEqual([...new Set(pedido.itens.map((i) => i.cfop))].sort());
		expect(r?.cfops.reduce((s, c) => s + c.valor, 0)).toBeCloseTo(r?.valores.produtos ?? 0, 2);
		expect(r?.destinatario).toMatchObject({ documento: "99888777000166", uf: pedido.destinatario?.endereco?.uf ?? null });
		expect(r?.emitidaEm).toBe(montada.dataEmissao);
		// Dentro do nfeProc (nota autorizada) o resultado é o mesmo.
		expect(resumoFiscal(`<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${montada.xml}<protNFe/></nfeProc>`)).toEqual(r);
	});

	it("lê os grupos da reforma tributária e o Simples Nacional", () => {
		const nota = (total: string) =>
			`<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe><ide><natOp>Venda</natOp><dhEmi>2027-01-05T10:00:00-03:00</dhEmi></ide>` +
			`<det nItem="1"><prod><CFOP>5102</CFOP><vProd>60.00</vProd></prod></det><det nItem="2"><prod><CFOP>5405</CFOP><vProd>30.00</vProd></prod></det><det nItem="3"><prod><CFOP>5102</CFOP><vProd>10.00</vProd></prod></det>` +
			`<total><ICMSTot><vProd>100.00</vProd><vDesc>5.00</vDesc><vFrete>7.50</vFrete><vICMS>18.00</vICMS><vST>2.00</vST><vFCP>1.00</vFCP><vFCPST>0.50</vFCPST><vIPI>3.00</vIPI><vPIS>0.65</vPIS><vCOFINS>3.00</vCOFINS><vNF>107.50</vNF></ICMSTot>${total}</total></infNFe></NFe>`;
		const normal = resumoFiscal(nota("<ISTot><vIS>1.20</vIS></ISTot><IBSCBSTot><vBCIBSCBS>100.00</vBCIBSCBS><gIBS><gIBSUF><vIBSUF>0.10</vIBSUF></gIBSUF><vIBS>0.15</vIBS></gIBS><gCBS><vCBS>0.90</vCBS></gCBS></IBSCBSTot>"));
		expect(normal?.cfops).toEqual([{ cfop: "5102", valor: 70 }, { cfop: "5405", valor: 30 }]);
		expect(normal?.valores).toEqual({ ...VALORES_ZERADOS, total: 107.5, produtos: 100, desconto: 5, frete: 7.5, icms: 18, icmsSt: 2, fcp: 1.5, ipi: 3, pis: 0.65, cofins: 3, ibs: 0.15, cbs: 0.9, is: 1.2 });
		expect(normal?.destinatario).toBeNull();
		const simples = resumoFiscal(nota("<IBSCBSTot><gTribSN><vIBSSN>0.40</vIBSSN><vCBSSN>0.60</vCBSSN></gTribSN></IBSCBSTot>"));
		expect([simples?.valores.ibs, simples?.valores.cbs, simples?.valores.is]).toEqual([0.4, 0.6, 0]);
	});

	it("lê o valor, o ISS e o tomador de uma NFS-e", () => {
		const xml =
			`<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS1"><valores><vBC>1500.00</vBC><vISSQN>30.00</vISSQN><vLiq>1470.00</vLiq></valores>` +
			`<DPS><infDPS Id="DPS1"><dhEmi>2026-11-16T12:00:00-03:00</dhEmi><toma><CNPJ>99888777000166</CNPJ><xNome>Cliente Ltda</xNome></toma>` +
			`<serv><cServ><cTribNac>010701</cTribNac><xDescServ>Suporte</xDescServ></cServ></serv>` +
			`<valores><vServPrest><vServ>1500.00</vServ></vServPrest><vDescCondIncond><vDescIncond>10.00</vDescIncond></vDescCondIncond></valores></infDPS></DPS></infNFSe></NFSe>`;
		expect(resumoFiscal(xml)).toEqual({
			natureza: "Serviço 010701", cfops: [], valores: { ...VALORES_ZERADOS, total: 1470, servicos: 1500, desconto: 10, iss: 30 },
			destinatario: { documento: "99888777000166", nome: "Cliente Ltda", uf: null }, emitidaEm: "2026-11-16T12:00:00-03:00",
		});
		expect(resumoFiscal("<resNFe><chNFe>1</chNFe></resNFe>")).toBeNull();
		expect(resumoFiscal("isto não é XML")).toBeNull();
	});

	it("soma os valores campo a campo, em centavos", () => {
		const soma = somarValores(somarValores({ ...VALORES_ZERADOS }, { total: 0.1, icms: 0.2 }), { total: 0.2, icms: 0.1 });
		expect([soma.total, soma.icms, soma.ipi]).toEqual([0.3, 0.3, 0]);
		expect(somarValores({ ...VALORES_ZERADOS, total: 5 }, undefined).total).toBe(5);
	});

	it("conta os dias do período", () => {
		expect([diasDoPeriodo("2026-11-01", "2026-11-30"), diasDoPeriodo("2026-11-17", "2026-11-17"), diasDoPeriodo("2026-11-17", "2026-11-16")]).toEqual([30, 1, 0]);
		expect(diasDoPeriodo("2026-02-30", "2026-03-01")).toBeNaN();
	});
});

describe("ZIP da exportação", () => {
	it("grava as entradas na ordem, comprime o que compensa e pula o arquivo que sumiu", async () => {
		const xml = `<nota>${"<item>valor repetido</item>".repeat(200)}</nota>`;
		const zip = await bytes(
			zipStream(
				[
					{ nome: "emitidas/nfe/a-nfe.xml", dados: async () => new TextEncoder().encode(xml) },
					{ nome: "sumiu.xml", dados: async () => null },
					{ nome: "recebidas/ação.xml", dados: async () => new TextEncoder().encode("<curto/>") },
					{ nome: "emitidas/nfe/a-nfe.xml", dados: async () => new TextEncoder().encode("<outra/>") },
					{ nome: "vazio.txt", dados: async () => new Uint8Array() },
				],
				new Date("2026-11-17T12:00:00Z"),
			),
		);
		const arquivos = await abrirZip(zip);
		// O nome repetido ganha um sufixo; o acento vai em UTF-8.
		expect(Object.keys(arquivos)).toEqual(["emitidas/nfe/a-nfe.xml", "recebidas/ação.xml", "emitidas/nfe/a-nfe-2.xml", "vazio.txt"]);
		expect(texto(arquivos["emitidas/nfe/a-nfe.xml"])).toBe(xml);
		expect(texto(arquivos["emitidas/nfe/a-nfe-2.xml"])).toBe("<outra/>");
		expect(arquivos["vazio.txt"]).toHaveLength(0);
		// O XML repetitivo ocupa bem menos que o original.
		expect(zip.length).toBeLessThan(xml.length / 4);
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	it("sem nenhuma entrada, ainda é um ZIP válido", async () => {
		expect(await abrirZip(await bytes(zipStream([])))).toEqual({});
	});
});

describe("planilha de resumo", () => {
	it("gera um .xlsx com texto, números e a chave de acesso como texto", async () => {
		const chave = "35261144555666000181550010000001011876543210";
		const xlsx = await planilhaXlsx([
			{
				nome: "Emitidas",
				colunas: [{ titulo: "Chave de acesso", tipo: "texto" }, { titulo: "Destinatário", tipo: "texto" }, { titulo: "Valor total", tipo: "valor" }, { titulo: "Itens", tipo: "inteiro" }],
				linhas: [[chave, "Silva & Filhos <ME>", 1520.75, 3], ["", null, 0, null]],
			},
			{ nome: "Recebidas", colunas: [{ titulo: "Série", tipo: "texto" }], linhas: [] },
		]);
		const arquivos = await abrirZip(xlsx);
		expect(Object.keys(arquivos)).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
		expect(texto(arquivos["xl/workbook.xml"])).toContain('<sheet name="Emitidas" sheetId="1" r:id="rId1"/><sheet name="Recebidas" sheetId="2" r:id="rId2"/>');
		const folha = texto(arquivos["xl/worksheets/sheet1.xml"]);
		expect(folha).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Chave de acesso</t></is></c>');
		// A chave vai como texto; o valor, como número com o formato de duas casas.
		expect(folha).toContain(`<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">${chave}</t></is></c><c r="B2" t="inlineStr"><is><t xml:space="preserve">Silva &amp; Filhos &lt;ME&gt;</t></is></c><c r="C2" s="2"><v>1520.75</v></c><c r="D2"><v>3</v></c></row>`);
		// Célula vazia não é escrita; o zero é.
		expect(folha).toContain('<row r="3"><c r="C3" s="2"><v>0</v></c></row>');
	});
});
