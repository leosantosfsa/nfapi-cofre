import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import type { Holder } from "./pfx";

import type { Environment, SignableTag, SignatureProfile } from "./protocol";

export type { SignableTag, SignatureProfile };

/** Elementos que o cofre aceita assinar. Qualquer outro é recusado. */
export const SIGNABLE_TAGS: readonly SignableTag[] = [
	"infNFe",
	"infEvento",
	"infInut",
	"infDPS",
	"infPedReg",
];
// NF-e/NFC-e usam RSA-SHA1 (MOC 7.0); o perfil SHA-256 fica disponível para a NFS-e.

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const PROFILES: Record<SignatureProfile, { signature: string; digest: string }> = {
	"rsa-sha1": {
		signature: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
		digest: "http://www.w3.org/2000/09/xmldsig#sha1",
	},
	"rsa-sha256": {
		signature: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
		digest: "http://www.w3.org/2001/04/xmlenc#sha256",
	},
};

export type SignErrorCode =
	| "xml_invalido"
	| "tag_nao_permitida"
	| "elemento_ausente"
	| "id_invalido"
	| "ja_assinado"
	| "emitente_ausente"
	| "emitente_divergente"
	| "ambiente_ausente"
	| "producao_bloqueada";

export class SignError extends Error {
	readonly code: SignErrorCode;

	constructor(code: SignErrorCode, message: string) {
		super(message);
		this.name = "SignError";
		this.code = code;
	}
}

export interface SignInput {
	xml: string;
	tag: SignableTag;
	profile: SignatureProfile;
	privateKeyPem: string;
	certificatePem: string;
	/** Titular do certificado; o documento precisa pertencer a ele. */
	holder: Holder;
	/** Quando falso, documentos com tpAmb=1 (produção) são recusados. */
	allowProduction: boolean;
}

export interface SignOutput {
	xml: string;
	/** Valor do atributo Id assinado (ex.: "NFe3526..."). */
	id: string;
	/** CNPJ/CPF do emitente encontrado no documento. */
	emitter: string;
	/** Ambiente declarado no próprio documento (tpAmb). */
	environment: Environment;
}

/**
 * Assinatura XMLDSig "enveloped" sobre o elemento `tag`, com a `<Signature>`
 * inserida como último filho do elemento pai — o formato exigido pela NF-e,
 * NFC-e, eventos, inutilização e DPS da NFS-e Nacional.
 */
export function signXml(input: SignInput): SignOutput {
	if (!SIGNABLE_TAGS.includes(input.tag)) {
		throw new SignError("tag_nao_permitida", `O cofre não assina <${input.tag}>.`);
	}

	const root = parseRoot(input.xml);
	const targets = elementsByLocalName(root, input.tag);
	if (targets.length !== 1) {
		throw new SignError(
			"elemento_ausente",
			`Esperado exatamente um <${input.tag}>, encontrado(s) ${targets.length}.`,
		);
	}
	const target = targets[0] as XmlElement;

	const id = target.getAttribute("Id") ?? "";
	// O Id entra numa expressão XPath: aceitar só o alfabeto usado pelos leiautes fiscais.
	if (!/^[A-Za-z][A-Za-z0-9]{5,80}$/.test(id)) {
		throw new SignError("id_invalido", `Atributo Id ausente ou inválido em <${input.tag}>.`);
	}

	const parent = target.parentNode as XmlElement | null;
	if (parent && childrenByLocalName(parent, "Signature").length > 0) {
		throw new SignError("ja_assinado", "O documento já contém uma assinatura.");
	}

	const emitter = findEmitter(target, input.tag);
	if (!emitter) {
		throw new SignError("emitente_ausente", "CNPJ/CPF do emitente não encontrado no documento.");
	}
	if (!sameTaxpayer(emitter, input.holder)) {
		throw new SignError(
			"emitente_divergente",
			"O emitente do documento não corresponde ao titular do certificado instalado.",
		);
	}

	// O ambiente vem do documento, não da palavra de quem pede: um XML com
	// tpAmb=2 não é autorizável em produção, então a trava não pode ser burlada.
	const tpAmb = elementsByLocalName(target, "tpAmb")[0]?.textContent?.trim();
	if (tpAmb !== "1" && tpAmb !== "2") {
		throw new SignError("ambiente_ausente", "tpAmb ausente ou inválido no documento.");
	}
	const environment: Environment = tpAmb === "1" ? "producao" : "homologacao";
	if (environment === "producao" && !input.allowProduction) {
		throw new SignError(
			"producao_bloqueada",
			"Este cofre está travado em homologação. Libere a produção na tela /setup.",
		);
	}

	const alg = PROFILES[input.profile];
	if (!alg) throw new SignError("tag_nao_permitida", "Perfil de assinatura desconhecido.");
	const sig = new SignedXml({
		privateKey: input.privateKeyPem,
		publicCert: input.certificatePem,
		signatureAlgorithm: alg.signature,
		canonicalizationAlgorithm: C14N,
	});
	sig.addReference({
		xpath: `//*[@Id='${id}']`,
		transforms: [ENVELOPED, C14N],
		digestAlgorithm: alg.digest,
	});
	sig.computeSignature(input.xml, {
		location: { reference: `//*[@Id='${id}']/..`, action: "append" },
	});

	return { xml: sig.getSignedXml(), id, emitter, environment };
}

/**
 * Matriz e filiais compartilham a raiz do CNPJ (8 primeiros caracteres) e a
 * SEFAZ aceita o certificado da matriz para as filiais. CPF precisa ser idêntico.
 */
export function sameTaxpayer(documentId: string, holder: Holder): boolean {
	const doc = documentId.trim().toUpperCase();
	if (holder.kind === "cpf") return doc === holder.id;
	return doc.length === 14 && doc.slice(0, 8) === holder.id.slice(0, 8);
}

function parseRoot(xml: string): XmlElement {
	const errors: string[] = [];
	let root: unknown;
	try {
		// O xmldom lança ParseError em erro fatal e chama onError nos demais.
		root = new DOMParser({
			onError: (level, msg) => {
				if (level !== "warning") errors.push(msg);
			},
		}).parseFromString(xml, "application/xml").documentElement;
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err));
	}
	if (errors.length > 0 || !root) {
		throw new SignError("xml_invalido", `XML malformado: ${errors[0] ?? "documento vazio"}`);
	}
	return root as XmlElement;
}

function findEmitter(target: XmlElement, tag: SignableTag): string | undefined {
	switch (tag) {
		case "infNFe":
			return docIdOf(childrenByLocalName(target, "emit")[0]);
		case "infEvento":
		case "infInut":
			return docIdOf(target);
		case "infPedReg":
			return text(target, "CNPJAutor") ?? text(target, "CPFAutor");
		case "infDPS": {
			// tpEmit: 1 = prestador, 2 = tomador, 3 = intermediário.
			const role = { "1": "prest", "2": "toma", "3": "interm" }[text(target, "tpEmit") ?? "1"];
			return role ? docIdOf(childrenByLocalName(target, role)[0]) : undefined;
		}
	}
}

function docIdOf(el: XmlElement | undefined): string | undefined {
	return el ? (text(el, "CNPJ") ?? text(el, "CPF")) : undefined;
}

function text(parent: XmlElement, localName: string): string | undefined {
	const value = childrenByLocalName(parent, localName)[0]?.textContent?.trim();
	return value ? value : undefined;
}

// Tipos mínimos do DOM do xmldom (o pacote não exporta os tipos de nó de forma estável).
interface XmlElement {
	nodeType: number;
	localName: string | null;
	textContent: string | null;
	parentNode: unknown;
	childNodes: { length: number; item(i: number): unknown };
	getAttribute(name: string): string | null;
}

function childrenByLocalName(parent: XmlElement, localName: string): XmlElement[] {
	const out: XmlElement[] = [];
	for (let i = 0; i < parent.childNodes.length; i++) {
		const n = parent.childNodes.item(i) as XmlElement;
		if (n.nodeType === 1 && n.localName === localName) out.push(n);
	}
	return out;
}

function elementsByLocalName(root: XmlElement, localName: string): XmlElement[] {
	const out: XmlElement[] = [];
	const walk = (el: XmlElement) => {
		if (el.localName === localName) out.push(el);
		for (let i = 0; i < el.childNodes.length; i++) {
			const n = el.childNodes.item(i) as XmlElement;
			if (n.nodeType === 1) walk(n);
		}
	};
	walk(root as XmlElement);
	return out;
}
