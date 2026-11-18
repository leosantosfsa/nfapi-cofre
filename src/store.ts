// Acesso ao D1 (estado do cofre) e ao R2 (documentos e diário de transmissões).

import { decryptJson, encryptJson } from "./crypto";
import type { Holder, ParsedCertificate } from "./pfx";
import { type CertificateInfo, sha256Hex } from "./protocol";

/** Material sensível do certificado; só existe decifrado em memória. */
export interface CertificateSecrets {
	privateKeyPem: string;
	certificatePem: string;
	chainPem: string[];
}

export interface StoredCertificate {
	info: CertificateInfo;
	holder: Holder;
	secrets: CertificateSecrets;
}

interface CertificateRow {
	ciphertext: string;
	iv: string;
	holder_kind: "cnpj" | "cpf";
	holder_id: string;
	common_name: string;
	issuer: string;
	serial_number: string;
	not_before: number;
	not_after: number;
	installed_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function rowToInfo(row: CertificateRow): CertificateInfo {
	return {
		holder: { kind: row.holder_kind, id: row.holder_id },
		commonName: row.common_name,
		issuer: row.issuer,
		serialNumber: row.serial_number,
		notBefore: iso(row.not_before),
		notAfter: iso(row.not_after),
		installedAt: iso(row.installed_at),
	};
}

export async function saveCertificate(
	db: D1Database,
	secret: string,
	cert: ParsedCertificate,
): Promise<CertificateInfo> {
	const secrets: CertificateSecrets = {
		privateKeyPem: cert.privateKeyPem,
		certificatePem: cert.certificatePem,
		chainPem: cert.chainPem,
	};
	const { iv, ciphertext } = await encryptJson(secret, secrets);
	const now = Date.now();
	await db
		.prepare(
			`INSERT OR REPLACE INTO certificate
			 (id, ciphertext, iv, holder_kind, holder_id, common_name, issuer, serial_number, not_before, not_after, installed_at)
			 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			ciphertext,
			iv,
			cert.holder.kind,
			cert.holder.id,
			cert.commonName,
			cert.issuer,
			cert.serialNumber,
			cert.notBefore.getTime(),
			cert.notAfter.getTime(),
			now,
		)
		.run();
	const info = await getCertificateInfo(db);
	if (!info) throw new Error("Falha ao gravar o certificado.");
	return info;
}

export async function getCertificateInfo(db: D1Database): Promise<CertificateInfo | null> {
	const row = await db.prepare("SELECT * FROM certificate WHERE id = 1").first<CertificateRow>();
	return row ? rowToInfo(row) : null;
}

export async function loadCertificate(
	db: D1Database,
	secret: string,
): Promise<StoredCertificate | null> {
	const row = await db.prepare("SELECT * FROM certificate WHERE id = 1").first<CertificateRow>();
	if (!row) return null;
	const info = rowToInfo(row);
	const secrets = await decryptJson<CertificateSecrets>(secret, row.iv, row.ciphertext);
	return { info, holder: info.holder, secrets };
}

export async function deleteCertificate(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM certificate WHERE id = 1").run();
}

// ---------- Configurações ----------

export async function getAllowProduction(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare("SELECT value FROM settings WHERE key = 'allow_production'")
		.first<{ value: string }>();
	return row?.value === "true";
}

export async function setAllowProduction(db: D1Database, allow: boolean): Promise<void> {
	await db
		.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_production', ?)")
		.bind(String(allow))
		.run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

/** Chaves de configuração com o prefixo dado e valor não vazio. */
export async function listSettingKeys(db: D1Database, prefix: string): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT key FROM settings WHERE substr(key, 1, ?) = ? AND value != ''")
		.bind(prefix.length, prefix)
		.all<{ key: string }>();
	return results.map((r) => r.key);
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
}

// ---------- Auditoria ----------

export interface AuditEntry {
	at: string;
	action: string;
	actor: string;
	outcome: string;
	detail: Record<string, unknown>;
}

export async function audit(
	db: D1Database,
	entry: { action: string; actor: string; outcome: string; detail?: Record<string, unknown> },
): Promise<void> {
	await db
		.prepare("INSERT INTO audit (at, action, actor, outcome, detail) VALUES (?, ?, ?, ?, ?)")
		.bind(Date.now(), entry.action, entry.actor, entry.outcome, JSON.stringify(entry.detail ?? {}))
		.run();
}

export async function listAudit(db: D1Database, limit: number): Promise<AuditEntry[]> {
	const { results } = await db
		.prepare("SELECT at, action, actor, outcome, detail FROM audit ORDER BY id DESC LIMIT ?")
		.bind(Math.min(Math.max(limit, 1), 200))
		.all<{ at: number; action: string; actor: string; outcome: string; detail: string }>();
	return results.map((r) => ({
		at: iso(r.at),
		action: r.action,
		actor: r.actor,
		outcome: r.outcome,
		detail: JSON.parse(r.detail) as Record<string, unknown>,
	}));
}

// ---------- Documentos (R2 + índice no D1) ----------

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,480}$/;

export function isValidDocumentKey(key: string): boolean {
	return KEY_RE.test(key) && !key.includes("..") && !key.includes("//") && !key.startsWith("journal/");
}

export interface DocumentEntry {
	key: string;
	contentType: string;
	size: number;
	sha256: string;
	meta: Record<string, unknown>;
	createdAt: string;
}

export async function putDocument(
	db: D1Database,
	bucket: R2Bucket,
	input: { key: string; body: ArrayBuffer; contentType: string; meta: Record<string, unknown> },
): Promise<DocumentEntry> {
	const sha256 = await sha256Hex(input.body);
	const now = Date.now();
	await bucket.put(`docs/${input.key}`, input.body, {
		httpMetadata: { contentType: input.contentType },
		sha256,
	});
	await db
		.prepare(
			"INSERT OR REPLACE INTO documents (key, content_type, size, sha256, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(input.key, input.contentType, input.body.byteLength, sha256, JSON.stringify(input.meta), now)
		.run();
	return {
		key: input.key,
		contentType: input.contentType,
		size: input.body.byteLength,
		sha256,
		meta: input.meta,
		createdAt: iso(now),
	};
}

export function getDocument(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
	return bucket.get(`docs/${key}`);
}

/** Remove um documento de trabalho (por exemplo, a nota assinada que aguardava autorização). */
export async function deleteDocument(db: D1Database, bucket: R2Bucket, key: string): Promise<void> {
	await bucket.delete(`docs/${key}`);
	await db.prepare("DELETE FROM documents WHERE key = ?").bind(key).run();
}

export async function listDocuments(
	db: D1Database,
	opts: { prefix?: string; limit?: number; before?: number; emitidos?: boolean },
): Promise<DocumentEntry[]> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const { results } = await db
		.prepare(
			`SELECT key, content_type, size, sha256, meta, created_at FROM documents
			 WHERE key LIKE ? ESCAPE '\\' AND created_at < ?
			 AND (? = 0 OR key LIKE 'nfse/%' OR key LIKE 'nfe/%' OR key LIKE 'nfce/%')
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(`${(opts.prefix ?? "").replace(/[\\%_]/g, "\\$&")}%`, opts.before ?? Number.MAX_SAFE_INTEGER, opts.emitidos ? 1 : 0, limit)
		.all<{
			key: string;
			content_type: string;
			size: number;
			sha256: string;
			meta: string;
			created_at: number;
		}>();
	return results.map((r) => ({
		key: r.key,
		contentType: r.content_type,
		size: r.size,
		sha256: r.sha256,
		meta: JSON.parse(r.meta) as Record<string, unknown>,
		createdAt: iso(r.created_at),
	}));
}

/** Arquivos de uma nota emitida (a nota, a DPS e os eventos), pela chave de acesso. */
export async function listArquivosDaNota(db: D1Database, chaveAcesso: string): Promise<NotaArquivo[]> {
	const { results } = await db
		.prepare(
			`SELECT key, size, meta FROM documents
			 WHERE (key LIKE 'nfse/%' OR key LIKE 'nfe/%' OR key LIKE 'nfce/%') AND json_extract(meta, '$.chaveAcesso') = ?
			 ORDER BY created_at`,
		)
		.bind(chaveAcesso)
		.all<{ key: string; size: number; meta: string }>();
	const ordem = ["nfse", "nfe", "nfce", "dps", "carta_correcao", "cancelamento"];
	const posicao = (tipo: string) => (ordem.includes(tipo) ? ordem.indexOf(tipo) : ordem.length);
	return results
		.map((r) => {
			const meta = JSON.parse(r.meta) as Record<string, unknown>;
			return { tipo: typeof meta.tipo === "string" ? meta.tipo : "arquivo", key: r.key, nome: r.key.split("/").pop() ?? r.key, tamanho: r.size };
		})
		// A cópia de trabalho enviada à SEFAZ não é um arquivo da nota.
		.filter((a) => a.tipo !== "enviada")
		.sort((a, b) => posicao(a.tipo) - posicao(b.tipo));
}

// ---------- Notas emitidas (visão do emitente) ----------

export interface NotaArquivo {
	tipo: string;
	key: string;
	nome: string;
	tamanho: number;
}

export interface Nota {
	/** nfse, nfe (modelo 55) ou nfce (modelo 65). */
	modelo: string;
	chaveAcesso: string;
	ambiente: string | null;
	numeroNfse: string | null;
	serie: string | null;
	numeroDps: number | null;
	valor: number | null;
	emitidaEm: string;
	/** `contingencia`: NFC-e emitida offline, aguardando a transmissão à SEFAZ. */
	situacao: "autorizada" | "cancelada" | "denegada" | "contingencia";
	canceladaEm: string | null;
	arquivos: NotaArquivo[];
}

/**
 * Agrupa os documentos arquivados por nota (chave de acesso). A situação vem
 * dos próprios arquivos: se há evento de cancelamento arquivado, está cancelada.
 */
export async function listNotas(db: D1Database, limit = 100): Promise<Nota[]> {
	// Só os documentos emitidos: as notas recebidas de terceiros têm lista própria.
	const docs = (await listDocuments(db, { limit: 200, emitidos: true })).filter((d) => /^(nfse|nfe|nfce)\//.test(d.key));
	const notas = new Map<string, Nota>();
	// Do mais antigo para o mais novo, para a nota nascer antes dos seus eventos.
	for (const doc of [...docs].reverse()) {
		const meta = doc.meta as Record<string, unknown>;
		const chave = typeof meta.chaveAcesso === "string" ? meta.chaveAcesso : null;
		if (!chave) continue;
		let nota = notas.get(chave);
		if (!nota) {
			nota = {
				modelo: doc.key.split("/")[0] ?? "nfse",
				chaveAcesso: chave,
				// Sem metadado de ambiente (notas antigas), o caminho do arquivo informa.
				ambiente: typeof meta.ambiente === "string" ? meta.ambiente : (doc.key.split("/")[1] ?? null),
				numeroNfse: null,
				serie: null,
				numeroDps: null,
				valor: null,
				emitidaEm: doc.createdAt,
				situacao: "autorizada",
				canceladaEm: null,
				arquivos: [],
			};
			notas.set(chave, nota);
		}
		const tipo = typeof meta.tipo === "string" ? meta.tipo : "arquivo";
		if (tipo === "nfe" || tipo === "nfce") {
			// NF-e e NFC-e: o número da nota é o da própria série.
			nota.numeroNfse = meta.numero !== undefined ? String(meta.numero) : nota.numeroNfse;
			nota.serie = meta.serie !== undefined ? String(meta.serie) : nota.serie;
			nota.valor = typeof meta.valor === "number" ? meta.valor : nota.valor;
			nota.emitidaEm = typeof meta.emitidaEm === "string" ? meta.emitidaEm : doc.createdAt;
			if (meta.situacao === "denegada" || meta.situacao === "contingencia") nota.situacao = meta.situacao;
		}
		if (tipo === "nfse") {
			nota.numeroNfse = meta.numeroNfse ? String(meta.numeroNfse) : nota.numeroNfse;
			nota.serie = meta.serie ? String(meta.serie) : nota.serie;
			nota.numeroDps = typeof meta.numeroDps === "number" ? meta.numeroDps : nota.numeroDps;
			nota.valor = typeof meta.valor === "number" ? meta.valor : nota.valor;
			nota.emitidaEm = typeof meta.emitidaEm === "string" ? meta.emitidaEm : doc.createdAt;
		}
		if (tipo === "cancelamento") {
			nota.situacao = "cancelada";
			nota.canceladaEm = typeof meta.canceladaEm === "string" ? meta.canceladaEm : doc.createdAt;
		}
		nota.arquivos.push({
			tipo,
			key: doc.key,
			nome: doc.key.split("/").pop() ?? doc.key,
			tamanho: doc.size,
		});
	}
	// A nota primeiro, depois a DPS e os eventos.
	const ordem = ["nfse", "nfe", "nfce", "dps", "carta_correcao", "cancelamento"];
	const posicao = (tipo: string) => (ordem.includes(tipo) ? ordem.indexOf(tipo) : ordem.length);
	for (const nota of notas.values()) nota.arquivos.sort((a, b) => posicao(a.tipo) - posicao(b.tipo));
	return [...notas.values()].sort((a, b) => b.emitidaEm.localeCompare(a.emitidaEm)).slice(0, limit);
}

/** Grava a troca completa com o governo, antes de a emissão seguir adiante. */
export async function writeJournal(
	bucket: R2Bucket,
	entry: Record<string, unknown>,
): Promise<string> {
	const now = new Date();
	const day = now.toISOString().slice(0, 10).replace(/-/g, "/");
	const key = `journal/${day}/${now.getTime()}-${crypto.randomUUID().slice(0, 8)}.json`;
	await bucket.put(key, JSON.stringify(entry), {
		httpMetadata: { contentType: "application/json" },
	});
	return key;
}
