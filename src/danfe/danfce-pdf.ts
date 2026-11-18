// DANFE NFC-e em PDF, na largura da bobina.
//
// É a reserva para o caixa que não monta o cupom por conta própria: o conteúdo
// é o mesmo de GET /v1/nfce/{id}/cupom, já diagramado. A página tem um ponto
// do PDF por ponto da impressora térmica (8 por milímetro): 576 de largura na
// bobina de 80 mm e 384 na de 58 mm, com a altura que o conteúdo pedir. Quem
// converte o PDF em imagem nessa mesma largura obtém o QR Code com módulos
// inteiros, em preto puro. Para imprimir pelo driver da impressora, use a
// opção de ajustar à largura do papel.

import { type PDFFont, PDFDocument, StandardFonts } from "pdf-lib";
import type { Cupom, Linha } from "./cupom";
import { PRETO, desenharQr, imprimivel, matrizQr, quebrar } from "./desenho";
import { type Logotipo, chaveEmBlocos } from "./leitura";

const LARGURAS = { 58: 384, 80: 576 } as const;
const MARGEM = 8;
const NORMAL = 22;
const DOBRADO = 30;
const MENOR = 19;
const altura = (tamanho: number) => Math.round(tamanho * 1.22);

export async function gerarDanfcePdf(cupom: Cupom, opcoes: { largura?: 58 | 80; logotipo?: Logotipo } = {}): Promise<Uint8Array> {
	const W = LARGURAS[opcoes.largura ?? 80];
	const util = W - 2 * MARGEM;
	const pdf = await PDFDocument.create();
	pdf.setTitle(`DANFE NFC-e ${cupom.chaveAcesso}`);
	pdf.setCreator("Cofre NFapi");
	pdf.setProducer("Cofre NFapi");
	const comum = await pdf.embedFont(StandardFonts.Helvetica);
	const forte = await pdf.embedFont(StandardFonts.HelveticaBold);
	const page = pdf.addPage([W, 100]);

	// Cada operação desenha com o topo da página conhecido; a altura só se sabe no fim.
	const operacoes: Array<(H: number) => void> = [];
	let y = MARGEM;

	const escrever = (t: string, fonte: PDFFont, tamanho: number, x: number, topo: number) => {
		operacoes.push((H) => page.drawText(t, { x, y: H - topo - tamanho * 0.82, size: tamanho, font: fonte, color: PRETO }));
	};
	/** Texto com quebra de linha, no alinhamento pedido. */
	const paragrafo = (t: string, alinhamento: "esquerda" | "centro" | "direita", negrito: boolean, inicial: number) => {
		const fonte = negrito ? forte : comum;
		// Uma palavra só que passa pouco da linha (o endereço de consulta) encolhe em vez de ser cortada.
		let tamanho = inicial;
		if (!/\s/.test(t.trim())) while (tamanho > inicial * 0.8 && fonte.widthOfTextAtSize(imprimivel(t), tamanho) > util) tamanho--;
		if (fonte.widthOfTextAtSize(imprimivel(t), tamanho) > util) tamanho = inicial;
		for (const l of quebrar(t, fonte, tamanho, util)) {
			const w = fonte.widthOfTextAtSize(l, tamanho);
			const x = alinhamento === "centro" ? (W - w) / 2 : alinhamento === "direita" ? W - MARGEM - w : MARGEM;
			escrever(l, fonte, tamanho, x, y);
			y += altura(tamanho);
		}
	};
	/** Rótulo à esquerda (com quebra) e valor à direita, na última linha do rótulo. */
	const par = (rotulo: string, valor: string, negrito: boolean, inicial = NORMAL) => {
		const fonte = negrito ? forte : comum;
		const v = imprimivel(valor);
		// Se o rótulo e o valor quase cabem numa linha, encolhe um pouco em vez de quebrar.
		const naLinha = (t: number) => fonte.widthOfTextAtSize(imprimivel(rotulo), t) + fonte.widthOfTextAtSize(v, t) + 12 <= util;
		let tamanho = inicial;
		while (tamanho > inicial * 0.8 && !naLinha(tamanho)) tamanho--;
		if (!naLinha(tamanho)) tamanho = inicial;
		const larguraDoValor = fonte.widthOfTextAtSize(v, tamanho);
		const linhas = quebrar(rotulo, fonte, tamanho, Math.max(util - larguraDoValor - 12, util / 3));
		linhas.forEach((l, i) => {
			escrever(l, fonte, tamanho, MARGEM, y);
			if (i === linhas.length - 1) escrever(v, fonte, tamanho, W - MARGEM - larguraDoValor, y);
			y += altura(tamanho);
		});
	};
	const separador = () => {
		const topo = y + 6;
		operacoes.push((H) => page.drawRectangle({ x: MARGEM, y: H - topo - 2, width: util, height: 2, color: PRETO }));
		y += 14;
	};

	if (opcoes.logotipo) {
		const imagem = opcoes.logotipo.tipo === "image/png" ? await pdf.embedPng(opcoes.logotipo.bytes) : await pdf.embedJpg(opcoes.logotipo.bytes);
		const escala = Math.min((util * 0.6) / imagem.width, 140 / imagem.height, 1);
		const w = Math.round(imagem.width * escala);
		const h = Math.round(imagem.height * escala);
		const topo = y;
		operacoes.push((H) => page.drawImage(imagem, { x: Math.round((W - w) / 2), y: H - topo - h, width: w, height: h }));
		y += h + 10;
	}

	const linha = (l: Linha) => {
		switch (l.tipo) {
			case "texto":
				if (l.texto) paragrafo(l.texto, l.alinhamento, l.negrito, l.tamanho === "dobrado" ? DOBRADO : NORMAL);
				break;
			case "separador":
				separador();
				break;
			case "item":
				paragrafo(`${l.codigo} ${l.descricao}`, "esquerda", false, NORMAL);
				par(`${l.quantidadeTexto} ${l.unidade} x ${l.valorUnitarioTexto}`, l.valorTotalTexto, false);
				break;
			case "par":
				par(l.rotulo, l.valor, l.negrito);
				break;
			case "chave":
				paragrafo(chaveEmBlocos(l.chave), "centro", false, NORMAL);
				break;
			case "qrcode": {
				const qr = matrizQr(l.texto);
				// Pelo menos 25 mm de código (200 pontos), com a margem de quatro módulos, se couber na bobina.
				let modulo = Math.ceil((l.tamanhoMinimoMm * 8) / qr.modulos);
				if (modulo * (qr.modulos + 8) > util) modulo = Math.max(1, Math.floor(util / (qr.modulos + 8)));
				const topo = y + 4 * modulo;
				operacoes.push((H) => desenharQr(page, qr, Math.round((W - qr.modulos * modulo) / 2), H - topo, modulo));
				y = topo + (qr.modulos + 4) * modulo;
				break;
			}
		}
	};

	for (const secao of cupom.secoes) {
		if (secao.divisao === "itens") {
			separador();
			par("Código Descrição", "", true, MENOR);
			par("Qtde UN x Vl Unit", "Vl Total", true, MENOR);
		}
		if (secao.divisao === "totais") separador();
		for (const l of secao.linhas) linha(l);
		y += secao.divisao === "itens" ? 0 : 8;
	}

	const H = Math.ceil(y + MARGEM);
	page.setSize(W, H);
	for (const desenhar of operacoes) desenhar(H);
	return pdf.save();
}
