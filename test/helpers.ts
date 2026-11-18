import { parsePfx } from "../src/pfx";
import pfxB64 from "./fixtures/a1-teste.pfx.b64?raw";
import pfxLegadoB64 from "./fixtures/a1-teste-legado.pfx.b64?raw";

/** Senha dos PFX de teste (certificado autoassinado, sem validade fiscal). */
export const SENHA_TESTE = "teste123";
export const CNPJ_TESTE = "11222333000181";

export function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export const pfxModerno = () => b64ToBytes(pfxB64);
export const pfxLegado = () => b64ToBytes(pfxLegadoB64);
export const certificadoTeste = () => parsePfx(pfxModerno(), SENHA_TESTE);
