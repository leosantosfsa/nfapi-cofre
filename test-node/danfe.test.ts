// Peças do DANFE e do DANFE NFC-e que dá para conferir sem abrir o PDF:
// o código de barras da chave de acesso, o QR Code e o texto que vai impresso.

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { barrasCode128, code128, encurtar, imprimivel, matrizQr, quebrar } from "../src/danfe/desenho";
import { cep, chaveEmBlocos, decimal, dinheiro, documento, telefone } from "../src/danfe/leitura";

describe("código de barras da chave de acesso (Code 128)", () => {
	it("codifica pares de dígitos no conjunto C, com o dígito verificador", () => {
		// Início C (105), os três pares e o verificador: (105 + 12×1 + 34×2 + 56×3) mod 103.
		expect(code128("123456")).toEqual([105, 12, 34, 56, 44]);
		const chave = "35261111222333000181550010000123451123456788";
		expect(code128(chave)).toHaveLength(1 + 22 + 1);
		// 24 símbolos de 11 módulos e a parada, de 13.
		expect(barrasCode128(chave).reduce((s, l) => s + l, 0)).toBe(24 * 11 + 13);
	});

	it("mistura os conjuntos B e C na chave com CNPJ alfanumérico", () => {
		// 35, 26, 11 no conjunto C; troca para o B (100) nas letras; volta ao C (99) nos dígitos seguintes.
		const valores = code128("3526111A2B3C4D000109550010000000021140291657");
		expect(valores.slice(0, 14)).toEqual([105, 35, 26, 11, 100, 17, 33, 18, 34, 19, 35, 20, 36, 99]);
		expect(code128("AB12")).toEqual([104, 33, 34, 17, 18, (104 + 33 + 34 * 2 + 17 * 3 + 18 * 4) % 103]);
		expect(() => code128("chave com acento: é")).toThrow();
	});

	it("todo símbolo tem 11 módulos, com as barras somando par, e nenhum se repete", () => {
		const vistos = new Set<string>();
		const conferir = (texto: string) => {
			const larguras = barrasCode128(texto).slice(6, 12);
			expect(larguras.reduce((s, l) => s + l, 0), texto).toBe(11);
			expect(((larguras[0] as number) + (larguras[2] as number) + (larguras[4] as number)) % 2, texto).toBe(0);
			vistos.add(larguras.join(""));
		};
		for (let c = 32; c < 127; c++) conferir(String.fromCharCode(c));
		for (const par of ["95", "96", "97", "98", "99"]) conferir(par + par);
		expect(vistos.size).toBe(100);
	});
});

describe("QR Code do DANFE NFC-e", () => {
	it("usa o nível M de correção e o menor tamanho que comporta o texto", () => {
		const qr = matrizQr(`https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${"3".repeat(44)}|3|2`);
		// 94 caracteres: versão 6 no nível M, com 41 módulos de lado.
		expect(qr.modulos).toBe(41);
		// Os três marcadores de canto: borda escura, anel claro, miolo escuro.
		for (const [l, c] of [[0, 0], [0, 34], [34, 0]] as const) {
			expect([qr.escuro(l, c), qr.escuro(l + 1, c + 1), qr.escuro(l + 3, c + 3)]).toEqual([true, false, true]);
		}
		expect(qr.escuro(34, 34)).not.toBe(undefined);
	});
});

describe("texto impresso", () => {
	it("formata valores, documentos e a chave como no DANFE", () => {
		expect(dinheiro(1234567.5)).toBe("1.234.567,50");
		expect(dinheiro(612.25, 3)).toBe("612,250");
		expect([decimal("1.0000"), decimal("1.2500"), decimal("0.123456"), decimal(undefined)]).toEqual(["1,00", "1,25", "0,1235", ""]);
		expect([documento("11222333000181"), documento("12ABC34501DE35"), documento("12345678909"), documento(undefined)]).toEqual([
			"11.222.333/0001-81", "12.ABC.345/01DE-35", "123.456.789-09", "",
		]);
		expect([cep("01001000"), telefone("1133334444"), telefone("11988887777"), telefone("123")]).toEqual(["01001-000", "(11) 3333-4444", "(11) 98888-7777", "123"]);
		expect(chaveEmBlocos("35261111222333000181550010000123451123456788")).toBe("3526 1111 2223 3300 0181 5500 1000 0123 4511 2345 6788");
	});

	it("troca o que a fonte do PDF não tem e quebra as linhas na largura", async () => {
		expect(imprimivel("Ação nº 5 – café\tcom “aspas” 😀")).toBe("Ação nº 5 ? café com ?aspas? ?");
		const fonte = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
		const linhas = quebrar("Mercadoria sujeita a conferência no ato da entrega", fonte, 10, 120);
		expect(linhas.join(" ")).toBe("Mercadoria sujeita a conferência no ato da entrega");
		expect(linhas.length).toBeGreaterThan(1);
		for (const l of linhas) expect(fonte.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(120);
		// Uma palavra maior que a linha é cortada, sem perder caracteres.
		const endereco = "https://www.homologacao.nfce.fazenda.sp.gov.br/consulta";
		expect(quebrar(endereco, fonte, 10, 100).join("")).toBe(endereco);
		expect(quebrar("linha um\nlinha dois", fonte, 10, 500)).toEqual(["linha um", "linha dois"]);
		expect(fonte.widthOfTextAtSize(encurtar("Transportadora de nome muito comprido Ltda", fonte, 10, 80), 10)).toBeLessThanOrEqual(80);
	});
});
