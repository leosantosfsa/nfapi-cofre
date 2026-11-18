// Leitura do XML arquivado (nfeProc ou NFe assinada) e formatação dos valores
// como vão impressos no DANFE e no DANFE NFC-e.

import { DOMParser } from "@xmldom/xmldom";

export interface No {
	nodeType: number;
	localName: string | null;
	textContent: string | null;
	childNodes: { length: number; item(i: number): unknown };
}

export function filhos(pai: No | undefined, nome: string): No[] {
	const saida: No[] = [];
	if (!pai) return saida;
	for (let i = 0; i < pai.childNodes.length; i++) {
		const n = pai.childNodes.item(i) as No;
		if (n.nodeType === 1 && n.localName === nome) saida.push(n);
	}
	return saida;
}
export const filho = (pai: No | undefined, nome: string) => filhos(pai, nome)[0];
export const texto = (pai: No | undefined, nome: string) => filho(pai, nome)?.textContent?.trim() || undefined;
/** Primeiro elemento com o nome dado, em qualquer profundidade. */
export function primeiro(raiz: No | undefined, nome: string): No | undefined {
	if (!raiz) return undefined;
	if (raiz.localName === nome) return raiz;
	for (let i = 0; i < raiz.childNodes.length; i++) {
		const n = raiz.childNodes.item(i) as No;
		const achado = n.nodeType === 1 ? primeiro(n, nome) : undefined;
		if (achado) return achado;
	}
	return undefined;
}
export const atributo = (no: No | undefined, nome: string) => (no as unknown as { getAttribute(n: string): string | null } | undefined)?.getAttribute(nome) ?? undefined;

/** Raiz do XML, ou undefined quando o texto não é um XML. */
export function raizDoXml(xml: string): No | undefined {
	try {
		return (new DOMParser({ onError: () => undefined }).parseFromString(xml, "application/xml").documentElement as unknown as No) ?? undefined;
	} catch {
		return undefined;
	}
}

export const numero = (v: string | undefined) => Number(v ?? 0) || 0;

/** 1234.5 -> "1.234,50" */
export function dinheiro(valor: number, casas = 2): string {
	const [inteiro, fracao] = valor.toFixed(casas).split(".");
	const milhar = (inteiro as string).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	return fracao ? `${milhar},${fracao}` : milhar;
}

/** Valor do XML com as casas que ele traz, entre o mínimo e o máximo: "1.5000" -> "1,50". */
export function decimal(valor: string | undefined, minimo = 2, maximo = 4): string {
	if (!valor) return "";
	const casas = (valor.split(".")[1] ?? "").replace(/0+$/, "").length;
	return dinheiro(Number(valor), Math.min(maximo, Math.max(minimo, casas)));
}

/** CNPJ (numérico ou alfanumérico) e CPF com a pontuação usual. */
export function documento(doc: string | undefined): string {
	if (!doc) return "";
	if (doc.length === 14) return doc.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
	if (doc.length === 11) return doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
	return doc;
}

/** "2026-11-17T07:08:41-03:00" -> "17/11/2026 07:08:41". A data do XML já está no horário local. */
export function dataHora(iso: string | undefined): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso ?? "");
	return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : "";
}
/** "2026-11-17..." -> "17/11/2026" */
export function data(iso: string | undefined): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
	return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
export const hora = (iso: string | undefined) => /T(\d{2}:\d{2}:\d{2})/.exec(iso ?? "")?.[1] ?? "";

export function cep(valor: string | undefined): string {
	return valor && /^\d{8}$/.test(valor) ? `${valor.slice(0, 5)}-${valor.slice(5)}` : (valor ?? "");
}
export function telefone(valor: string | undefined): string {
	if (!valor) return "";
	if (/^\d{10}$/.test(valor)) return `(${valor.slice(0, 2)}) ${valor.slice(2, 6)}-${valor.slice(6)}`;
	if (/^\d{11}$/.test(valor)) return `(${valor.slice(0, 2)}) ${valor.slice(2, 7)}-${valor.slice(7)}`;
	return valor;
}

/** Chave de acesso em 11 blocos de 4. */
export const chaveEmBlocos = (chave: string) => chave.replace(/(.{4})(?=.)/g, "$1 ");

/** Logradouro, número, complemento e bairro, seguidos de município e UF. */
export function endereco(e: No | undefined): string {
	if (!e) return "";
	const partes = [texto(e, "xLgr"), texto(e, "nro"), texto(e, "xCpl"), texto(e, "xBairro")].filter(Boolean).join(", ");
	const cidade = [texto(e, "xMun"), texto(e, "UF")].filter(Boolean).join(" - ");
	return [partes, cidade].filter(Boolean).join(", ");
}

/** Logotipo do emitente, como foi enviado ao cofre. */
export interface Logotipo {
	bytes: Uint8Array;
	tipo: "image/png" | "image/jpeg";
}
