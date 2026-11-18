import forge from "node-forge";

/** Titular do certificado: CNPJ (e-CNPJ) ou CPF (e-CPF). */
export interface Holder {
	kind: "cnpj" | "cpf";
	/** Só os 14 (CNPJ, pode ser alfanumérico) ou 11 (CPF) caracteres, sem máscara. */
	id: string;
}

export interface ParsedCertificate {
	/** Chave privada em PEM PKCS#8 (não cifrada). Nunca sai do cofre. */
	privateKeyPem: string;
	/** Certificado do titular em PEM. */
	certificatePem: string;
	/** Certificados intermediários/raiz que vieram no arquivo, em PEM. */
	chainPem: string[];
	holder: Holder;
	commonName: string;
	issuer: string;
	serialNumber: string;
	notBefore: Date;
	notAfter: Date;
}

export type PfxErrorCode =
	| "senha_incorreta"
	| "arquivo_invalido"
	| "sem_chave_privada"
	| "sem_titular";

export class PfxError extends Error {
	readonly code: PfxErrorCode;

	constructor(code: PfxErrorCode, message: string) {
		super(message);
		this.name = "PfxError";
		this.code = code;
	}
}

// Tipos de "bag" do PKCS#12 (RFC 7292).
const OID_KEY_BAG = "1.2.840.113549.1.12.10.1.1";
const OID_SHROUDED_KEY_BAG = "1.2.840.113549.1.12.10.1.2";
const OID_CERT_BAG = "1.2.840.113549.1.12.10.1.3";
// Identificadores ICP-Brasil no subjectAltName.
const OID_CNPJ = "2.16.76.1.3.3";
const OID_PESSOA_FISICA = "2.16.76.1.3.1";
const CNPJ_RE = /^[A-Z0-9]{12}\d{2}$/;
const CPF_RE = /^\d{11}$/;

/** Lê um arquivo .pfx/.p12 (certificado A1) e extrai chave, certificado e titular. */
export function parsePfx(pfx: Uint8Array, password: string): ParsedCertificate {
	let p12: forge.pkcs12.Pkcs12Pfx;
	try {
		const der = forge.util.createBuffer(bytesToBinary(pfx));
		p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), password);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/mac could not be verified|invalid password/i.test(msg)) {
			throw new PfxError("senha_incorreta", "Senha do certificado incorreta.");
		}
		throw new PfxError("arquivo_invalido", `Arquivo .pfx inválido: ${msg}`);
	}

	const bags = (oid: string) => p12.getBags({ bagType: oid })[oid] ?? [];
	const keyBags = [...bags(OID_SHROUDED_KEY_BAG), ...bags(OID_KEY_BAG)];
	const privateKey = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
	if (!privateKey) {
		throw new PfxError("sem_chave_privada", "O arquivo não contém chave privada RSA.");
	}

	const certs = bags(OID_CERT_BAG)
		.map((b) => b.cert)
		.filter((c): c is forge.pki.Certificate => Boolean(c));

	// O certificado do titular é o que tem a mesma chave pública da chave privada.
	const leaf = certs.find((c) => {
		const pub = c.publicKey as forge.pki.rsa.PublicKey;
		return pub.n?.compareTo(privateKey.n) === 0;
	});
	if (!leaf) {
		throw new PfxError("arquivo_invalido", "Nenhum certificado corresponde à chave privada.");
	}

	const commonName = String(leaf.subject.getField("CN")?.value ?? "");
	const holder = extractHolder(leaf, commonName);
	if (!holder) {
		throw new PfxError(
			"sem_titular",
			"Não foi possível identificar o CNPJ/CPF do titular. O certificado é ICP-Brasil?",
		);
	}

	const pkcs8 = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(privateKey));
	return {
		privateKeyPem: forge.pki.privateKeyInfoToPem(pkcs8),
		certificatePem: forge.pki.certificateToPem(leaf),
		chainPem: certs.filter((c) => c !== leaf).map((c) => forge.pki.certificateToPem(c)),
		holder,
		commonName,
		issuer: String(leaf.issuer.getField("CN")?.value ?? ""),
		serialNumber: leaf.serialNumber,
		notBefore: leaf.validity.notBefore,
		notAfter: leaf.validity.notAfter,
	};
}

/**
 * ICP-Brasil grava o CNPJ no subjectAltName (otherName 2.16.76.1.3.3) e, por
 * convenção, também no fim do CN ("RAZAO SOCIAL:CNPJ"). O e-CPF usa o otherName
 * 2.16.76.1.3.1 (data de nascimento + CPF + ...).
 */
function extractHolder(cert: forge.pki.Certificate, commonName: string): Holder | undefined {
	const other = readOtherNames(cert);
	const cnpj = other.get(OID_CNPJ)?.trim().toUpperCase();
	if (cnpj && CNPJ_RE.test(cnpj)) return { kind: "cnpj", id: cnpj };

	const pf = other.get(OID_PESSOA_FISICA);
	const cpf = pf?.slice(8, 19);
	if (cpf && CPF_RE.test(cpf)) return { kind: "cpf", id: cpf };

	const suffix = commonName.split(":").pop()?.trim().toUpperCase() ?? "";
	if (commonName.includes(":")) {
		if (CNPJ_RE.test(suffix)) return { kind: "cnpj", id: suffix };
		if (CPF_RE.test(suffix)) return { kind: "cpf", id: suffix };
	}
	return undefined;
}

function readOtherNames(cert: forge.pki.Certificate): Map<string, string> {
	const out = new Map<string, string>();
	const ext = cert.getExtension("subjectAltName") as { value?: string } | null;
	if (!ext?.value) return out;
	try {
		const san = forge.asn1.fromDer(ext.value);
		for (const gn of san.value as forge.asn1.Asn1[]) {
			const isOtherName = gn.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && gn.type === 0;
			if (!isOtherName || !Array.isArray(gn.value)) continue;
			const [oidNode, wrapper] = gn.value as forge.asn1.Asn1[];
			if (!oidNode || !wrapper || typeof oidNode.value !== "string") continue;
			const oid = forge.asn1.derToOid(oidNode.value);
			const inner = Array.isArray(wrapper.value) ? wrapper.value[0] : undefined;
			if (inner && typeof inner.value === "string") out.set(oid, inner.value);
		}
	} catch {
		// subjectAltName fora do padrão: cai no CN.
	}
	return out;
}

function bytesToBinary(bytes: Uint8Array): string {
	let s = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		s += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return s;
}
