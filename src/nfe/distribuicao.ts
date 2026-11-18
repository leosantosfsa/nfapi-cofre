// Distribuição de DF-e do Ambiente Nacional (NFeDistribuicaoDFe, NT 2014.002):
// monta o pedido e lê o retorno. Nada aqui conhece certificado, rede ou banco.
//
// O serviço entrega ao titular os documentos que outras empresas emitiram contra
// o CNPJ dele: primeiro o resumo de cada NF-e e, depois da manifestação do
// destinatário, o XML completo e os eventos.

import { type No, atributo, filho, primeiro, raizDoXml, texto } from "../danfe/leitura";
import type { Ambiente } from "../fiscal/dados";
import { gunzipBase64, textoParaBase64 } from "../nfse";
import type { TransmitRequest } from "../protocol";
import { CODIGO_UF } from "./chave";
import { NAMESPACE_NFE } from "./xml";

const WSDL = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe";

export type ConsultaDfe =
	/** Tudo o que chegou depois do último NSU recebido (lotes de até 50 documentos). */
	| { tipo: "sequencia"; ultNsu: number }
	/** Um NSU específico, para fechar uma lacuna. */
	| { tipo: "nsu"; nsu: number }
	/** Uma NF-e pela chave de acesso (não devolve eventos). */
	| { tipo: "chave"; chave: string };

const nsu15 = (n: number) => String(n).padStart(15, "0");

/** Pedido de distribuição (distDFeInt, versão 1.01). */
export function distDFeInt(p: { ambiente: Ambiente; uf: string; cnpj: string; consulta: ConsultaDfe }): string {
	const c = p.consulta;
	const consulta =
		c.tipo === "sequencia"
			? `<distNSU><ultNSU>${nsu15(c.ultNsu)}</ultNSU></distNSU>`
			: c.tipo === "nsu"
				? `<consNSU><NSU>${nsu15(c.nsu)}</NSU></consNSU>`
				: `<consChNFe><chNFe>${c.chave}</chNFe></consChNFe>`;
	return (
		`<distDFeInt xmlns="${NAMESPACE_NFE}" versao="1.01"><tpAmb>${p.ambiente === "homologacao" ? "2" : "1"}</tpAmb>` +
		`<cUFAutor>${CODIGO_UF[p.uf] ?? ""}</cUFAutor><CNPJ>${p.cnpj}</CNPJ>${consulta}</distDFeInt>`
	);
}

/** Requisição SOAP 1.2 pronta para o transporte mTLS. */
export function requisicaoDistribuicao(url: string, dados: string, ref: string): TransmitRequest {
	const envelope =
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
		`<nfeDistDFeInteresse xmlns="${WSDL}"><nfeDadosMsg xmlns="${WSDL}">${dados}</nfeDadosMsg></nfeDistDFeInteresse>` +
		`</soap12:Body></soap12:Envelope>`;
	return {
		url,
		method: "POST",
		headers: { "content-type": `application/soap+xml; charset=utf-8; action="${WSDL}/nfeDistDFeInteresse"` },
		bodyB64: textoParaBase64(envelope),
		timeoutMs: 60_000,
		ref,
	};
}

export interface DocumentoDistribuido {
	/** Ausente em parte das consultas por chave (o retorno do NSU é facultativo). */
	nsu: number | null;
	/** Nome do schema informado pelo Ambiente Nacional, como "resNFe_v1.01.xsd". */
	schema: string;
	xml: string;
}

export type RetornoDistribuicao =
	| {
			tipo: "resposta";
			/** 137 = nenhum documento; 138 = documentos localizados; 656 = consumo indevido; os demais são rejeições. */
			codigo: string;
			motivo: string;
			ultNsu: number | null;
			maxNsu: number | null;
			documentos: DocumentoDistribuido[];
	  }
	| { tipo: "indefinida"; detalhe: string };

const inteiro = (v: string | undefined): number | null => (v && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** Retorno do NFeDistribuicaoDFe: cada documento vem compactado (GZip) e em Base64. */
export async function lerRetornoDistribuicao(status: number, corpo: string): Promise<RetornoDistribuicao> {
	const ret = primeiro(raizDoXml(corpo), "retDistDFeInt");
	const codigo = texto(ret, "cStat");
	if (!ret || !codigo) return { tipo: "indefinida", detalhe: `O Ambiente Nacional respondeu HTTP ${status} sem um retorno reconhecível.` };
	const documentos: DocumentoDistribuido[] = [];
	const lote = filho(ret, "loteDistDFeInt");
	for (let i = 0; lote && i < lote.childNodes.length; i++) {
		const doc = lote.childNodes.item(i) as No;
		if (doc.nodeType !== 1 || doc.localName !== "docZip") continue;
		try {
			documentos.push({
				nsu: inteiro(atributo(doc, "NSU")),
				schema: atributo(doc, "schema") ?? "",
				xml: await gunzipBase64((doc.textContent ?? "").replace(/\s+/g, "")),
			});
		} catch {
			return { tipo: "indefinida", detalhe: "O retorno trouxe um documento que não pôde ser descompactado." };
		}
	}
	return {
		tipo: "resposta",
		codigo,
		motivo: texto(ret, "xMotivo") ?? "Resposta sem motivo.",
		ultNsu: inteiro(texto(ret, "ultNSU")),
		maxNsu: inteiro(texto(ret, "maxNSU")),
		documentos,
	};
}

// ---------- Leitura de cada documento ----------

export type SituacaoRecebida = "autorizada" | "cancelada" | "denegada";

export interface DadosDaNota {
	chave: string;
	emitente: { documento: string | null; nome: string | null; ie: string | null };
	/** CNPJ ou CPF do destinatário; o resumo não o traz (ele só é entregue ao próprio destinatário). */
	destinatario: string | null;
	emitidaEm: string | null;
	operacao: "entrada" | "saida" | null;
	valor: number | null;
	situacao: SituacaoRecebida | null;
	protocolo: string | null;
	autorizadaEm: string | null;
}

export interface DadosDoEvento {
	chave: string;
	/** Código do evento: 110111 cancelamento, 110110 carta de correção, 2102xx manifestação... */
	tpEvento: string;
	sequencia: number;
	descricao: string | null;
	em: string | null;
	protocolo: string | null;
	/** CNPJ ou CPF de quem registrou o evento. */
	autor: string | null;
}

export type DocumentoLido =
	/** Resumo da NF-e: é o que chega antes da manifestação do destinatário. */
	| ({ tipo: "resumo_nfe" } & DadosDaNota)
	/** NF-e completa, com o protocolo (nfeProc). */
	| ({ tipo: "nfe" } & DadosDaNota)
	| ({ tipo: "resumo_evento" } & DadosDoEvento)
	| ({ tipo: "evento" } & DadosDoEvento)
	/** Documento que o cofre guarda sem interpretar. */
	| { tipo: "outro" };

/** Eventos que cancelam a nota: cancelamento e cancelamento por substituição. */
export const EVENTOS_DE_CANCELAMENTO = new Set(["110111", "110112"]);

const CHAVE = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;
const operacao = (tpNF: string | undefined) => (tpNF === "0" ? "entrada" : tpNF === "1" ? "saida" : null);
const valor = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : null);
const documentoDe = (no: No | undefined) => texto(no, "CNPJ") ?? texto(no, "CPF") ?? null;

function situacaoDoProtocolo(cStat: string | undefined): SituacaoRecebida | null {
	if (cStat === "100" || cStat === "150") return "autorizada";
	if (cStat === "101" || cStat === "151" || cStat === "155") return "cancelada";
	if (cStat === "110" || cStat === "301" || cStat === "302" || cStat === "303") return "denegada";
	return null;
}

/** Interpreta um documento distribuído pelo nome do elemento raiz. */
export function lerDocumento(xml: string): DocumentoLido {
	const raiz = raizDoXml(xml);
	switch (raiz?.localName) {
		case "resNFe": {
			const chave = texto(raiz, "chNFe") ?? "";
			if (!CHAVE.test(chave)) return { tipo: "outro" };
			const cSit = texto(raiz, "cSitNFe");
			return {
				tipo: "resumo_nfe",
				chave,
				emitente: { documento: documentoDe(raiz), nome: texto(raiz, "xNome") ?? null, ie: texto(raiz, "IE") ?? null },
				destinatario: null,
				emitidaEm: texto(raiz, "dhEmi") ?? null,
				operacao: operacao(texto(raiz, "tpNF")),
				valor: valor(texto(raiz, "vNF")),
				situacao: cSit === "1" ? "autorizada" : cSit === "2" ? "denegada" : cSit === "3" ? "cancelada" : null,
				protocolo: texto(raiz, "nProt") ?? null,
				autorizadaEm: texto(raiz, "dhRecbto") ?? null,
			};
		}
		case "nfeProc": {
			const inf = primeiro(raiz, "infNFe");
			const chave = (atributo(inf, "Id") ?? "").replace(/^NFe/, "");
			if (!CHAVE.test(chave)) return { tipo: "outro" };
			const ide = filho(inf, "ide");
			const emit = filho(inf, "emit");
			const prot = primeiro(filho(raiz, "protNFe"), "infProt");
			return {
				tipo: "nfe",
				chave,
				emitente: { documento: documentoDe(emit), nome: texto(emit, "xNome") ?? null, ie: texto(emit, "IE") ?? null },
				destinatario: documentoDe(filho(inf, "dest")),
				emitidaEm: texto(ide, "dhEmi") ?? null,
				operacao: operacao(texto(ide, "tpNF")),
				valor: valor(texto(primeiro(filho(inf, "total"), "ICMSTot"), "vNF")),
				situacao: situacaoDoProtocolo(texto(prot, "cStat")),
				protocolo: texto(prot, "nProt") ?? null,
				autorizadaEm: texto(prot, "dhRecbto") ?? null,
			};
		}
		case "resEvento": {
			const chave = texto(raiz, "chNFe") ?? "";
			const tpEvento = texto(raiz, "tpEvento") ?? "";
			if (!CHAVE.test(chave) || !/^\d{6}$/.test(tpEvento)) return { tipo: "outro" };
			return {
				tipo: "resumo_evento",
				chave,
				tpEvento,
				sequencia: Number(texto(raiz, "nSeqEvento") ?? 1) || 1,
				descricao: texto(raiz, "xEvento") ?? null,
				em: texto(raiz, "dhEvento") ?? null,
				protocolo: texto(raiz, "nProt") ?? null,
				autor: documentoDe(raiz),
			};
		}
		case "procEventoNFe": {
			const inf = primeiro(filho(raiz, "evento"), "infEvento");
			const ret = primeiro(filho(raiz, "retEvento"), "infEvento");
			const chave = texto(inf, "chNFe") ?? "";
			const tpEvento = texto(inf, "tpEvento") ?? "";
			if (!CHAVE.test(chave) || !/^\d{6}$/.test(tpEvento)) return { tipo: "outro" };
			return {
				tipo: "evento",
				chave,
				tpEvento,
				sequencia: Number(texto(inf, "nSeqEvento") ?? 1) || 1,
				descricao: texto(filho(inf, "detEvento"), "descEvento") ?? texto(ret, "xEvento") ?? null,
				em: texto(inf, "dhEvento") ?? null,
				protocolo: texto(ret, "nProt") ?? null,
				autor: documentoDe(inf),
			};
		}
		default:
			return { tipo: "outro" };
	}
}
