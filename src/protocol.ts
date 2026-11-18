// Tipos e utilitários compartilhados dentro do cofre.

import pkg from "../package.json";

/** Versão instalada do cofre (a mesma do package.json, usada para saber se há atualização). */
export const VAULT_VERSION: string = pkg.version;

export type SignableTag = "infNFe" | "infEvento" | "infInut" | "infDPS" | "infPedReg";
export type SignatureProfile = "rsa-sha1" | "rsa-sha256";
export type Environment = "producao" | "homologacao";

export interface SignRequest {
	xml: string;
	tag: SignableTag;
	profile: SignatureProfile;
}
export interface SignResponse {
	xml: string;
	id: string;
	emitter: string;
	environment: Environment;
}

export interface TransmitRequest {
	url: string;
	method?: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	/** Corpo em base64 (o conteúdo pode ser XML, JSON ou binário). */
	bodyB64?: string;
	/** A maioria dos webservices fiscais exige TLS 1.2 (renegociação). */
	maxTls?: "1.2" | "1.3";
	timeoutMs?: number;
	/** Referência livre (ex.: id da emissão), gravada no diário. */
	ref?: string;
}
export interface TransmitResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	bodyB64: string;
	tls: { protocol: string | null; cipher: string | null; peerIssuer: string | null };
	ms: number;
	/** Onde a troca completa ficou gravada no R2 do emitente. */
	journalKey: string;
}

export interface CertificateInfo {
	holder: { kind: "cnpj" | "cpf"; id: string };
	commonName: string;
	issuer: string;
	serialNumber: string;
	notBefore: string;
	notAfter: string;
	installedAt: string;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}
