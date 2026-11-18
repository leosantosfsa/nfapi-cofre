// Planilha .xlsx mínima: abas com cabeçalho em negrito e congelado, texto e
// números. A chave de acesso tem 44 dígitos e precisa ir como texto, o que um
// CSV não garante quando é aberto no Excel.

import { zipStream } from "./zip";

export interface Coluna {
	titulo: string;
	/** `valor`: número com duas casas; `inteiro`: número sem casas; `texto`: como está. */
	tipo: "texto" | "valor" | "inteiro";
	/** Largura aproximada, em caracteres. */
	largura?: number;
}

export interface Aba {
	nome: string;
	colunas: Coluna[];
	linhas: (string | number | null)[][];
}

const escapar = (v: string) =>
	v
		// Caracteres de controle não são aceitos em XML 1.0.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/** Letras da coluna: 0 -> A, 25 -> Z, 26 -> AA. */
function letras(indice: number): string {
	let n = indice + 1;
	let s = "";
	while (n > 0) {
		s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

const ESTILO = { padrao: 0, cabecalho: 1, valor: 2 };

function celula(ref: string, valor: string | number | null, coluna: Coluna | undefined, cabecalho: boolean): string {
	if (valor === null || valor === "") return "";
	if (!cabecalho && typeof valor === "number" && Number.isFinite(valor) && coluna?.tipo !== "texto") {
		return `<c r="${ref}"${coluna?.tipo === "valor" ? ` s="${ESTILO.valor}"` : ""}><v>${valor}</v></c>`;
	}
	return `<c r="${ref}" t="inlineStr"${cabecalho ? ` s="${ESTILO.cabecalho}"` : ""}><is><t xml:space="preserve">${escapar(String(valor))}</t></is></c>`;
}

function folha(aba: Aba): string {
	const linha = (numero: number, valores: (string | number | null)[], cabecalho: boolean) =>
		`<row r="${numero}">${valores.map((v, i) => celula(`${letras(i)}${numero}`, v, aba.colunas[i], cabecalho)).join("")}</row>`;
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
		`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
		`<cols>${aba.colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura ?? 14}" customWidth="1"/>`).join("")}</cols>` +
		`<sheetData>${linha(1, aba.colunas.map((c) => c.titulo), true)}${aba.linhas.map((l, i) => linha(i + 2, l, false)).join("")}</sheetData>` +
		`</worksheet>`
	);
}

const ESTILOS =
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
	`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
	`<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
	`<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
	`<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
	`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
	`<cellXfs count="3">` +
	`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
	`<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
	// 4 = "#,##0.00", formato embutido.
	`<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
	`</cellXfs></styleSheet>`;

/** Monta o arquivo .xlsx com as abas dadas. O nome de cada aba tem até 31 caracteres. */
export async function planilhaXlsx(abas: Aba[], agora = new Date()): Promise<Uint8Array> {
	const nomes = abas.map((a) => escapar(a.nome.replace(/[\\/?*[\]:]/g, " ").slice(0, 31)));
	const arquivos: [string, string][] = [
		[
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
				`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
				`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
				`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
				abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
				`</Types>`,
		],
		[
			"_rels/.rels",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		],
		[
			"xl/workbook.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
				`<sheets>${nomes.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
		],
		[
			"xl/_rels/workbook.xml.rels",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
				`<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		],
		["xl/styles.xml", ESTILOS],
		...abas.map((a, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, folha(a)]),
	];
	const texto = new TextEncoder();
	const zip = zipStream(arquivos.map(([nome, conteudo]) => ({ nome, dados: async () => texto.encode(conteudo) })), agora);
	return new Uint8Array(await new Response(zip).arrayBuffer());
}
