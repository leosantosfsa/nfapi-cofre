// Peças comuns aos PDFs do cofre (DANFE e DANFE NFC-e): texto que cabe na
// fonte padrão do PDF, quebra de linha, QR Code e código de barras Code 128.
//
// Os PDFs usam as fontes padrão (Helvetica), que não vão embutidas no arquivo e
// só têm os caracteres do alfabeto latino ocidental (WinAnsi).

import type { PDFFont, PDFPage } from "pdf-lib";
import { rgb } from "pdf-lib";
import qrcode from "qrcode-generator";

export const PRETO = rgb(0, 0, 0);

/** Troca por "?" o que a fonte padrão não tem, e por espaço as quebras e tabulações. */
export function imprimivel(texto: string): string {
	let saida = "";
	for (const ch of texto) {
		const c = ch.codePointAt(0) as number;
		if (c === 9 || c === 10 || c === 13) saida += " ";
		else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) saida += ch;
		else saida += "?";
	}
	return saida;
}

/**
 * Quebra o texto em linhas que cabem na largura. Quebra nos espaços; uma
 * palavra maior que a linha (um endereço de internet, por exemplo) é cortada.
 */
export function quebrar(texto: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
	const linhas: string[] = [];
	const cabe = (t: string) => fonte.widthOfTextAtSize(t, tamanho) <= largura;
	for (const paragrafo of texto.split(/\r?\n/)) {
		let atual = "";
		for (const palavra of imprimivel(paragrafo).split(" ").filter(Boolean)) {
			const tentativa = atual ? `${atual} ${palavra}` : palavra;
			if (cabe(tentativa)) {
				atual = tentativa;
				continue;
			}
			if (atual) linhas.push(atual);
			atual = palavra;
			while (!cabe(atual) && atual.length > 1) {
				let corte = atual.length - 1;
				while (corte > 1 && !cabe(atual.slice(0, corte))) corte--;
				linhas.push(atual.slice(0, corte));
				atual = atual.slice(corte);
			}
		}
		linhas.push(atual);
	}
	return linhas;
}

/** Encolhe o texto com reticências simples até caber na largura. */
export function encurtar(texto: string, fonte: PDFFont, tamanho: number, largura: number): string {
	let t = imprimivel(texto);
	if (fonte.widthOfTextAtSize(t, tamanho) <= largura) return t;
	while (t.length > 1 && fonte.widthOfTextAtSize(`${t}...`, tamanho) > largura) t = t.slice(0, -1);
	return `${t}...`;
}

// ---------- QR Code ----------

export interface MatrizQr {
	modulos: number;
	escuro(linha: number, coluna: number): boolean;
}

/** QR Code com correção de erros nível M, como pede o manual do DANFE NFC-e. */
export function matrizQr(texto: string): MatrizQr {
	const qr = qrcode(0, "M");
	qr.addData(texto, "Byte");
	qr.make();
	return { modulos: qr.getModuleCount(), escuro: (l, c) => qr.isDark(l, c) };
}

/**
 * Desenha o QR Code com o canto superior esquerdo em (x, topo), em preto puro.
 * Módulos vizinhos na mesma linha saem num retângulo só, para não aparecerem
 * frestas quando o PDF vira imagem.
 */
export function desenharQr(page: PDFPage, qr: MatrizQr, x: number, topo: number, modulo: number): void {
	for (let l = 0; l < qr.modulos; l++) {
		let inicio = -1;
		for (let c = 0; c <= qr.modulos; c++) {
			const escuro = c < qr.modulos && qr.escuro(l, c);
			if (escuro && inicio < 0) inicio = c;
			if (!escuro && inicio >= 0) {
				page.drawRectangle({ x: x + inicio * modulo, y: topo - (l + 1) * modulo, width: (c - inicio) * modulo, height: modulo, color: PRETO });
				inicio = -1;
			}
		}
	}
}

// ---------- Code 128 ----------

// Larguras das barras e dos espaços de cada símbolo (valores 0 a 105) e da parada.
const SIMBOLOS = (
	"212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 " +
	"221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 " +
	"231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 " +
	"314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
	"111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 " +
	"114131 311141 411131 211412 211214 211232"
).split(" ");
const PARADA = "2331112";
const INICIO_B = 104;
const INICIO_C = 105;
const PARA_B = 100;
const PARA_C = 99;

/**
 * Valores dos símbolos Code 128 de um texto ASCII, com o dígito verificador.
 * Pares de dígitos vão no conjunto C (dois dígitos por símbolo); o resto, no B.
 * A chave de acesso com CNPJ alfanumérico mistura os dois.
 */
export function code128(texto: string): number[] {
	if (!/^[\x20-\x7e]+$/.test(texto)) throw new Error("O Code 128 deste cofre só codifica ASCII imprimível.");
	// Quantos dígitos seguidos há a partir de i.
	const digitos = (i: number) => {
		let n = 0;
		while (i + n < texto.length && texto.charCodeAt(i + n) >= 48 && texto.charCodeAt(i + n) <= 57) n++;
		return n;
	};
	const valores: number[] = [];
	let conjunto: "B" | "C" = digitos(0) >= 4 || (digitos(0) === texto.length && texto.length % 2 === 0) ? "C" : "B";
	valores.push(conjunto === "C" ? INICIO_C : INICIO_B);
	let i = 0;
	while (i < texto.length) {
		const n = digitos(i);
		if (conjunto === "C") {
			if (n >= 2) {
				valores.push(Number(texto.slice(i, i + 2)));
				i += 2;
				continue;
			}
			valores.push(PARA_B);
			conjunto = "B";
			continue;
		}
		// No conjunto B: vale trocar para o C com quatro ou mais dígitos pela frente, em quantidade par.
		if (n >= 4 && n % 2 === 0) {
			valores.push(PARA_C);
			conjunto = "C";
			continue;
		}
		valores.push(texto.charCodeAt(i) - 32);
		i++;
	}
	const soma = valores.reduce((s, v, posicao) => s + v * (posicao === 0 ? 1 : posicao), 0);
	valores.push(soma % 103);
	return valores;
}

/** Larguras (em módulos) das barras e espaços, alternados, começando por barra. */
export function barrasCode128(texto: string): number[] {
	const larguras: number[] = [];
	for (const v of code128(texto)) for (const d of SIMBOLOS[v] as string) larguras.push(Number(d));
	for (const d of PARADA) larguras.push(Number(d));
	return larguras;
}

/** Desenha o código de barras ocupando exatamente a largura dada. */
export function desenharCode128(page: PDFPage, texto: string, x: number, y: number, largura: number, altura: number): void {
	const larguras = barrasCode128(texto);
	const modulo = largura / larguras.reduce((s, l) => s + l, 0);
	let cursor = x;
	larguras.forEach((l, i) => {
		if (i % 2 === 0) page.drawRectangle({ x: cursor, y, width: l * modulo, height: altura, color: PRETO });
		cursor += l * modulo;
	});
}
