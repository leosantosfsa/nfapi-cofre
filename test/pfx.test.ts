import { describe, expect, it } from "vitest";
import { PfxError, parsePfx } from "../src/pfx";
import certPem from "./fixtures/a1-teste.cert.pem?raw";
import { CNPJ_TESTE, SENHA_TESTE, pfxLegado, pfxModerno } from "./helpers";

const normalize = (pem: string) => pem.replace(/\s+/g, "");

describe("parsePfx", () => {
	it("lê um PFX moderno (AES-256 / MAC SHA-256, padrão do OpenSSL 3)", () => {
		const parsed = parsePfx(pfxModerno(), SENHA_TESTE);
		expect(parsed.holder).toEqual({ kind: "cnpj", id: CNPJ_TESTE });
		expect(parsed.commonName).toBe(`EMPRESA TESTE NFAPI LTDA:${CNPJ_TESTE}`);
		expect(normalize(parsed.certificatePem)).toBe(normalize(certPem));
		expect(parsed.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
		expect(parsed.notAfter.getTime()).toBeGreaterThan(parsed.notBefore.getTime());
		expect(parsed.chainPem).toEqual([]);
	});

	it("lê um PFX legado (3DES/RC2 / MAC SHA-1, comum em certificados A1 emitidos no Brasil)", () => {
		const parsed = parsePfx(pfxLegado(), SENHA_TESTE);
		expect(parsed.holder).toEqual({ kind: "cnpj", id: CNPJ_TESTE });
		expect(normalize(parsed.certificatePem)).toBe(normalize(certPem));
	});

	it("recusa senha incorreta com erro identificável", () => {
		try {
			parsePfx(pfxModerno(), "senha-errada");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(PfxError);
			expect((err as PfxError).code).toBe("senha_incorreta");
		}
	});

	it("recusa arquivo que não é PKCS#12", () => {
		try {
			parsePfx(new TextEncoder().encode("isto não é um pfx"), SENHA_TESTE);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(PfxError);
			expect((err as PfxError).code).toBe("arquivo_invalido");
		}
	});
});
