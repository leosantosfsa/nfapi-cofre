import { createHash, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignError, type SignatureProfile, sameTaxpayer, signXml } from "../src/signer";
import { CNPJ_TESTE, certificadoTeste } from "./helpers";

const NS = "http://www.portalfiscal.inf.br/nfe";
const ID = "NFe35261111222333000181550010000000011000000015";
const corpo = (cnpj: string) =>
	`<ide><cUF>35</cUF><nNF>1</nNF><tpAmb>2</tpAmb></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>EMPRESA TESTE NFAPI LTDA</xNome></emit>`;
const nfe = (cnpj = CNPJ_TESTE) =>
	`<NFe xmlns="${NS}"><infNFe Id="${ID}" versao="4.00">${corpo(cnpj)}</infNFe></NFe>`;

// Forma canônica (C14N 1.0) do <infNFe>, escrita à mão: namespace herdado do pai
// primeiro, depois os atributos em ordem. Não depende do xml-crypto.
const canonInfNFe = `<infNFe xmlns="${NS}" Id="${ID}" versao="4.00">${corpo(CNPJ_TESTE)}</infNFe>`;

const ALGS = {
	"rsa-sha1": {
		hash: "sha1",
		verify: "RSA-SHA1",
		sig: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
		digest: "http://www.w3.org/2000/09/xmldsig#sha1",
	},
	"rsa-sha256": {
		hash: "sha256",
		verify: "RSA-SHA256",
		sig: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
		digest: "http://www.w3.org/2001/04/xmlenc#sha256",
	},
} as const;

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const canonSignedInfo = (profile: SignatureProfile, digestValue: string) =>
	`<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
	`<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
	`<SignatureMethod Algorithm="${ALGS[profile].sig}"></SignatureMethod>` +
	`<Reference URI="#${ID}"><Transforms>` +
	`<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
	`<Transform Algorithm="${C14N}"></Transform>` +
	`</Transforms><DigestMethod Algorithm="${ALGS[profile].digest}"></DigestMethod>` +
	`<DigestValue>${digestValue}</DigestValue></Reference></SignedInfo>`;

const pick = (xml: string, tag: string) =>
	new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`).exec(xml)?.[1] ?? "";

function sign(xml: string, extra: Partial<Parameters<typeof signXml>[0]> = {}) {
	const cert = certificadoTeste();
	return signXml({
		xml,
		tag: "infNFe",
		profile: "rsa-sha1",
		privateKeyPem: cert.privateKeyPem,
		certificatePem: cert.certificatePem,
		holder: cert.holder,
		allowProduction: false,
		...extra,
	});
}

describe("signXml", () => {
	for (const profile of ["rsa-sha1", "rsa-sha256"] as const) {
		it(`assina com ${profile} e a assinatura confere por verificação independente`, () => {
			const cert = certificadoTeste();
			const out = sign(nfe(), { profile });

			expect(out.id).toBe(ID);
			expect(out.emitter).toBe(CNPJ_TESTE);

			// 1. O resumo (DigestValue) é o hash da forma canônica escrita à mão.
			const esperado = createHash(ALGS[profile].hash).update(canonInfNFe).digest("base64");
			expect(pick(out.xml, "DigestValue")).toBe(esperado);

			// 2. A SignatureValue é a assinatura RSA do SignedInfo canônico.
			const ok = createVerify(ALGS[profile].verify)
				.update(canonSignedInfo(profile, esperado))
				.verify(cert.certificatePem, pick(out.xml, "SignatureValue"), "base64");
			expect(ok).toBe(true);
		});
	}

	it("gera a estrutura exigida pela SEFAZ: sem prefixo, Signature após infNFe, só X509Certificate", () => {
		const out = sign(nfe());
		expect(out.xml).toMatch(
			/<\/infNFe><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"><SignedInfo>/,
		);
		expect(out.xml).toMatch(
			/<KeyInfo><X509Data><X509Certificate>[A-Za-z0-9+/=]+<\/X509Certificate><\/X509Data><\/KeyInfo><\/Signature><\/NFe>$/,
		);
		expect(out.xml).not.toMatch(/<ds:|\n/);
	});

	it("recusa documento de outro emitente", () => {
		expect(() => sign(nfe("99888777000166"))).toThrowError(
			expect.objectContaining({ code: "emitente_divergente" }),
		);
	});

	it("aceita filial com a mesma raiz de CNPJ do certificado", () => {
		expect(sameTaxpayer("11222333000262", { kind: "cnpj", id: CNPJ_TESTE })).toBe(true);
		expect(sameTaxpayer("11222334000181", { kind: "cnpj", id: CNPJ_TESTE })).toBe(false);
		expect(sameTaxpayer("12345678909", { kind: "cpf", id: "12345678909" })).toBe(true);
	});

	it("recusa documento já assinado", () => {
		const assinado = sign(nfe()).xml;
		expect(() => sign(assinado)).toThrowError(expect.objectContaining({ code: "ja_assinado" }));
	});

	it("recusa tag fora da lista, elemento ausente e Id malicioso", () => {
		expect(() => sign(nfe(), { tag: "ide" as never })).toThrowError(
			expect.objectContaining({ code: "tag_nao_permitida" }),
		);
		expect(() => sign(nfe(), { tag: "infEvento" })).toThrowError(
			expect.objectContaining({ code: "elemento_ausente" }),
		);
		const injetado = nfe().replace(ID, "NFe1' or '1'='1");
		expect(() => sign(injetado)).toThrowError(expect.objectContaining({ code: "id_invalido" }));
	});

	it("só assina produção (tpAmb=1) quando o emitente liberou", () => {
		const producao = nfe().replace("<tpAmb>2</tpAmb>", "<tpAmb>1</tpAmb>");
		expect(() => sign(producao)).toThrowError(
			expect.objectContaining({ code: "producao_bloqueada" }),
		);
		expect(sign(producao, { allowProduction: true }).environment).toBe("producao");
		expect(() => sign(nfe().replace("<tpAmb>2</tpAmb>", ""))).toThrowError(
			expect.objectContaining({ code: "ambiente_ausente" }),
		);
	});

	it("recusa XML malformado", () => {
		expect(() => sign("<NFe><infNFe></NFe>")).toThrowError(SignError);
	});

	it("assina DPS da NFS-e usando o papel indicado em tpEmit", () => {
		const dps = (tpEmit: string) =>
			`<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="DPS355030821122233300018100001000000000000001">` +
			`<tpAmb>2</tpAmb><tpEmit>${tpEmit}</tpEmit><prest><CNPJ>${CNPJ_TESTE}</CNPJ></prest><toma><CNPJ>99888777000166</CNPJ></toma></infDPS></DPS>`;
		expect(sign(dps("1"), { tag: "infDPS", profile: "rsa-sha256" }).emitter).toBe(CNPJ_TESTE);
		expect(() => sign(dps("2"), { tag: "infDPS" })).toThrowError(
			expect.objectContaining({ code: "emitente_divergente" }),
		);
	});
});
