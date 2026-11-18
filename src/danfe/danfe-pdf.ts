// DANFE da NF-e (modelo 55) em PDF, A4 retrato, montado a partir do XML arquivado.
//
// Segue os quadros do DANFE do Manual de Orientação do Contribuinte: canhoto,
// identificação do emitente, chave de acesso com código de barras, destinatário,
// fatura, cálculo do imposto, transportador, itens e dados adicionais. Os itens
// que não cabem na primeira folha continuam nas seguintes, com o cabeçalho
// repetido.
//
// A reforma tributária ainda não definiu campos de IBS, CBS e Imposto Seletivo
// no DANFE (a NT 2025.002 diz que o leiaute está em estudo): os totais desses
// tributos saem nas informações complementares.
//
// Medidas em milímetros, com a origem no canto superior esquerdo da folha.

import { type PDFFont, type PDFImage, type PDFPage, PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { PRETO, desenharCode128, encurtar, imprimivel, quebrar } from "./desenho";
import {
	type Logotipo, type No, atributo, cep, chaveEmBlocos, data, dataHora, decimal, dinheiro, documento, filho, filhos, hora, numero, primeiro, raizDoXml,
	telefone, texto,
} from "./leitura";

export class DanfeError extends Error {}

const MM = 72 / 25.4;
const ALTURA = 297;
const X0 = 5;
const LARGURA = 200;
const FIM = 292;
/** Altura do cabeçalho repetido em todas as folhas: emitente, natureza da operação e inscrições. */
const CABECALHO = 46;
const CAMPO = 7;
const TITULO = 3.5;
/** Tamanho e entrelinha do texto dos itens e dos dados adicionais. */
const MIUDO = 6.5;
const ENTRELINHA = 2.5;

type Alinhar = "esquerda" | "centro" | "direita";

class Folha {
	readonly page: PDFPage;
	readonly comum: PDFFont;
	readonly forte: PDFFont;

	constructor(page: PDFPage, comum: PDFFont, forte: PDFFont) {
		this.page = page;
		this.comum = comum;
		this.forte = forte;
	}

	private y(mm: number): number {
		return (ALTURA - mm) * MM;
	}

	caixa(x: number, y: number, w: number, h: number): void {
		this.page.drawRectangle({ x: x * MM, y: this.y(y + h), width: w * MM, height: h * MM, borderColor: PRETO, borderWidth: 0.5 });
	}

	linha(x1: number, y1: number, x2: number, y2: number, tracejada = false): void {
		this.page.drawLine({
			start: { x: x1 * MM, y: this.y(y1) },
			end: { x: x2 * MM, y: this.y(y2) },
			thickness: tracejada ? 0.4 : 0.5,
			color: PRETO,
			dashArray: tracejada ? [3, 2] : undefined,
		});
	}

	/** Texto com a linha de base em y. `w` é a largura da área, usada para centralizar ou alinhar à direita. */
	texto(t: string, x: number, y: number, tamanho: number, o: { negrito?: boolean; alinhar?: Alinhar; w?: number } = {}): void {
		const s = imprimivel(t);
		if (!s) return;
		const fonte = o.negrito ? this.forte : this.comum;
		const largura = fonte.widthOfTextAtSize(s, tamanho) / MM;
		const dx = o.alinhar === "centro" ? ((o.w ?? 0) - largura) / 2 : o.alinhar === "direita" ? (o.w ?? 0) - largura : 0;
		this.page.drawText(s, { x: (x + dx) * MM, y: this.y(y), size: tamanho, font: fonte, color: PRETO });
	}

	/** Texto de uma linha que encolhe até o mínimo e, se ainda não couber em w, é cortado. */
	ajustado(t: string, x: number, y: number, w: number, tamanho: number, o: { negrito?: boolean; alinhar?: Alinhar; minimo?: number } = {}): void {
		const fonte = o.negrito ? this.forte : this.comum;
		const s = imprimivel(t);
		let tam = tamanho;
		while (tam > (o.minimo ?? tamanho * 0.7) && fonte.widthOfTextAtSize(s, tam) > w * MM) tam -= 0.25;
		this.texto(encurtar(s, fonte, tam, w * MM), x, y, tam, { negrito: o.negrito, alinhar: o.alinhar, w });
	}

	/** Quadro com o rótulo miúdo em cima e o valor embaixo. */
	campo(x: number, y: number, w: number, h: number, rotulo: string, valor: string | undefined, o: { negrito?: boolean; alinhar?: Alinhar; tamanho?: number } = {}): void {
		this.caixa(x, y, w, h);
		this.ajustado(rotulo, x + 0.8, y + 2.1, w - 1.6, 5, { minimo: 3.6 });
		if (valor) this.ajustado(valor, x + 0.8, y + h - 1.5, w - 1.6, o.tamanho ?? 8, { negrito: o.negrito, alinhar: o.alinhar, minimo: 5 });
	}

	/** Uma fileira de campos lado a lado, da esquerda para a direita. */
	fileira(y: number, campos: Array<[rotulo: string, valor: string | undefined, w: number, alinhar?: Alinhar]>): void {
		let x = X0;
		for (const [rotulo, valor, w, alinhar] of campos) {
			this.campo(x, y, w, CAMPO, rotulo, valor, { alinhar });
			x += w;
		}
	}

	titulo(y: number, t: string): void {
		this.texto(t, X0, y + 2.7, 6, { negrito: true });
	}

	/** Linhas de texto já quebradas, uma embaixo da outra. */
	bloco(linhas: string[], x: number, y: number, tamanho: number, entrelinha: number, o: { negrito?: boolean; alinhar?: Alinhar; w?: number } = {}): void {
		linhas.forEach((l, i) => this.texto(l, x, y + i * entrelinha, tamanho, o));
	}

	quebrar(t: string, w: number, tamanho: number, negrito = false): string[] {
		return quebrar(t, negrito ? this.forte : this.comum, tamanho, w * MM);
	}

	/** Imagem ajustada dentro da área, sem distorcer, centralizada. */
	imagem(imagem: PDFImage, x: number, y: number, w: number, h: number): void {
		const escala = Math.min((w * MM) / imagem.width, (h * MM) / imagem.height);
		const lw = imagem.width * escala;
		const lh = imagem.height * escala;
		this.page.drawImage(imagem, { x: x * MM + (w * MM - lw) / 2, y: this.y(y + h) + (h * MM - lh) / 2, width: lw, height: lh });
	}

	barras(conteudo: string, x: number, y: number, w: number, h: number): void {
		desenharCode128(this.page, conteudo, x * MM, this.y(y + h), w * MM, h * MM);
	}

	/** Dizer em diagonal sobre a folha: nota cancelada ou sem valor fiscal. */
	marca(t: string, tamanho: number, cor: [number, number, number], opacidade: number): void {
		const largura = this.forte.widthOfTextAtSize(t, tamanho);
		const seno = Math.SQRT1_2;
		this.page.drawText(t, {
			x: (210 * MM) / 2 - (largura / 2) * seno + tamanho * 0.25 * seno,
			y: (ALTURA * MM) / 2 - (largura / 2) * seno - tamanho * 0.25 * seno,
			size: tamanho,
			font: this.forte,
			color: rgb(...cor),
			opacity: opacidade,
			rotate: degrees(45),
		});
	}
}

const FRETE: Record<string, string> = {
	"0": "0 - Remetente (CIF)",
	"1": "1 - Destinatário (FOB)",
	"2": "2 - Terceiros",
	"3": "3 - Próprio Remetente",
	"4": "4 - Próprio Destinatário",
	"9": "9 - Sem Frete",
};

/** Colunas do quadro de itens: rótulo (duas linhas), largura e alinhamento. As larguras somam 200 mm. */
const COLUNAS: Array<{ rotulo: [string, string]; w: number; alinhar: Alinhar }> = [
	{ rotulo: ["CÓDIGO", "PRODUTO"], w: 17, alinhar: "esquerda" },
	{ rotulo: ["DESCRIÇÃO DO", "PRODUTO / SERVIÇO"], w: 55, alinhar: "esquerda" },
	{ rotulo: ["NCM/SH", ""], w: 13, alinhar: "centro" },
	{ rotulo: ["O/CST", ""], w: 9, alinhar: "centro" },
	{ rotulo: ["CFOP", ""], w: 8, alinhar: "centro" },
	{ rotulo: ["UN", ""], w: 7, alinhar: "centro" },
	{ rotulo: ["QUANT.", ""], w: 13, alinhar: "direita" },
	{ rotulo: ["VALOR", "UNIT."], w: 14, alinhar: "direita" },
	{ rotulo: ["VALOR", "TOTAL"], w: 14, alinhar: "direita" },
	{ rotulo: ["B. CÁLC.", "ICMS"], w: 13, alinhar: "direita" },
	{ rotulo: ["VALOR", "ICMS"], w: 11, alinhar: "direita" },
	{ rotulo: ["VALOR", "IPI"], w: 10, alinhar: "direita" },
	{ rotulo: ["ALÍQ.", "ICMS"], w: 8, alinhar: "direita" },
	{ rotulo: ["ALÍQ.", "IPI"], w: 8, alinhar: "direita" },
];
const CABECALHO_DOS_ITENS = 6;

interface LinhaDeItem {
	celulas: string[][];
	h: number;
}

const moeda = (pai: No | undefined, nome: string) => dinheiro(numero(texto(pai, nome)));
const numeroDaNota = (n: string) => n.padStart(9, "0").replace(/(\d{3})(?=\d)/g, "$1.");

export async function gerarDanfePdf(xml: string, opcoes: { cancelada?: boolean; logotipo?: Logotipo } = {}): Promise<Uint8Array> {
	const raiz = raizDoXml(xml);
	const inf = primeiro(raiz, "infNFe");
	const ide = filho(inf, "ide");
	if (!raiz || !inf || !ide || texto(ide, "mod") !== "55") throw new DanfeError("O XML arquivado não é de uma NF-e.");
	const prot = primeiro(raiz, "infProt");
	if (!texto(prot, "nProt")) throw new DanfeError("A NF-e arquivada não tem protocolo de autorização.");

	const emit = filho(inf, "emit");
	const enderEmit = filho(emit, "enderEmit");
	const dest = filho(inf, "dest");
	const enderDest = filho(dest, "enderDest");
	const tot = filho(filho(inf, "total"), "ICMSTot");
	const transp = filho(inf, "transp");
	const cobr = filho(inf, "cobr");
	const adic = filho(inf, "infAdic");
	const chave = atributo(inf, "Id")?.replace(/^NFe/, "") ?? "";
	const homologacao = texto(ide, "tpAmb") === "2";
	const simples = ["1", "4"].includes(texto(emit, "CRT") ?? "");
	const nNF = numeroDaNota(texto(ide, "nNF") ?? "");
	const serie = (texto(ide, "serie") ?? "").padStart(3, "0");
	const nomeEmit = texto(emit, "xNome") ?? "";

	const pdf = await PDFDocument.create();
	pdf.setTitle(`DANFE ${chave}`);
	pdf.setCreator("Cofre NFapi");
	pdf.setProducer("Cofre NFapi");
	const comum = await pdf.embedFont(StandardFonts.Helvetica);
	const forte = await pdf.embedFont(StandardFonts.HelveticaBold);
	const logotipo = opcoes.logotipo ? (opcoes.logotipo.tipo === "image/png" ? await pdf.embedPng(opcoes.logotipo.bytes) : await pdf.embedJpg(opcoes.logotipo.bytes)) : undefined;
	const medida = new Folha(undefined as unknown as PDFPage, comum, forte);

	// ----- Itens: o texto de cada célula e a altura de cada linha -----
	const linhas: LinhaDeItem[] = filhos(inf, "det").map((det) => {
		const prod = filho(det, "prod");
		const imposto = filho(det, "imposto");
		const icms = primeiroFilho(filho(imposto, "ICMS"));
		const ipi = filho(filho(imposto, "IPI"), "IPITrib");
		const descricao = [texto(prod, "xProd") ?? ""];
		const infAdProd = texto(det, "infAdProd");
		if (infAdProd) descricao.push(infAdProd);
		for (const di of filhos(prod, "DI")) {
			descricao.push(`DI ${texto(di, "nDI") ?? ""} de ${data(texto(di, "dDI"))}, desembaraço em ${texto(di, "xLocDesemb") ?? ""}/${texto(di, "UFDesemb") ?? ""}`);
		}
		if (numero(texto(icms, "vICMSST")) > 0) descricao.push(`BC ICMS ST: ${moeda(icms, "vBCST")}  ICMS ST: ${moeda(icms, "vICMSST")}`);
		const valores = [
			texto(prod, "cProd") ?? "",
			descricao.join("\n"),
			texto(prod, "NCM") ?? "",
			`${texto(icms, "orig") ?? ""}${texto(icms, "CST") ?? texto(icms, "CSOSN") ?? ""}`,
			texto(prod, "CFOP") ?? "",
			texto(prod, "uCom") ?? "",
			decimal(texto(prod, "qCom"), 2, 4),
			decimal(texto(prod, "vUnCom"), 2, 4),
			moeda(prod, "vProd"),
			moeda(icms, "vBC"),
			moeda(icms, "vICMS"),
			moeda(ipi, "vIPI"),
			decimal(texto(icms, "pICMS") ?? "0", 2, 2),
			decimal(texto(ipi, "pIPI") ?? "0", 2, 2),
		];
		// Só o código e a descrição quebram em várias linhas; os demais valores encolhem para caber.
		const celulas = valores.map((v, i) => (i <= 1 ? medida.quebrar(v, (COLUNAS[i] as (typeof COLUNAS)[number]).w - 1.4, MIUDO) : [v]));
		return { celulas, h: Math.max(...celulas.map((c) => c.length)) * ENTRELINHA + 1 };
	});

	// ----- Dados adicionais -----
	const complementares: string[] = [];
	const infCpl = texto(adic, "infCpl");
	if (infCpl) complementares.push(infCpl);
	const rtc = filho(filho(inf, "total"), "IBSCBSTot");
	if (rtc) {
		const gIbs = filho(rtc, "gIBS");
		const gCbs = filho(rtc, "gCBS");
		const partes = [`Base de cálculo do IBS e da CBS: R$ ${moeda(rtc, "vBCIBSCBS")}`];
		if (gIbs) partes.push(`IBS: R$ ${moeda(gIbs, "vIBS")} (estadual R$ ${moeda(filho(gIbs, "gIBSUF"), "vIBSUF")}, municipal R$ ${moeda(filho(gIbs, "gIBSMun"), "vIBSMun")})`);
		if (gCbs) partes.push(`CBS: R$ ${moeda(gCbs, "vCBS")}`);
		complementares.push(`${partes.join("; ")}.`);
	}
	const vIS = texto(filho(filho(inf, "total"), "ISTot"), "vIS");
	if (vIS) complementares.push(`Imposto Seletivo: R$ ${dinheiro(numero(vIS))}.`);
	const exporta = filho(inf, "exporta");
	if (exporta) {
		const despacho = texto(exporta, "xLocDespacho");
		complementares.push(`Local de embarque: ${texto(exporta, "xLocExporta") ?? ""} - ${texto(exporta, "UFSaidaPais") ?? ""}${despacho ? `; local de despacho: ${despacho}` : ""}.`);
	}
	const LARGURA_CPL = 130;
	const linhasCpl = complementares.flatMap((p) => medida.quebrar(p, LARGURA_CPL - 2, MIUDO));
	const linhasFisco = medida.quebrar(texto(adic, "infAdFisco") ?? "", LARGURA - LARGURA_CPL - 2, MIUDO);
	const alturaAdic = Math.min(70, Math.max(25, 4 + Math.max(linhasCpl.length, linhasFisco.length) * ENTRELINHA));
	const cabemNoQuadro = Math.floor((alturaAdic - 4) / ENTRELINHA);
	const sobra = linhasCpl.length > cabemNoQuadro ? medida.quebrar(linhasCpl.slice(cabemNoQuadro).join(" "), LARGURA - 2, MIUDO) : [];

	// ----- Fatura e duplicatas -----
	const fat = filho(cobr, "fat");
	const duplicatas = filhos(cobr, "dup").slice(0, 30);
	const POR_FILEIRA = 5;
	const fileirasDeFatura = duplicatas.length ? Math.ceil(duplicatas.length / POR_FILEIRA) : fat ? 1 : 0;

	// ----- Distribuição dos itens pelas folhas -----
	const TOPO_1 = 5 + 16 + 4; // canhoto e linha de corte
	const topoDest = TOPO_1 + CABECALHO;
	const topoFatura = topoDest + TITULO + 3 * CAMPO;
	const topoImposto = topoFatura + (fileirasDeFatura ? TITULO + fileirasDeFatura * CAMPO : 0);
	const topoTransp = topoImposto + TITULO + 2 * CAMPO;
	const topoItens1 = topoTransp + TITULO + 3 * CAMPO;
	const topoAdic = FIM - alturaAdic - TITULO;
	const TOPO_CONT = 5 + CABECALHO;

	interface Plano {
		linhas: LinhaDeItem[];
		topo: number;
		fim: number;
	}
	const plano: Plano[] = [{ linhas: [], topo: topoItens1, fim: topoAdic }];
	let livre = topoAdic - topoItens1 - TITULO - CABECALHO_DOS_ITENS;
	for (const l of linhas) {
		const atual = plano.at(-1) as Plano;
		if (l.h > livre && (atual.linhas.length > 0 || plano.length === 1)) {
			plano.push({ linhas: [l], topo: TOPO_CONT, fim: FIM });
			livre = FIM - TOPO_CONT - TITULO - CABECALHO_DOS_ITENS - l.h;
			continue;
		}
		atual.linhas.push(l);
		livre -= l.h;
	}
	let continuacao: { folha: number; topo: number } | undefined;
	if (sobra.length) {
		const necessario = TITULO + 3 + sobra.length * ENTRELINHA;
		const ultima = plano.at(-1) as Plano;
		const fimDasLinhas = ultima.topo + TITULO + CABECALHO_DOS_ITENS + ultima.linhas.reduce((s, l) => s + l.h, 0);
		if (plano.length > 1 && fimDasLinhas + 1 + necessario <= FIM) {
			ultima.fim = fimDasLinhas;
			continuacao = { folha: plano.length - 1, topo: fimDasLinhas + 1 };
		} else {
			plano.push({ linhas: [], topo: -1, fim: -1 });
			continuacao = { folha: plano.length - 1, topo: TOPO_CONT };
		}
	}

	// ----- Desenho -----
	const cabecalho = (f: Folha, topo: number, folha: number) => {
		// Emitente
		f.caixa(X0, topo, 80, 32);
		f.texto("IDENTIFICAÇÃO DO EMITENTE", X0 + 0.8, topo + 2.1, 5);
		const xTexto = logotipo ? X0 + 26 : X0 + 1;
		const wTexto = logotipo ? 53 : 78;
		if (logotipo) f.imagem(logotipo, X0 + 1.5, topo + 5, 23, 24);
		const nome = f.quebrar(nomeEmit, wTexto, 9, true).slice(0, 3);
		const linhasEnd = [
			`${texto(enderEmit, "xLgr") ?? ""}, ${texto(enderEmit, "nro") ?? ""}${texto(enderEmit, "xCpl") ? ` - ${texto(enderEmit, "xCpl")}` : ""}`,
			`${texto(enderEmit, "xBairro") ?? ""} - CEP ${cep(texto(enderEmit, "CEP"))}`,
			`${texto(enderEmit, "xMun") ?? ""} - ${texto(enderEmit, "UF") ?? ""}`,
			texto(enderEmit, "fone") ? `Fone: ${telefone(texto(enderEmit, "fone"))}` : "",
		]
			.filter(Boolean)
			.flatMap((l) => f.quebrar(l, wTexto, 7));
		const alturaDoTexto = nome.length * 3.8 + 1 + linhasEnd.length * 2.9;
		const inicio = topo + 3 + Math.max(0, (29 - alturaDoTexto) / 2) + 3;
		f.bloco(nome, xTexto, inicio, 9, 3.8, { negrito: true, alinhar: "centro", w: wTexto });
		f.bloco(linhasEnd, xTexto, inicio + nome.length * 3.8 + 0.6, 7, 2.9, { alinhar: "centro", w: wTexto });

		// Quadro DANFE
		const xd = X0 + 80;
		f.caixa(xd, topo, 35, 32);
		f.texto("DANFE", xd, topo + 5.5, 12, { negrito: true, alinhar: "centro", w: 35 });
		f.texto("Documento Auxiliar da", xd, topo + 8.6, 6, { alinhar: "centro", w: 35 });
		f.texto("Nota Fiscal Eletrônica", xd, topo + 11, 6, { alinhar: "centro", w: 35 });
		f.texto("0 - ENTRADA", xd + 3, topo + 15.6, 6.5);
		f.texto("1 - SAÍDA", xd + 3, topo + 18.6, 6.5);
		f.caixa(xd + 24, topo + 12.8, 6, 6.6);
		f.texto(texto(ide, "tpNF") ?? "", xd + 24, topo + 17.4, 10, { negrito: true, alinhar: "centro", w: 6 });
		f.texto(`Nº ${nNF}`, xd, topo + 23.6, 8.5, { negrito: true, alinhar: "centro", w: 35 });
		f.texto(`SÉRIE ${serie}`, xd, topo + 27.1, 8.5, { negrito: true, alinhar: "centro", w: 35 });
		f.texto(`FOLHA ${folha}/${plano.length}`, xd, topo + 30.6, 7, { negrito: true, alinhar: "centro", w: 35 });

		// Código de barras, chave de acesso e consulta
		const xc = X0 + 115;
		f.caixa(xc, topo, 85, 13);
		f.barras(chave, xc + 4, topo + 1.5, 77, 10);
		f.campo(xc, topo + 13, 85, CAMPO, "CHAVE DE ACESSO", chaveEmBlocos(chave), { negrito: true, alinhar: "centro", tamanho: 7.5 });
		f.caixa(xc, topo + 20, 85, 12);
		f.texto("Consulta de autenticidade no portal nacional da NF-e", xc, topo + 24.6, 6.5, { alinhar: "centro", w: 85 });
		f.texto("www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora", xc, topo + 28, 6.5, { alinhar: "centro", w: 85 });

		f.campo(X0, topo + 32, 115, CAMPO, "NATUREZA DA OPERAÇÃO", texto(ide, "natOp"));
		f.campo(xc, topo + 32, 85, CAMPO, "PROTOCOLO DE AUTORIZAÇÃO DE USO", `${texto(prot, "nProt")} - ${dataHora(texto(prot, "dhRecbto"))}`, { negrito: true, alinhar: "centro" });
		f.fileira(topo + 39, [
			["INSCRIÇÃO ESTADUAL", texto(emit, "IE"), 66],
			["INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.", texto(emit, "IEST"), 67],
			["CNPJ", documento(texto(emit, "CNPJ") ?? texto(emit, "CPF")), 67],
		]);
	};

	const itens = (f: Folha, p: Plano) => {
		f.titulo(p.topo, "DADOS DOS PRODUTOS / SERVIÇOS");
		const topo = p.topo + TITULO;
		f.caixa(X0, topo, LARGURA, p.fim - topo);
		f.linha(X0, topo + CABECALHO_DOS_ITENS, X0 + LARGURA, topo + CABECALHO_DOS_ITENS);
		let x = X0;
		COLUNAS.forEach((col, i) => {
			if (i > 0) f.linha(x, topo, x, p.fim);
			const rotulo: [string, string] = i === 3 && simples ? ["O/CSOSN", ""] : col.rotulo;
			if (rotulo[1]) {
				f.ajustado(rotulo[0], x + 0.4, topo + 2.4, col.w - 0.8, 5, { alinhar: "centro", minimo: 3.6 });
				f.ajustado(rotulo[1], x + 0.4, topo + 4.7, col.w - 0.8, 5, { alinhar: "centro", minimo: 3.6 });
			} else f.ajustado(rotulo[0], x + 0.4, topo + 3.6, col.w - 0.8, 5, { alinhar: "centro", minimo: 3.6 });
			x += col.w;
		});
		let y = topo + CABECALHO_DOS_ITENS;
		for (const l of p.linhas) {
			let xc = X0;
			l.celulas.forEach((celula, i) => {
				const col = COLUNAS[i] as (typeof COLUNAS)[number];
				if (i <= 1) f.bloco(celula, xc + 0.7, y + 2.6, MIUDO, ENTRELINHA, { alinhar: col.alinhar, w: col.w - 1.4 });
				else f.ajustado(celula[0] ?? "", xc + 0.7, y + 2.6, col.w - 1.4, MIUDO, { alinhar: col.alinhar, minimo: 4 });
				xc += col.w;
			});
			y += l.h;
		}
	};

	plano.forEach((p, i) => {
		const f = new Folha(pdf.addPage([210 * MM, ALTURA * MM]), comum, forte);
		const primeira = i === 0;

		if (primeira) {
			// Canhoto
			const recebemos =
				`RECEBEMOS DE ${nomeEmit} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO. ` +
				`EMISSÃO: ${data(texto(ide, "dhEmi"))}  VALOR TOTAL: R$ ${moeda(tot, "vNF")}  DESTINATÁRIO: ${texto(dest, "xNome") ?? ""}`;
			f.caixa(X0, 5, 165, 8);
			f.bloco(f.quebrar(recebemos, 162, 5.5).slice(0, 3), X0 + 1, 7.3, 5.5, 2.2);
			f.campo(X0, 13, 35, 8, "DATA DE RECEBIMENTO", undefined);
			f.campo(X0 + 35, 13, 130, 8, "IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR", undefined);
			f.caixa(X0 + 165, 5, 35, 16);
			f.texto("NF-e", X0 + 165, 9.5, 10, { negrito: true, alinhar: "centro", w: 35 });
			f.texto(`Nº ${nNF}`, X0 + 165, 14, 8.5, { negrito: true, alinhar: "centro", w: 35 });
			f.texto(`SÉRIE ${serie}`, X0 + 165, 18.2, 8.5, { negrito: true, alinhar: "centro", w: 35 });
			f.linha(X0, 23, X0 + LARGURA, 23, true);
		}
		cabecalho(f, primeira ? TOPO_1 : 5, i + 1);

		if (primeira) {
			// Destinatário ou remetente
			const exterior = texto(enderDest, "UF") === "EX";
			f.titulo(topoDest, "DESTINATÁRIO / REMETENTE");
			let y = topoDest + TITULO;
			f.fileira(y, [
				["NOME / RAZÃO SOCIAL", texto(dest, "xNome"), 120],
				["CNPJ / CPF", documento(texto(dest, "CNPJ") ?? texto(dest, "CPF")) || texto(dest, "idEstrangeiro"), 45],
				["DATA DA EMISSÃO", data(texto(ide, "dhEmi")), 35, "centro"],
			]);
			y += CAMPO;
			f.fileira(y, [
				["ENDEREÇO", [texto(enderDest, "xLgr"), texto(enderDest, "nro"), texto(enderDest, "xCpl")].filter(Boolean).join(", "), 95],
				["BAIRRO / DISTRITO", texto(enderDest, "xBairro"), 45],
				["CEP", cep(texto(enderDest, "CEP")), 25],
				["DATA DA SAÍDA/ENTRADA", data(texto(ide, "dhSaiEnt")), 35, "centro"],
			]);
			y += CAMPO;
			f.fileira(y, [
				["MUNICÍPIO", `${texto(enderDest, "xMun") ?? ""}${exterior && texto(enderDest, "xPais") ? ` - ${texto(enderDest, "xPais")}` : ""}`, 75],
				["UF", texto(enderDest, "UF"), 10, "centro"],
				["FONE / FAX", telefone(texto(enderDest, "fone")), 35],
				["INSCRIÇÃO ESTADUAL", texto(dest, "IE"), 45],
				["HORA DA SAÍDA/ENTRADA", hora(texto(ide, "dhSaiEnt")), 35, "centro"],
			]);

			// Fatura e duplicatas
			if (fileirasDeFatura) {
				f.titulo(topoFatura, "FATURA / DUPLICATA");
				const yf = topoFatura + TITULO;
				if (duplicatas.length) {
					duplicatas.forEach((dup, n) => {
						const w = LARGURA / POR_FILEIRA;
						f.campo(X0 + (n % POR_FILEIRA) * w, yf + Math.floor(n / POR_FILEIRA) * CAMPO, w, CAMPO, `DUPLICATA ${texto(dup, "nDup") ?? ""}`, `${data(texto(dup, "dVenc"))}   R$ ${moeda(dup, "vDup")}`, {
							tamanho: 7.5,
						});
					});
				} else {
					f.fileira(yf, [
						["FATURA", texto(fat, "nFat"), 50],
						["VALOR ORIGINAL", moeda(fat, "vOrig"), 50, "direita"],
						["DESCONTO", moeda(fat, "vDesc"), 50, "direita"],
						["VALOR LÍQUIDO", moeda(fat, "vLiq"), 50, "direita"],
					]);
				}
			}

			// Cálculo do imposto
			f.titulo(topoImposto, "CÁLCULO DO IMPOSTO");
			const wi = LARGURA / 9;
			const imposto = (rotulos: Array<[string, string]>, yi: number) =>
				f.fileira(yi, rotulos.map(([rotulo, tag]): [string, string, number, Alinhar] => [rotulo, moeda(tot, tag), wi, "direita"]));
			imposto(
				[
					["BASE DE CÁLC. DO ICMS", "vBC"], ["VALOR DO ICMS", "vICMS"], ["BASE DE CÁLC. ICMS S.T.", "vBCST"], ["VALOR DO ICMS SUBST.", "vST"],
					["V. IMP. IMPORTAÇÃO", "vII"], ["V. ICMS UF REMET.", "vICMSUFRemet"], ["V. FCP UF DEST.", "vFCPUFDest"], ["VALOR DO PIS", "vPIS"],
					["V. TOTAL PRODUTOS", "vProd"],
				],
				topoImposto + TITULO,
			);
			imposto(
				[
					["VALOR DO FRETE", "vFrete"], ["VALOR DO SEGURO", "vSeg"], ["DESCONTO", "vDesc"], ["OUTRAS DESPESAS", "vOutro"],
					["VALOR TOTAL IPI", "vIPI"], ["V. ICMS UF DEST.", "vICMSUFDest"], ["V. TOT. TRIB.", "vTotTrib"], ["VALOR DA COFINS", "vCOFINS"],
					["V. TOTAL DA NOTA", "vNF"],
				],
				topoImposto + TITULO + CAMPO,
			);

			// Transportador e volumes
			const transporta = filho(transp, "transporta");
			const veiculo = filho(transp, "veicTransp");
			const volumes = filhos(transp, "vol");
			const soma = (tag: string) => volumes.reduce((s, v) => s + numero(texto(v, tag)), 0);
			const unico = (tag: string) => {
				const valores = [...new Set(volumes.map((v) => texto(v, tag)).filter(Boolean))];
				return valores.length > 1 ? "DIVERSOS" : valores[0];
			};
			f.titulo(topoTransp, "TRANSPORTADOR / VOLUMES TRANSPORTADOS");
			y = topoTransp + TITULO;
			f.fileira(y, [
				["NOME / RAZÃO SOCIAL", texto(transporta, "xNome"), 72],
				["FRETE POR CONTA", FRETE[texto(transp, "modFrete") ?? ""], 38],
				["CÓDIGO ANTT", texto(veiculo, "RNTC"), 20],
				["PLACA DO VEÍCULO", texto(veiculo, "placa"), 22, "centro"],
				["UF", texto(veiculo, "UF"), 8, "centro"],
				["CNPJ / CPF", documento(texto(transporta, "CNPJ") ?? texto(transporta, "CPF")), 40],
			]);
			y += CAMPO;
			f.fileira(y, [
				["ENDEREÇO", texto(transporta, "xEnder"), 92],
				["MUNICÍPIO", texto(transporta, "xMun"), 60],
				["UF", texto(transporta, "UF"), 8, "centro"],
				["INSCRIÇÃO ESTADUAL", texto(transporta, "IE"), 40],
			]);
			y += CAMPO;
			f.fileira(y, [
				["QUANTIDADE", volumes.length ? String(soma("qVol")) : undefined, 25, "direita"],
				["ESPÉCIE", unico("esp"), 35],
				["MARCA", unico("marca"), 35],
				["NUMERAÇÃO", unico("nVol"), 35],
				["PESO BRUTO", volumes.length ? dinheiro(soma("pesoB"), 3) : undefined, 35, "direita"],
				["PESO LÍQUIDO", volumes.length ? dinheiro(soma("pesoL"), 3) : undefined, 35, "direita"],
			]);

			// Dados adicionais
			f.titulo(topoAdic, "DADOS ADICIONAIS");
			const ya = topoAdic + TITULO;
			f.caixa(X0, ya, LARGURA_CPL, alturaAdic);
			f.texto("INFORMAÇÕES COMPLEMENTARES", X0 + 0.8, ya + 2.1, 5);
			f.bloco(linhasCpl.slice(0, cabemNoQuadro), X0 + 1, ya + 5.2, MIUDO, ENTRELINHA);
			f.caixa(X0 + LARGURA_CPL, ya, LARGURA - LARGURA_CPL, alturaAdic);
			f.texto("RESERVADO AO FISCO", X0 + LARGURA_CPL + 0.8, ya + 2.1, 5);
			f.bloco(linhasFisco.slice(0, cabemNoQuadro), X0 + LARGURA_CPL + 1, ya + 5.2, MIUDO, ENTRELINHA);
		}

		if (p.topo >= 0) itens(f, p);

		if (continuacao?.folha === i) {
			f.titulo(continuacao.topo, "DADOS ADICIONAIS (CONTINUAÇÃO)");
			const yc = continuacao.topo + TITULO;
			f.caixa(X0, yc, LARGURA, sobra.length * ENTRELINHA + 3);
			f.bloco(sobra, X0 + 1, yc + 3, MIUDO, ENTRELINHA);
		}

		if (opcoes.cancelada) f.marca("CANCELADA", 90, [0.8, 0, 0], 0.3);
		else if (homologacao) f.marca("SEM VALOR FISCAL", 60, [0.4, 0.4, 0.4], 0.25);
	});

	return pdf.save();
}

/** Primeiro elemento filho, seja qual for o nome (o grupo de ICMS muda de nome conforme a tributação). */
function primeiroFilho(pai: No | undefined): No | undefined {
	if (!pai) return undefined;
	for (let i = 0; i < pai.childNodes.length; i++) {
		const n = pai.childNodes.item(i) as No;
		if (n.nodeType === 1) return n;
	}
	return undefined;
}
