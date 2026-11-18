// Logotipo do emitente, impresso no DANFE e no DANFE NFC-e.
//
// É configuração do cofre: o emitente envia a imagem na tela /setup e ela fica
// no mesmo bucket dos documentos, fora da área das notas.

import type { Logotipo } from "./danfe/leitura";

const CHAVE = "config/logotipo";
export const TAMANHO_MAXIMO = 300 * 1024;

export class LogotipoError extends Error {}

function tipoDaImagem(bytes: Uint8Array): Logotipo["tipo"] | undefined {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	return undefined;
}

export async function temLogotipo(bucket: R2Bucket): Promise<boolean> {
	return (await bucket.head(CHAVE)) !== null;
}

export async function lerLogotipo(bucket: R2Bucket): Promise<Logotipo | undefined> {
	const objeto = await bucket.get(CHAVE);
	if (!objeto) return undefined;
	const bytes = new Uint8Array(await objeto.arrayBuffer());
	const tipo = tipoDaImagem(bytes);
	return tipo ? { bytes, tipo } : undefined;
}

/** Confere a imagem (PNG ou JPEG que o gerador de PDF consegue ler) e a guarda. */
export async function salvarLogotipo(bucket: R2Bucket, bytes: Uint8Array): Promise<{ tipo: Logotipo["tipo"]; tamanho: number; largura: number; altura: number }> {
	if (bytes.byteLength === 0) throw new LogotipoError("Envie a imagem do logotipo.");
	if (bytes.byteLength > TAMANHO_MAXIMO) throw new LogotipoError(`O logotipo pode ter até ${TAMANHO_MAXIMO / 1024} KB.`);
	const tipo = tipoDaImagem(bytes);
	if (!tipo) throw new LogotipoError("O logotipo precisa ser uma imagem PNG ou JPEG.");
	let largura: number;
	let altura: number;
	try {
		const { PDFDocument } = await import("pdf-lib");
		const pdf = await PDFDocument.create();
		const imagem = tipo === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
		largura = imagem.width;
		altura = imagem.height;
	} catch {
		throw new LogotipoError("Não foi possível ler a imagem. Salve-a de novo como PNG ou JPEG e reenvie.");
	}
	await bucket.put(CHAVE, bytes, { httpMetadata: { contentType: tipo } });
	return { tipo, tamanho: bytes.byteLength, largura, altura };
}

export async function removerLogotipo(bucket: R2Bucket): Promise<void> {
	await bucket.delete(CHAVE);
}
