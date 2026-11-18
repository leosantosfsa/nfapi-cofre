// QR Code da NFC-e, na versão 3 (NT 2025.001).
//
//   online  (tpEmis 1): <endereço da UF>?p=<chave>|3|<tpAmb>
//   offline (tpEmis 9): <endereço da UF>?p=<chave>|3|<tpAmb>|<dia>|<vNF>|<tipo do destinatário>|<documento>|<assinatura>
//
// A versão 3 dispensa o CSC (código de segurança do contribuinte) e é aceita
// em todas as UFs desde 09/2025. A versão 2, com CSC e hash, continua válida
// para o governo, mas o cofre não a usa: assim o emitente não precisa cadastrar
// nada além do certificado.
//
// Na contingência offline, a assinatura (RSA-SHA1 em Base64, com o mesmo
// certificado que assina a nota) cobre os sete primeiros campos, com os
// separadores. É ela que prova a autoria da nota enquanto a SEFAZ não a recebe.

import type { Ambiente, Autorizador } from "../fiscal/dados";

type Enderecos = NonNullable<Autorizador["nfce"]>;
const tpAmb = (ambiente: Ambiente) => (ambiente === "homologacao" ? "2" : "1");

export function suplementoNfce(chave: string, ambiente: Ambiente, enderecos: Enderecos): { qrCode: string; urlChave: string } {
	return { qrCode: `${enderecos.qrCode}?p=${chave}|3|${tpAmb(ambiente)}`, urlChave: enderecos.urlChave };
}

/**
 * Assinatura RSA-SHA1 (PKCS#1 v1.5) de um texto, em Base64, com a chave
 * privada do certificado (PEM no formato PKCS#8).
 */
export async function assinarRsaSha1(privateKeyPem: string, texto: string): Promise<string> {
	if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) throw new Error("A chave privada precisa estar no formato PKCS#8.");
	const der = Uint8Array.from(atob(privateKeyPem.replace(/-----[A-Z ]+-----|\s/g, "")), (c) => c.charCodeAt(0));
	const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["sign"]);
	const assinatura = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(texto)));
	let binario = "";
	for (const b of assinatura) binario += String.fromCharCode(b);
	return btoa(binario);
}

export interface DadosOffline {
	/** Data de emissão da nota (dhEmi); só o dia entra no QR Code. */
	dataEmissao: string;
	/** Valor total da nota (vNF). */
	total: number;
	/** Consumidor identificado na nota, se houver: precisa ser o mesmo do XML. */
	destinatario?: { cnpj?: string; cpf?: string; idEstrangeiro?: string };
}

/** Os sete campos que a assinatura do QR Code offline cobre. */
export function dadosDoQrCodeOffline(chave: string, ambiente: Ambiente, dados: DadosOffline): string {
	const d = dados.destinatario;
	const tipo = d?.cnpj ? "1" : d?.cpf ? "2" : d?.idEstrangeiro !== undefined ? "3" : "";
	const documento = d?.cnpj ?? d?.cpf ?? "";
	return [chave, "3", tpAmb(ambiente), dados.dataEmissao.slice(8, 10), dados.total.toFixed(2), tipo, documento].join("|");
}

export async function suplementoNfceOffline(
	chave: string,
	ambiente: Ambiente,
	enderecos: Enderecos,
	dados: DadosOffline,
	/** Assina o texto com a chave do certificado (RSA-SHA1) e devolve em Base64. */
	assinar: (texto: string) => Promise<string>,
): Promise<{ qrCode: string; urlChave: string }> {
	const campos = dadosDoQrCodeOffline(chave, ambiente, dados);
	return { qrCode: `${enderecos.qrCode}?p=${campos}|${await assinar(campos)}`, urlChave: enderecos.urlChave };
}
