// Formato das trocas com a API SEFIN Nacional: os XML viajam compactados
// (GZip) e em Base64, dentro de um JSON.

export interface Mensagem {
	codigo: string;
	descricao: string;
	complemento?: string;
}

export type RespostaEmissao =
	| {
			tipo: "autorizada";
			chaveAcesso: string;
			/** XML da NFS-e gerada e assinada pela SEFIN Nacional. */
			xml: string;
			numeroNfse: string | null;
			alertas: Mensagem[];
	  }
	| { tipo: "rejeitada"; rejeicoes: Mensagem[] }
	/** Não dá para saber se a nota foi gerada (erro do servidor, resposta fora do padrão). */
	| { tipo: "indefinida"; detalhe: string };

function bytesParaBase64(bytes: Uint8Array): string {
	let s = "";
	const bloco = 0x8000;
	for (let i = 0; i < bytes.length; i += bloco) {
		s += String.fromCharCode(...bytes.subarray(i, i + bloco));
	}
	return btoa(s);
}

function base64ParaBytes(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** O cofre transporta corpos em Base64; estes dois convertem texto UTF-8. */
export function textoParaBase64(texto: string): string {
	return bytesParaBase64(new TextEncoder().encode(texto));
}

export function base64ParaTexto(b64: string): string {
	return new TextDecoder().decode(base64ParaBytes(b64));
}

async function transformar(bytes: Uint8Array, fluxo: CompressionStream | DecompressionStream) {
	// A cópia garante um buffer próprio (os tipos do Workers e do DOM divergem aqui).
	const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(fluxo);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipBase64(texto: string): Promise<string> {
	const bytes = new TextEncoder().encode(texto);
	return bytesParaBase64(await transformar(bytes, new CompressionStream("gzip")));
}

export async function gunzipBase64(b64: string): Promise<string> {
	const bytes = await transformar(base64ParaBytes(b64), new DecompressionStream("gzip"));
	return new TextDecoder().decode(bytes);
}

const DECLARACAO_XML = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * A SEFIN exige a declaração XML com a codificação no início do documento
 * (rejeição E1229 sem ela), mesmo com o conteúdo já em UTF-8. A declaração fica
 * fora do elemento assinado, então pode ser acrescentada depois da assinatura.
 */
export function comDeclaracaoXml(xml: string): string {
	const semBom = xml.replace(/^﻿/, "");
	return semBom.trimStart().startsWith("<?xml") ? semBom : DECLARACAO_XML + semBom;
}

/** Corpo do POST /nfse. */
export async function corpoEmissao(dpsAssinada: string): Promise<string> {
	return JSON.stringify({ dpsXmlGZipB64: await gzipBase64(comDeclaracaoXml(dpsAssinada)) });
}

/** Corpo do POST /nfse/{chave}/eventos. */
export async function corpoEvento(pedidoAssinado: string): Promise<string> {
	return JSON.stringify({
		pedidoRegistroEventoXmlGZipB64: await gzipBase64(comDeclaracaoXml(pedidoAssinado)),
	});
}

/** A SEFIN varia a grafia das chaves (erros/erro, Codigo/codigo) conforme a rota. */
export function lerMensagens(valor: unknown): Mensagem[] {
	if (!valor) return [];
	const lista = Array.isArray(valor) ? valor : [valor];
	return lista
		.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
		.map((m) => {
			const complemento = m.Complemento ?? m.complemento;
			return {
				codigo: String(m.Codigo ?? m.codigo ?? ""),
				descricao: String(m.Descricao ?? m.descricao ?? m.Mensagem ?? m.mensagem ?? ""),
				...(complemento ? { complemento: String(complemento) } : {}),
			};
		});
}

export type RespostaEvento =
	/** `xml` é o evento registrado e assinado pela SEFIN Nacional. */
	| { tipo: "registrado"; xml: string }
	| { tipo: "rejeitada"; rejeicoes: Mensagem[] }
	| { tipo: "indefinida"; detalhe: string };

export async function lerRespostaEvento(status: number, corpo: string): Promise<RespostaEvento> {
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(corpo) as Record<string, unknown>;
	} catch {
		return { tipo: "indefinida", detalhe: `Resposta HTTP ${status} fora do formato esperado.` };
	}
	if (status >= 200 && status < 300 && typeof json.eventoXmlGZipB64 === "string") {
		return { tipo: "registrado", xml: await gunzipBase64(json.eventoXmlGZipB64) };
	}
	const rejeicoes = lerMensagens(json.erros ?? json.Erros ?? json.erro);
	if (status >= 400 && status < 500 && rejeicoes.length > 0) return { tipo: "rejeitada", rejeicoes };
	return {
		tipo: "indefinida",
		detalhe: rejeicoes[0]
			? `HTTP ${status}: ${rejeicoes[0].codigo} ${rejeicoes[0].descricao}`.trim()
			: `Resposta HTTP ${status} sem o evento registrado nem mensagens de erro.`,
	};
}

export async function lerRespostaEmissao(status: number, corpo: string): Promise<RespostaEmissao> {
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(corpo) as Record<string, unknown>;
	} catch {
		return { tipo: "indefinida", detalhe: `Resposta HTTP ${status} fora do formato esperado.` };
	}

	const sucesso = status >= 200 && status < 300;
	if (sucesso && typeof json.chaveAcesso === "string" && typeof json.nfseXmlGZipB64 === "string") {
		const xml = await gunzipBase64(json.nfseXmlGZipB64);
		return {
			tipo: "autorizada",
			chaveAcesso: json.chaveAcesso,
			xml,
			numeroNfse: /<nNFSe>(\d+)<\/nNFSe>/.exec(xml)?.[1] ?? null,
			alertas: lerMensagens(json.alertas),
		};
	}

	const rejeicoes = lerMensagens(json.erros ?? json.Erros ?? json.erro);
	// Só tratamos como rejeição definitiva o que a aplicação recusou (4xx com
	// mensagens). Erro de servidor pode ter gerado a nota mesmo assim.
	if (status >= 400 && status < 500 && rejeicoes.length > 0) return { tipo: "rejeitada", rejeicoes };

	return {
		tipo: "indefinida",
		detalhe: rejeicoes[0]
			? `HTTP ${status}: ${rejeicoes[0].codigo} ${rejeicoes[0].descricao}`.trim()
			: `Resposta HTTP ${status} sem chave de acesso nem mensagens de erro.`,
	};
}
