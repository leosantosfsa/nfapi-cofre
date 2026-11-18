// Distribuição de DF-e e manifestação do destinatário: o pedido, a leitura do
// retorno do Ambiente Nacional e o XML dos eventos, sem rede nem banco.

import { describe, expect, it } from "vitest";
import { ambienteNacional } from "../src/fiscal/dados";
import { montarChave } from "../src/nfe/chave";
import { distDFeInt, lerDocumento, lerRetornoDistribuicao, requisicaoDistribuicao } from "../src/nfe/distribuicao";
import { MANIFESTACOES, montarManifestacao } from "../src/nfe/eventos";
import { base64ParaTexto, gzipBase64 } from "../src/nfse";
import { comLacuna, contarPulados, proximoPulado, semOProximo } from "../src/recebidas/banco";
import { isHostAllowed } from "../src/transport";

const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const CNPJ = "11222333000181";
const EMITENTE = "44555666000181";
const CHAVE = montarChave({ cUF: "35", emissao: "2026-11-10", cnpj: EMITENTE, modelo: "55", serie: 1, numero: 4321, tpEmis: "1", cNF: "87654321" });

const retorno = (conteudo: string) =>
	`<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>` +
	`<retDistDFeInt ${NS} versao="1.01"><tpAmb>2</tpAmb><verAplic>1.4.0</verAplic>${conteudo}</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>`;

const RESUMO =
	`<resNFe ${NS} versao="1.01"><chNFe>${CHAVE}</chNFe><CNPJ>${EMITENTE}</CNPJ><xNome>Fornecedor de Teste Ltda</xNome><IE>123456789012</IE>` +
	"<dhEmi>2026-11-10T09:30:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1520.75</vNF><digVal>abc=</digVal><dhRecbto>2026-11-10T09:31:00-03:00</dhRecbto><nProt>135260000001234</nProt><cSitNFe>1</cSitNFe></resNFe>";

describe("pedido de distribuição (distDFeInt)", () => {
	it("monta as três consultas com o NSU em 15 posições", () => {
		const base = { ambiente: "homologacao" as const, uf: "SP", cnpj: CNPJ };
		expect(distDFeInt({ ...base, consulta: { tipo: "sequencia", ultNsu: 42 } })).toBe(
			`<distDFeInt ${NS} versao="1.01"><tpAmb>2</tpAmb><cUFAutor>35</cUFAutor><CNPJ>${CNPJ}</CNPJ><distNSU><ultNSU>000000000000042</ultNSU></distNSU></distDFeInt>`,
		);
		expect(distDFeInt({ ...base, ambiente: "producao", consulta: { tipo: "nsu", nsu: 7 } })).toContain("<tpAmb>1</tpAmb><cUFAutor>35</cUFAutor>");
		expect(distDFeInt({ ...base, consulta: { tipo: "nsu", nsu: 7 } })).toContain("<consNSU><NSU>000000000000007</NSU></consNSU>");
		expect(distDFeInt({ ...base, consulta: { tipo: "chave", chave: CHAVE } })).toContain(`<consChNFe><chNFe>${CHAVE}</chNFe></consChNFe>`);
	});

	it("guarda os NSU pulados em intervalos, entrega em ordem e fica só com os mais recentes", () => {
		let { lacunas, descartados } = comLacuna([], 11, 13, 500);
		expect([lacunas, descartados, contarPulados(lacunas), proximoPulado(lacunas)]).toEqual([[[11, 13]], 0, 3, 11]);
		({ lacunas } = comLacuna(lacunas, 20, 20, 500));
		const ordem: number[] = [];
		for (let n = proximoPulado(lacunas); n !== null; n = proximoPulado(lacunas)) {
			ordem.push(n);
			lacunas = semOProximo(lacunas);
		}
		expect(ordem).toEqual([11, 12, 13, 20]);
		expect(semOProximo([])).toEqual([]);

		// Acima do limite, saem os mais antigos.
		({ lacunas, descartados } = comLacuna([[1, 4]], 10, 15, 8));
		expect([lacunas, descartados]).toEqual([[[3, 4], [10, 15]], 2]);
		({ lacunas, descartados } = comLacuna([[1, 4]], 10, 5000, 500));
		expect([lacunas, descartados, contarPulados(lacunas)]).toEqual([[[4501, 5000]], 4495, 500]);
		// Intervalo vazio não entra.
		expect(comLacuna([], 8, 7, 500).lacunas).toEqual([]);
	});

	it("vai em SOAP 1.2 para o Ambiente Nacional, que está na lista de endereços aceitos", () => {
		for (const ambiente of ["homologacao", "producao"] as const) {
			const an = ambienteNacional(ambiente);
			for (const url of [an.distribuicao, an.evento]) expect(isHostAllowed(new URL(url).hostname), url).toBe(true);
		}
		const req = requisicaoDistribuicao(ambienteNacional("homologacao").distribuicao, "<distDFeInt/>", "ref");
		expect(req.url).toBe("https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx");
		expect(req.headers?.["content-type"]).toContain('action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"');
		expect(base64ParaTexto(req.bodyB64 ?? "")).toContain(
			'<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><distDFeInt/></nfeDadosMsg></nfeDistDFeInteresse>',
		);
	});
});

describe("retorno da distribuição (retDistDFeInt)", () => {
	it("descompacta cada documento e devolve o último e o maior NSU", async () => {
		const zip = await gzipBase64(RESUMO);
		// O Base64 pode vir quebrado em linhas, como no exemplo da nota técnica.
		const quebrado = `${zip.slice(0, 40)}\n${zip.slice(40)}`;
		const r = await lerRetornoDistribuicao(
			200,
			retorno(
				`<cStat>138</cStat><xMotivo>Documento(s) localizado(s)</xMotivo><dhResp>2026-11-17T10:00:00-03:00</dhResp><ultNSU>000000000000201</ultNSU><maxNSU>000000000000350</maxNSU>` +
					`<loteDistDFeInt><docZip NSU="000000000000201" schema="resNFe_v1.01.xsd">${quebrado}</docZip></loteDistDFeInt>`,
			),
		);
		expect(r).toEqual({
			tipo: "resposta", codigo: "138", motivo: "Documento(s) localizado(s)", ultNsu: 201, maxNsu: 350,
			documentos: [{ nsu: 201, schema: "resNFe_v1.01.xsd", xml: RESUMO }],
		});
	});

	it("lê os retornos sem documentos e recusa o que não reconhece", async () => {
		expect(await lerRetornoDistribuicao(200, retorno("<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo><ultNSU>000000000000201</ultNSU><maxNSU>000000000000201</maxNSU>"))).toMatchObject({
			tipo: "resposta", codigo: "137", ultNsu: 201, maxNsu: 201, documentos: [],
		});
		// Na rejeição o NSU pode nem vir.
		expect(await lerRetornoDistribuicao(200, retorno("<cStat>656</cStat><xMotivo>Rejeicao: Consumo Indevido</xMotivo>"))).toMatchObject({ codigo: "656", ultNsu: null, maxNsu: null });
		expect((await lerRetornoDistribuicao(503, "<html>fora do ar</html>")).tipo).toBe("indefinida");
		expect((await lerRetornoDistribuicao(200, retorno('<cStat>138</cStat><xMotivo>ok</xMotivo><loteDistDFeInt><docZip NSU="1" schema="x">nao-e-gzip</docZip></loteDistDFeInt>'))).tipo).toBe("indefinida");
	});
});

describe("documentos distribuídos", () => {
	it("lê o resumo da NF-e", () => {
		expect(lerDocumento(RESUMO)).toEqual({
			tipo: "resumo_nfe", chave: CHAVE, emitente: { documento: EMITENTE, nome: "Fornecedor de Teste Ltda", ie: "123456789012" }, destinatario: null,
			emitidaEm: "2026-11-10T09:30:00-03:00", operacao: "saida", valor: 1520.75, situacao: "autorizada", protocolo: "135260000001234", autorizadaEm: "2026-11-10T09:31:00-03:00",
		});
		expect(lerDocumento(RESUMO.replace("<cSitNFe>1<", "<cSitNFe>3<"))).toMatchObject({ situacao: "cancelada" });
		expect(lerDocumento(RESUMO.replace("<cSitNFe>1<", "<cSitNFe>2<"))).toMatchObject({ situacao: "denegada" });
	});

	it("lê a NF-e completa, com emitente, destinatário e protocolo", () => {
		const nfeProc =
			`<nfeProc ${NS} versao="4.00"><NFe><infNFe Id="NFe${CHAVE}" versao="4.00"><ide><dhEmi>2026-11-10T09:30:00-03:00</dhEmi><tpNF>1</tpNF></ide>` +
			`<emit><CNPJ>${EMITENTE}</CNPJ><xNome>Fornecedor de Teste Ltda</xNome><IE>123456789012</IE></emit><dest><CNPJ>${CNPJ}</CNPJ><xNome>Empresa de Teste</xNome></dest>` +
			"<total><ICMSTot><vNF>1520.75</vNF></ICMSTot></total></infNFe></NFe>" +
			`<protNFe versao="4.00"><infProt><chNFe>${CHAVE}</chNFe><dhRecbto>2026-11-10T09:31:00-03:00</dhRecbto><nProt>135260000001234</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
		expect(lerDocumento(nfeProc)).toEqual({
			tipo: "nfe", chave: CHAVE, emitente: { documento: EMITENTE, nome: "Fornecedor de Teste Ltda", ie: "123456789012" }, destinatario: CNPJ,
			emitidaEm: "2026-11-10T09:30:00-03:00", operacao: "saida", valor: 1520.75, situacao: "autorizada", protocolo: "135260000001234", autorizadaEm: "2026-11-10T09:31:00-03:00",
		});
	});

	it("lê o evento completo e o resumo de evento; o resto fica como 'outro'", () => {
		const evento =
			`<procEventoNFe ${NS} versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${CHAVE}01"><cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>${EMITENTE}</CNPJ><chNFe>${CHAVE}</chNFe>` +
			'<dhEvento>2026-11-11T08:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento></detEvento></infEvento></evento>' +
			`<retEvento versao="1.00"><infEvento><cStat>135</cStat><chNFe>${CHAVE}</chNFe><nProt>135260000009999</nProt></infEvento></retEvento></procEventoNFe>`;
		expect(lerDocumento(evento)).toEqual({ tipo: "evento", chave: CHAVE, tpEvento: "110111", sequencia: 1, descricao: "Cancelamento", em: "2026-11-11T08:00:00-03:00", protocolo: "135260000009999", autor: EMITENTE });
		const resumo = `<resEvento ${NS} versao="1.01"><cOrgao>91</cOrgao><CNPJ>${EMITENTE}</CNPJ><chNFe>${CHAVE}</chNFe><dhEvento>2026-11-12T08:00:00-03:00</dhEvento><tpEvento>110110</tpEvento><nSeqEvento>2</nSeqEvento><xEvento>Carta de Correcao</xEvento><dhRecbto>2026-11-12T08:00:05-03:00</dhRecbto><nProt>135260000008888</nProt></resEvento>`;
		expect(lerDocumento(resumo)).toMatchObject({ tipo: "resumo_evento", tpEvento: "110110", sequencia: 2, descricao: "Carta de Correcao", protocolo: "135260000008888" });
		expect(lerDocumento(`<resCTe ${NS}><chCTe>1</chCTe></resCTe>`)).toEqual({ tipo: "outro" });
		expect(lerDocumento("isto não é XML")).toEqual({ tipo: "outro" });
		expect(lerDocumento(RESUMO.replace(CHAVE, "123"))).toEqual({ tipo: "outro" });
	});
});

describe("eventos de manifestação do destinatário", () => {
	const ctx = { ambiente: "homologacao" as const, cnpj: CNPJ, chave: CHAVE, agora: new Date("2026-11-17T15:00:00Z") };

	it("vão para o Ambiente Nacional (órgão 91), com o código e a descrição de cada tipo", () => {
		const ciencia = montarManifestacao(ctx, "SP", "ciencia", 1);
		expect(ciencia.id).toBe(`ID210210${CHAVE}01`);
		expect(ciencia.xml).toBe(
			`<evento ${NS} versao="1.00"><infEvento Id="ID210210${CHAVE}01"><cOrgao>91</cOrgao><tpAmb>2</tpAmb><CNPJ>${CNPJ}</CNPJ><chNFe>${CHAVE}</chNFe>` +
				'<dhEvento>2026-11-17T12:00:00-03:00</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>' +
				'<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento></evento>',
		);
		expect(Object.fromEntries(Object.entries(MANIFESTACOES).map(([nome, m]) => [nome, m.tpEvento]))).toEqual({
			ciencia: "210210", confirmacao: "210200", desconhecimento: "210220", nao_realizada: "210240",
		});
		// A data sai no fuso de quem manifesta, não no da UF da chave.
		expect(montarManifestacao(ctx, "AM", "confirmacao", 2).xml).toContain("<dhEvento>2026-11-17T11:00:00-04:00</dhEvento><tpEvento>210200</tpEvento><nSeqEvento>2</nSeqEvento>");
	});

	it("só a operação não realizada leva justificativa", () => {
		const justificativa = "Mercadoria recusada na entrega";
		expect(montarManifestacao(ctx, "SP", "nao_realizada", 1, justificativa).xml).toContain(`<descEvento>Operacao nao Realizada</descEvento><xJust>${justificativa}</xJust>`);
		expect(montarManifestacao(ctx, "SP", "desconhecimento", 1, justificativa).xml).toContain('<detEvento versao="1.00"><descEvento>Desconhecimento da Operacao</descEvento></detEvento>');
	});
});
