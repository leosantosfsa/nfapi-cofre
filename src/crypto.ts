// Derivação de chaves e cifragem do cofre. Tudo parte do VAULT_SECRET, que só
// existe como segredo do Worker na conta do emitente.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("nfapi-cofre");

/** O segredo precisa ter entropia suficiente; recusamos valores curtos. */
export function secretIsStrong(secret: string | undefined): secret is string {
	return typeof secret === "string" && secret.trim().length >= 32;
}

async function hkdfBits(secret: string, info: string): Promise<ArrayBuffer> {
	const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
		"deriveBits",
	]);
	return crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(info) },
		material,
		256,
	);
}

/** Chave que cifra o certificado guardado no D1. */
async function certificateKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		await hkdfBits(secret, "certificate/v1"),
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);
}

const AAD = encoder.encode("nfapi-cofre/certificate/v1");

export async function encryptJson(
	secret: string,
	value: unknown,
): Promise<{ iv: string; ciphertext: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: AAD },
		await certificateKey(secret),
		encoder.encode(JSON.stringify(value)),
	);
	return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(data)) };
}

export async function decryptJson<T>(secret: string, iv: string, ciphertext: string): Promise<T> {
	const data = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(iv), additionalData: AAD },
		await certificateKey(secret),
		fromBase64(ciphertext),
	);
	return JSON.parse(decoder.decode(data)) as T;
}

/** Compara o segredo informado na tela /setup com o do Worker, em tempo constante. */
export async function isAdminSecret(provided: string, secret: string): Promise<boolean> {
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(secret)),
	]);
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

export function toBase64(bytes: Uint8Array): string {
	let s = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		s += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
