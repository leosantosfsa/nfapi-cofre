// Conversa com os web services da NF-e/NFC-e (SOAP 1.2): monta os envelopes e
// lê as respostas. Nada aqui conhece certificado ou rede; o transporte fica no
// cofre (operacoes.ts).

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Mensagem } from "../nfse";
import { textoParaBase64 } from "../nfse";
import type { TransmitRequest } from "../protocol";
import { NAMESPACE_NFE } from "./xml";

export type Servico = "autorizacao" | "retAutorizacao" | "consulta" | "status" | "evento" | "inutilizacao";

const WSDL: Record<Servico, { nome: string; metodo: string }> = {
	autorizacao: { nome: "NFeAutorizacao4", metodo: "nfeAutorizacaoLote" },
	retAutorizacao: { nome: "NFeRetAutorizacao4", metodo: "nfeRetAutorizacaoLote" },
	consulta: { nome: "NFeConsultaProtocolo4", metodo: "nfeConsultaNF" },
	status: { nome: "NFeStatusServico4", metodo: "nfeStatusServicoNF" },
	evento: { nome: "NFeRecepcaoEvento4", metodo: "nfeRecepcaoEventoNF" },
	inutilizacao: { nome: "NFeInutilizacao4", metodo: "nfeInutilizacaoNF" },
};

/** Requisição pronta para o transporte mTLS. */
export function requisicaoSoap(servico: Servico, url: string, dados: string, ref: string): TransmitRequest {
	const { nome, metodo } = WSDL[servico];
	const ns = `http://www.portalfiscal.inf.br/nfe/wsdl/${nome}`;
	const envelope =
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
		`<nfeDadosMsg xmlns="${ns}">${dados}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
	return {
		url,
		method: "POST",
		headers: { "content-type": `application/soap+xml; charset=utf-8; action="${ns}/${metodo}"` },
		bodyB64: textoParaBase64(envelope),
		timeoutMs: 60_000,
		ref,
	};
}

const abre = (nome: string, versao: string) => `<${nome} xmlns="${NAMESPACE_NFE}" versao="${versao}">`;

/** Lote síncrono com uma única nota. */
export const enviNFe = (nfeAssinada: string, idLote: string) =>
	`${abre("enviNFe", "4.00")}<idLote>${idLote}</idLote><indSinc>1</indSinc>${nfeAssinada}</enviNFe>`;

export const consReciNFe = (tpAmb: "1" | "2", recibo: string) =>
	`${abre("consReciNFe", "4.00")}<tpAmb>${tpAmb}</tpAmb><nRec>${recibo}</nRec></consReciNFe>`;

export const consSitNFe = (tpAmb: "1" | "2", chave: string) =>
	`${abre("consSitNFe", "4.00")}<tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`;

export const consStatServ = (tpAmb: "1" | "2", cUF: string) =>
	`${abre("consStatServ", "4.00")}<tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>`;

export const envEvento = (eventoAssinado: string, idLote: string) =>
	`${abre("envEvento", "1.00")}<idLote>${idLote}</idLote>${eventoAssinado}</envEvento>`;

/** NF-e autorizada no formato de distribuição: a nota e o protocolo juntos. */
export const nfeProc = (nfeAssinada: string, protNFe: string) => `${abre("nfeProc", "4.00")}${nfeAssinada}${protNFe}</nfeProc>`;

export const procEventoNFe = (eventoAssinado: string, retEvento: string) =>
	`${abre("procEventoNFe", "1.00")}${eventoAssinado}${retEvento}</procEventoNFe>`;

export const procInutNFe = (inutAssinada: string, retInutNFe: string) =>
	`${abre("ProcInutNFe", "4.00")}${inutAssinada}${retInutNFe}</ProcInutNFe>`;

// ---------- Leitura das respostas ----------

interface No {
	nodeType: number;
	localName: string | null;
	textContent: string | null;
	childNodes: { length: number; item(i: number): unknown };
}

function analisar(xml: string): No | null {
	try {
		const doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, "application/xml");
		return (doc.documentElement as unknown as No) ?? null;
	} catch {
		return null;
	}
}

/** Todos os elementos com esse nome, em qualquer profundidade. */
function todos(raiz: No, nome: string, saida: No[] = []): No[] {
	if (raiz.localName === nome) saida.push(raiz);
	for (let i = 0; i < raiz.childNodes.length; i++) {
		const filho = raiz.childNodes.item(i) as No;
		if (filho.nodeType === 1) todos(filho, nome, saida);
	}
	return saida;
}
const primeiro = (raiz: No, nome: string) => todos(raiz, nome)[0];

/** Texto de um filho direto. */
function campo(pai: No | undefined, nome: string): string | undefined {
	if (!pai) return undefined;
	for (let i = 0; i < pai.childNodes.length; i++) {
		const filho = pai.childNodes.item(i) as No;
		if (filho.nodeType === 1 && filho.localName === nome) return filho.textContent?.trim() || undefined;
	}
	return undefined;
}

const serializar = (no: No) => new XMLSerializer().serializeToString(no as never);
const mensagem = (no: No | undefined): Mensagem => ({
	codigo: campo(no, "cStat") ?? "000",
	descricao: campo(no, "xMotivo") ?? "Resposta sem motivo.",
});

const AUTORIZADA = new Set(["100", "150"]);
const DENEGADA = new Set(["110", "301", "302", "303"]);
const CANCELADA = new Set(["101", "151", "155"]);

export type RespostaAutorizacao =
	| { tipo: "autorizada"; protocolo: string; recebidaEm: string | null; mensagem: Mensagem; protNFe: string }
	| { tipo: "denegada"; mensagem: Mensagem; protNFe: string }
	| { tipo: "rejeitada"; mensagem: Mensagem }
	/** O lote foi recebido e ainda não tem resultado: consultar pelo recibo. */
	| { tipo: "em_processamento"; recibo: string }
	| { tipo: "indefinida"; detalhe: string };

function lerProtocolo(raiz: No, chave: string): RespostaAutorizacao | null {
	const infProt = todos(raiz, "infProt").find((p) => campo(p, "chNFe") === chave);
	if (!infProt) return null;
	const prot = todos(raiz, "protNFe").find((p) => todos(p, "infProt").includes(infProt)) as No;
	const cStat = campo(infProt, "cStat") ?? "";
	if (AUTORIZADA.has(cStat)) {
		return {
			tipo: "autorizada",
			protocolo: campo(infProt, "nProt") ?? "",
			recebidaEm: campo(infProt, "dhRecbto") ?? null,
			mensagem: mensagem(infProt),
			protNFe: serializar(prot),
		};
	}
	if (DENEGADA.has(cStat)) return { tipo: "denegada", mensagem: mensagem(infProt), protNFe: serializar(prot) };
	return { tipo: "rejeitada", mensagem: mensagem(infProt) };
}

/** Resposta do NFeAutorizacao4 (síncrono) ou do NFeRetAutorizacao4. */
export function lerRespostaAutorizacao(status: number, corpo: string, chave: string): RespostaAutorizacao {
	const raiz = analisar(corpo);
	const ret = raiz && (primeiro(raiz, "retEnviNFe") ?? primeiro(raiz, "retConsReciNFe"));
	if (!raiz || !ret) return { tipo: "indefinida", detalhe: `A SEFAZ respondeu HTTP ${status} sem um retorno reconhecível.` };

	const cStat = campo(ret, "cStat") ?? "";
	if (cStat === "104") {
		return lerProtocolo(ret, chave) ?? { tipo: "indefinida", detalhe: "O lote foi processado, mas o retorno não traz o protocolo desta nota." };
	}
	if (cStat === "103" || cStat === "105") {
		const recibo = campo(primeiro(ret, "infRec"), "nRec") ?? campo(ret, "nRec");
		return recibo ? { tipo: "em_processamento", recibo } : { tipo: "indefinida", detalhe: "Lote em processamento, sem número de recibo." };
	}
	return { tipo: "rejeitada", mensagem: mensagem(ret) };
}

export type RespostaConsulta =
	| Extract<RespostaAutorizacao, { tipo: "autorizada" | "denegada" }>
	| { tipo: "cancelada"; protocolo: string | null; mensagem: Mensagem; protNFe: string | null }
	/** A SEFAZ não conhece a chave: a nota não existe e pode ser reenviada. */
	| { tipo: "nao_consta"; mensagem: Mensagem }
	| { tipo: "indefinida"; detalhe: string };

/** Resposta do NFeConsultaProtocolo4. */
export function lerRespostaConsulta(status: number, corpo: string, chave: string): RespostaConsulta {
	const raiz = analisar(corpo);
	const ret = raiz && primeiro(raiz, "retConsSitNFe");
	if (!raiz || !ret) return { tipo: "indefinida", detalhe: `A consulta respondeu HTTP ${status} sem um retorno reconhecível.` };
	const cStat = campo(ret, "cStat") ?? "";
	const protocolo = lerProtocolo(ret, chave);
	if (CANCELADA.has(cStat)) {
		const autorizada = protocolo?.tipo === "autorizada" ? protocolo : null;
		return { tipo: "cancelada", protocolo: autorizada?.protocolo ?? null, mensagem: mensagem(ret), protNFe: autorizada?.protNFe ?? null };
	}
	if ((AUTORIZADA.has(cStat) || DENEGADA.has(cStat)) && protocolo && protocolo.tipo !== "rejeitada" && protocolo.tipo !== "em_processamento" && protocolo.tipo !== "indefinida") {
		return protocolo;
	}
	if (cStat === "217") return { tipo: "nao_consta", mensagem: mensagem(ret) };
	return { tipo: "indefinida", detalhe: `Consulta: [${cStat}] ${campo(ret, "xMotivo") ?? "sem motivo"}` };
}

export type RespostaEventoNfe =
	| { tipo: "registrado"; protocolo: string | null; mensagem: Mensagem; retEvento: string }
	/** O mesmo evento já estava registrado (cStat 573): repetir o pedido não é erro. */
	| { tipo: "duplicado"; mensagem: Mensagem }
	| { tipo: "rejeitado"; mensagem: Mensagem }
	| { tipo: "indefinida"; detalhe: string };

/** Resposta do NFeRecepcaoEvento4. */
export function lerRespostaEventoNfe(status: number, corpo: string): RespostaEventoNfe {
	const raiz = analisar(corpo);
	const ret = raiz && primeiro(raiz, "retEnvEvento");
	if (!raiz || !ret) return { tipo: "indefinida", detalhe: `A SEFAZ respondeu HTTP ${status} sem um retorno reconhecível.` };
	const retEvento = primeiro(ret, "retEvento");
	const inf = retEvento && primeiro(retEvento, "infEvento");
	if (!retEvento || !inf) return { tipo: "rejeitado", mensagem: mensagem(ret) };
	const cStat = campo(inf, "cStat") ?? "";
	if (["135", "136", "155"].includes(cStat)) {
		return { tipo: "registrado", protocolo: campo(inf, "nProt") ?? null, mensagem: mensagem(inf), retEvento: serializar(retEvento) };
	}
	if (cStat === "573") return { tipo: "duplicado", mensagem: mensagem(inf) };
	return { tipo: "rejeitado", mensagem: mensagem(inf) };
}

export type RespostaInutilizacao =
	| { tipo: "homologada"; protocolo: string | null; mensagem: Mensagem; retInutNFe: string }
	/** A SEFAZ já tem um pedido com a mesma faixa (cStat 563): repetir não é erro. */
	| { tipo: "duplicada"; mensagem: Mensagem }
	| { tipo: "rejeitada"; mensagem: Mensagem }
	| { tipo: "indefinida"; detalhe: string };

/** Resposta do NFeInutilizacao4. */
export function lerRespostaInutilizacao(status: number, corpo: string): RespostaInutilizacao {
	const raiz = analisar(corpo);
	const ret = raiz && primeiro(raiz, "retInutNFe");
	const inf = ret && primeiro(ret, "infInut");
	if (!ret || !inf) return { tipo: "indefinida", detalhe: `A SEFAZ respondeu HTTP ${status} sem um retorno reconhecível.` };
	if (campo(inf, "cStat") === "102") {
		return { tipo: "homologada", protocolo: campo(inf, "nProt") ?? null, mensagem: mensagem(inf), retInutNFe: serializar(ret) };
	}
	if (campo(inf, "cStat") === "563") return { tipo: "duplicada", mensagem: mensagem(inf) };
	return { tipo: "rejeitada", mensagem: mensagem(inf) };
}

export interface StatusServico {
	/** 107 = em operação. */
	emOperacao: boolean;
	mensagem: Mensagem;
	tempoMedioSegundos: number | null;
}

/** Resposta do NFeStatusServico4. Null quando não há retorno reconhecível. */
export function lerStatusServico(corpo: string): StatusServico | null {
	const raiz = analisar(corpo);
	const ret = raiz && primeiro(raiz, "retConsStatServ");
	if (!ret) return null;
	const tMed = Number(campo(ret, "tMed"));
	return { emOperacao: campo(ret, "cStat") === "107", mensagem: mensagem(ret), tempoMedioSegundos: Number.isFinite(tMed) ? tMed : null };
}
