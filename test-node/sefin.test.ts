import { describe, expect, it } from "vitest";
import { comDeclaracaoXml, corpoEmissao, gunzipBase64, gzipBase64, lerRespostaEmissao } from "../src/nfse";

describe("troca com a SEFIN Nacional", () => {
	it("compacta e descompacta sem perder acentuação", async () => {
		const xml = `<DPS><xDescServ>Manutenção e programação — ${"ação ".repeat(500)}</xDescServ></DPS>`;
		const b64 = await gzipBase64(xml);
		expect(b64).toMatch(/^H4sI/); // cabeçalho GZip em Base64
		expect(b64.length).toBeLessThan(xml.length);
		expect(await gunzipBase64(b64)).toBe(xml);

		const corpo = JSON.parse(await corpoEmissao(xml)) as { dpsXmlGZipB64: string };
		expect(await gunzipBase64(corpo.dpsXmlGZipB64)).toBe(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
	});

	it("envia sempre a declaração XML, sem duplicar (a SEFIN rejeita com E1229 sem ela)", () => {
		const declaracao = '<?xml version="1.0" encoding="UTF-8"?>';
		expect(comDeclaracaoXml("<DPS/>")).toBe(`${declaracao}<DPS/>`);
		expect(comDeclaracaoXml(`${declaracao}<DPS/>`)).toBe(`${declaracao}<DPS/>`);
		// Um BOM antes da declaração também é removido.
		expect(comDeclaracaoXml(`﻿${declaracao}<DPS/>`)).toBe(`${declaracao}<DPS/>`);
	});

	it("reconhece a nota autorizada e extrai chave, número e alertas", async () => {
		const chave = "3".repeat(50);
		const nfse = `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>123</nNFSe></infNFSe></NFSe>`;
		const corpo = JSON.stringify({
			tipoAmbiente: 2,
			idDps: "DPS1",
			chaveAcesso: chave,
			nfseXmlGZipB64: await gzipBase64(nfse),
			alertas: [{ Codigo: "A001", Descricao: "Aviso" }],
		});
		expect(await lerRespostaEmissao(201, corpo)).toEqual({
			tipo: "autorizada",
			chaveAcesso: chave,
			xml: nfse,
			numeroNfse: "123",
			alertas: [{ codigo: "A001", descricao: "Aviso" }],
		});
	});

	it("lê rejeições nas grafias que a SEFIN usa (erros/erro, Codigo/codigo)", async () => {
		const lista = JSON.stringify({
			erros: [{ Codigo: "E0312", Descricao: "Código de tributação inválido", Complemento: "cTribNac" }],
		});
		expect(await lerRespostaEmissao(400, lista)).toEqual({
			tipo: "rejeitada",
			rejeicoes: [{ codigo: "E0312", descricao: "Código de tributação inválido", complemento: "cTribNac" }],
		});

		const unico = JSON.stringify({ erro: { codigo: "E2401", descricao: "Não encontrado" } });
		expect(await lerRespostaEmissao(404, unico)).toMatchObject({
			tipo: "rejeitada",
			rejeicoes: [{ codigo: "E2401" }],
		});
	});

	it("não trata como rejeição o que pode ter gerado a nota", async () => {
		expect((await lerRespostaEmissao(502, "<html>Bad Gateway</html>")).tipo).toBe("indefinida");
		const erroServidor = JSON.stringify({ erros: [{ Codigo: "E9999", Descricao: "Erro interno" }] });
		expect((await lerRespostaEmissao(500, erroServidor)).tipo).toBe("indefinida");
		expect((await lerRespostaEmissao(201, "{}")).tipo).toBe("indefinida");
	});
});
