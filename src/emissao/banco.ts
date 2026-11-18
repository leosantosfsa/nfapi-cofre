// Emissões e chaves de API no D1 do cofre.

import type { Ambiente } from "../fiscal/dados";
import type { Mensagem } from "../nfse";

export type EmissionStatus =
	| "processando"
	| "autorizada"
	| "rejeitada"
	| "denegada"
	/** NFC-e emitida em contingência offline, aguardando a transmissão à SEFAZ. */
	| "contingencia"
	| "erro"
	| "indefinida"
	| "cancelada";

/** Documentos que o cofre emite: NFS-e, NF-e (modelo 55) e NFC-e (modelo 65). */
export type Kind = "nfse" | "nfe" | "nfce";

export interface Emission {
	id: string;
	docId: string;
	kind: Kind;
	environment: Ambiente;
	reference: string | null;
	serie: string;
	number: number;
	documentId: string;
	status: EmissionStatus;
	accessKey: string | null;
	fiscalNumber: string | null;
	messages: Mensagem[];
	documentKey: string | null;
	journalKey: string | null;
	/** Hash do pedido que criou a emissão (null nas emissões anteriores à 0.3). */
	requestHash: string | null;
	/** Protocolo de autorização (NF-e/NFC-e). */
	protocol: string | null;
	/** Dados próprios de cada documento: valor, QR Code, sequência de eventos. */
	extra: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	/** Data e hora de emissão (ISO 8601) e o dia no horário de Brasília; preenchidos pelo resumo. */
	issuedAt?: string | null;
	issuedDay?: string | null;
	value?: number | null;
	/** Destinatário (NF-e, NFC-e) ou tomador (NFS-e). */
	recipientDoc?: string | null;
	recipientName?: string | null;
}

type Row = Record<string, unknown>;
const hex = (bytes: ArrayBuffer | Uint8Array) =>
	[...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function newId(prefix: "nfs" | "nfe" | "nfc" | "inu" | "chv"): string {
	return `${prefix}_${hex(crypto.getRandomValues(new Uint8Array(10)))}`;
}

/** JSON com as chaves em ordem, para que pedidos iguais tenham o mesmo hash. */
function estavel(valor: unknown): unknown {
	if (Array.isArray(valor)) return valor.map(estavel);
	if (valor && typeof valor === "object") {
		const entrada = valor as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(entrada)
				.sort()
				.filter((k) => entrada[k] !== undefined)
				.map((k) => [k, estavel(entrada[k])]),
		);
	}
	return valor;
}

/** Resposta para a mesma referência reenviada com outro conteúdo. */
export const REFERENCIA_DIVERGENTE = {
	codigo: "referencia_com_conteudo_diferente",
	mensagem:
		"Esta referência já foi usada em um pedido com conteúdo diferente. Use outra referência para um documento novo.",
} as const;

/** Hash do conteúdo de um pedido, usado na idempotência por referência. */
export async function hashPedido(pedido: unknown): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(estavel(pedido)))));
}

const toEmission = (r: Row): Emission => ({
	id: r.id as string,
	docId: r.doc_id as string,
	kind: r.kind as Kind,
	environment: r.environment as Ambiente,
	reference: (r.reference as string | null) ?? null,
	serie: r.serie as string,
	number: r.number as number,
	documentId: r.document_id as string,
	status: r.status as EmissionStatus,
	accessKey: (r.access_key as string | null) ?? null,
	fiscalNumber: (r.fiscal_number as string | null) ?? null,
	messages: JSON.parse(r.messages as string) as Mensagem[],
	documentKey: (r.document_key as string | null) ?? null,
	journalKey: (r.journal_key as string | null) ?? null,
	requestHash: (r.request_hash as string | null) ?? null,
	protocol: (r.protocol as string | null) ?? null,
	extra: JSON.parse((r.extra as string | null) ?? "{}") as Record<string, unknown>,
	createdAt: r.created_at as number,
	updatedAt: r.updated_at as number,
	issuedAt: (r.issued_at as string | null) ?? null,
	issuedDay: (r.issued_day as string | null) ?? null,
	value: (r.value as number | null) ?? null,
	recipientDoc: (r.recipient_doc as string | null) ?? null,
	recipientName: (r.recipient_name as string | null) ?? null,
});

// ---------- Resumo para o painel e os relatórios ----------

/** Dia (AAAA-MM-DD) de uma data ISO: a que traz fuso já está no horário local; as demais valem por Brasília. */
export function diaDe(iso: string | null | undefined, criadaEm: number): string {
	if (iso && !iso.endsWith("Z") && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
	const ms = iso ? Date.parse(iso) : criadaEm;
	return new Date((Number.isFinite(ms) ? ms : criadaEm) - 3 * 3_600_000).toISOString().slice(0, 10);
}

export interface ResumoDaEmissao {
	issuedAt?: string | null;
	value?: number | null;
	recipientDoc?: string | null;
	recipientName?: string | null;
}

/**
 * Grava os dados por onde o painel filtra. Campo ausente mantém o que havia;
 * a emissão fica marcada como conferida.
 */
export async function anotarResumo(db: D1Database, id: string, r: ResumoDaEmissao): Promise<void> {
	await db
		.prepare(
			`UPDATE emissions SET issued_at = COALESCE(?1, issued_at), value = COALESCE(?2, value),
			 recipient_doc = COALESCE(?3, recipient_doc), recipient_name = COALESCE(?4, recipient_name), summarized = 1
			 WHERE id = ?5`,
		)
		.bind(r.issuedAt ?? null, r.value ?? null, r.recipientDoc ?? null, r.recipientName ?? null, id)
		.run();
	// O dia acompanha a data: recalculado a partir do que ficou gravado.
	const row = await db.prepare("SELECT issued_at, created_at FROM emissions WHERE id = ?").bind(id).first<{ issued_at: string | null; created_at: number }>();
	if (row) await db.prepare("UPDATE emissions SET issued_day = ? WHERE id = ?").bind(diaDe(row.issued_at, row.created_at), id).run();
}

/** Emissões anteriores ao painel, ainda sem o destinatário conferido no XML. */
export async function listSemResumo(db: D1Database, limite: number): Promise<Emission[]> {
	const { results } = await db.prepare("SELECT * FROM emissions WHERE summarized = 0 ORDER BY created_at DESC LIMIT ?").bind(limite).all<Row>();
	return results.map(toEmission);
}

export async function contarSemResumo(db: D1Database): Promise<number> {
	return (await db.prepare("SELECT COUNT(*) AS n FROM emissions WHERE summarized = 0").first<{ n: number }>())?.n ?? 0;
}

export interface FiltroDeEmissoes {
	/** Período, pelos dias de emissão (AAAA-MM-DD), inclusive. */
	de?: string;
	ate?: string;
	kind?: Kind;
	status?: EmissionStatus;
	environment?: Ambiente;
	/** Chave de acesso, número, referência, ou parte do nome ou do documento do destinatário. */
	busca?: string;
}

const ONDE = `(?1 IS NULL OR issued_day >= ?1) AND (?2 IS NULL OR issued_day <= ?2) AND (?3 IS NULL OR kind = ?3)
	AND (?4 IS NULL OR status = ?4) AND (?5 IS NULL OR environment = ?5)
	AND (?6 IS NULL OR access_key = ?6 OR CAST(number AS TEXT) = ?6 OR fiscal_number = ?6 OR reference = ?6
	     OR recipient_doc LIKE ?7 ESCAPE '\\' OR recipient_name LIKE ?8 ESCAPE '\\')`;

/**
 * Termo de busca e os padrões para o documento e para o nome. Documento
 * digitado com pontuação é comparado só pelos dígitos; um número curto procura
 * a nota pelo número, e não um pedaço de CNPJ.
 */
export function termosDeBusca(busca: string | undefined): [termo: string | null, documento: string | null, nome: string | null] {
	const texto = busca?.trim() || null;
	if (!texto) return [null, null, null];
	const soDigitos = /^[\d.\-/\s]+$/.test(texto);
	const termo = soDigitos ? texto.replace(/\D/g, "") : texto;
	const padrao = `%${termo.replace(/[\\%_]/g, "\\$&")}%`;
	return [termo, !soDigitos || termo.length >= 5 ? padrao : null, soDigitos ? null : padrao];
}

function parametros(f: FiltroDeEmissoes): (string | null)[] {
	return [f.de ?? null, f.ate ?? null, f.kind ?? null, f.status ?? null, f.environment ?? null, ...termosDeBusca(f.busca)];
}

/** Emissões do filtro, da mais recente para a mais antiga, com o total e a soma dos valores. */
export async function buscarEmissoes(
	db: D1Database,
	filtro: FiltroDeEmissoes,
	pagina: { limite: number; salto: number },
): Promise<{ itens: Emission[]; total: number; valor: number }> {
	const p = parametros(filtro);
	const [lista, soma] = await Promise.all([
		db
			.prepare(`SELECT * FROM emissions WHERE ${ONDE} ORDER BY issued_day DESC, created_at DESC, rowid DESC LIMIT ?9 OFFSET ?10`)
			.bind(...p, Math.min(Math.max(pagina.limite, 1), 200), Math.max(pagina.salto, 0))
			.all<Row>(),
		db
			.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM emissions WHERE ${ONDE}`)
			.bind(...p)
			.first<{ n: number; v: number }>(),
	]);
	return { itens: lista.results.map(toEmission), total: soma?.n ?? 0, valor: soma?.v ?? 0 };
}

/** Quantidade e valor por documento e situação, no período. */
export async function totaisPorSituacao(db: D1Database, filtro: Pick<FiltroDeEmissoes, "de" | "ate" | "environment">): Promise<{ kind: Kind; status: EmissionStatus; quantidade: number; valor: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM emissions
			 WHERE (?1 IS NULL OR issued_day >= ?1) AND (?2 IS NULL OR issued_day <= ?2) AND (?3 IS NULL OR environment = ?3)
			 GROUP BY kind, status`,
		)
		.bind(filtro.de ?? null, filtro.ate ?? null, filtro.environment ?? null)
		.all<{ kind: Kind; status: EmissionStatus; n: number; v: number }>();
	return results.map((r) => ({ kind: r.kind, status: r.status, quantidade: r.n, valor: r.v }));
}

/** Notas autorizadas por dia, no período: a série do gráfico da visão geral. */
export async function autorizadasPorDia(db: D1Database, filtro: Pick<FiltroDeEmissoes, "de" | "ate" | "environment">): Promise<{ dia: string; quantidade: number; valor: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT issued_day AS dia, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM emissions
			 WHERE status = 'autorizada' AND issued_day IS NOT NULL
			 AND (?1 IS NULL OR issued_day >= ?1) AND (?2 IS NULL OR issued_day <= ?2) AND (?3 IS NULL OR environment = ?3)
			 GROUP BY issued_day ORDER BY issued_day`,
		)
		.bind(filtro.de ?? null, filtro.ate ?? null, filtro.environment ?? null)
		.all<{ dia: string; n: number; v: number }>();
	return results.map((r) => ({ dia: r.dia, quantidade: r.n, valor: r.v }));
}

export interface SerieKey {
	docId: string;
	kind: Kind;
	environment: Ambiente;
	serie: string;
}

// ---------- Séries cadastradas (NF-e e NFC-e) ----------

export interface Serie extends SerieKey {
	lastNumber: number;
	label: string | null;
	createdAt: number | null;
}

const toSerie = (r: Row): Serie => ({
	docId: r.doc_id as string,
	kind: r.kind as Kind,
	environment: r.environment as Ambiente,
	serie: r.serie as string,
	lastNumber: r.last_number as number,
	label: (r.label as string | null) ?? null,
	createdAt: (r.created_at as number | null) ?? null,
});

export async function getSerie(db: D1Database, k: SerieKey): Promise<Serie | null> {
	const row = await db
		.prepare("SELECT * FROM series WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ?")
		.bind(k.docId, k.kind, k.environment, k.serie)
		.first<Row>();
	return row ? toSerie(row) : null;
}

export async function listSeries(db: D1Database, docId: string): Promise<Serie[]> {
	const { results } = await db
		.prepare("SELECT * FROM series WHERE doc_id = ? ORDER BY kind, environment, CAST(serie AS INTEGER), serie")
		.bind(docId)
		.all<Row>();
	return results.map(toSerie);
}

/** Séries do titular e das filiais (CNPJ de mesma raiz, 8 primeiras posições). */
export async function listSeriesDaRaiz(db: D1Database, raiz: string): Promise<Serie[]> {
	const { results } = await db
		.prepare("SELECT * FROM series WHERE substr(doc_id, 1, 8) = ? ORDER BY kind, environment, doc_id, CAST(serie AS INTEGER), serie")
		.bind(raiz)
		.all<Row>();
	return results.map(toSerie);
}

/** Maior número da série que está em uso (autorizado, em andamento ou sem resposta conclusiva). */
export async function maiorNumeroEmUso(db: D1Database, k: SerieKey): Promise<number> {
	const row = await db
		.prepare(
			`SELECT MAX(n) AS n FROM (
				SELECT MAX(number) AS n FROM emissions
				 WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ? AND status NOT IN ('rejeitada', 'erro')
				UNION ALL
				SELECT MAX(last_number) AS n FROM inutilizacoes
				 WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ?)`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, k.docId, k.kind, k.environment, k.serie)
		.first<{ n: number | null }>();
	return row?.n ?? 0;
}

/**
 * Cadastra a série ou ajusta o próximo número. Devolve null quando o próximo
 * número pedido já foi usado nesta série (o que geraria duplicidade).
 */
export async function salvarSerie(
	db: D1Database,
	k: SerieKey,
	dados: { proximoNumero?: number; label?: string | null },
): Promise<Serie | null> {
	const atual = await getSerie(db, k);
	const proximo = dados.proximoNumero ?? (atual ? atual.lastNumber + 1 : 1);
	if (proximo <= (await maiorNumeroEmUso(db, k))) return null;
	await db
		.prepare(
			`INSERT INTO series (doc_id, kind, environment, serie, last_number, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (doc_id, kind, environment, serie)
			 DO UPDATE SET last_number = excluded.last_number, label = excluded.label`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, proximo - 1, dados.label === undefined ? (atual?.label ?? null) : dados.label, Date.now())
		.run();
	return getSerie(db, k);
}

/** Reserva o próximo número de uma série cadastrada. Null se a série não existe. */
export async function nextNumberCadastrada(db: D1Database, k: SerieKey): Promise<number | null> {
	const row = await db
		.prepare(
			`UPDATE series SET last_number = last_number + 1
			 WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ? RETURNING last_number`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie)
		.first<{ last_number: number }>();
	return row?.last_number ?? null;
}

/**
 * Devolve à série um número que não chegou a existir para o governo. Só vale
 * quando ele é o último reservado; fora disso o número fica como lacuna, a ser
 * inutilizada.
 */
export async function devolverNumero(db: D1Database, k: SerieKey, number: number): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE series SET last_number = last_number - 1
			 WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ? AND last_number = ?`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, number)
		.run();
	return res.meta.changes > 0;
}

/** A série avança para depois de uma faixa inutilizada ou de um número já usado fora do cofre. */
export async function avancarSerie(db: D1Database, k: SerieKey, ate: number): Promise<void> {
	await db
		.prepare(
			`UPDATE series SET last_number = MAX(last_number, ?)
			 WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ?`,
		)
		.bind(ate, k.docId, k.kind, k.environment, k.serie)
		.run();
}

/** Reserva o próximo número da série, de forma atômica. */
export async function nextNumber(db: D1Database, k: SerieKey): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO series (doc_id, kind, environment, serie, last_number) VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT (doc_id, kind, environment, serie) DO UPDATE SET last_number = last_number + 1
			 RETURNING last_number`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie)
		.first<{ last_number: number }>();
	if (!row) throw new Error("Falha ao reservar o número da série.");
	return row.last_number;
}

/** Quando o cliente informa o número, a série avança para não reutilizá-lo depois. */
export async function noteNumber(db: D1Database, k: SerieKey, number: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO series (doc_id, kind, environment, serie, last_number) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (doc_id, kind, environment, serie)
			 DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, number)
		.run();
}

/** Grava a emissão. Devolve false se o número (ou a referência) já estiver em uso. */
export async function insertEmission(db: D1Database, e: Emission): Promise<boolean> {
	try {
		await db
			.prepare(
				`INSERT INTO emissions (id, doc_id, kind, environment, reference, serie, number, document_id,
				 status, messages, request_hash, extra, created_at, updated_at, issued_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
			)
			.bind(
				e.id, e.docId, e.kind, e.environment, e.reference, e.serie, e.number, e.documentId, e.status,
				e.requestHash, JSON.stringify(e.extra), e.createdAt, e.updatedAt, diaDe(null, e.createdAt),
			)
			.run();
		return true;
	} catch (err) {
		if (/UNIQUE constraint/i.test(String(err instanceof Error ? err.message : err))) return false;
		throw err;
	}
}

export async function updateEmission(
	db: D1Database,
	id: string,
	patch: Partial<
		Pick<
			Emission,
			| "status" | "accessKey" | "fiscalNumber" | "messages" | "documentKey" | "journalKey" | "documentId"
			| "number" | "requestHash" | "protocol" | "extra"
		>
	>,
): Promise<Emission> {
	const current = await db.prepare("SELECT * FROM emissions WHERE id = ?").bind(id).first<Row>();
	if (!current) throw new Error(`Emissão ${id} inexistente.`);
	const next = { ...toEmission(current), ...patch, updatedAt: Date.now() };
	await db
		.prepare(
			`UPDATE emissions SET status = ?, access_key = ?, fiscal_number = ?, messages = ?,
			 document_key = ?, journal_key = ?, document_id = ?, number = ?, request_hash = ?, protocol = ?,
			 extra = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(
			next.status, next.accessKey, next.fiscalNumber, JSON.stringify(next.messages), next.documentKey,
			next.journalKey, next.documentId, next.number, next.requestHash, next.protocol,
			JSON.stringify(next.extra), next.updatedAt, id,
		)
		.run();
	return next;
}

export async function getEmission(db: D1Database, id: string): Promise<Emission | null> {
	const row = await db.prepare("SELECT * FROM emissions WHERE id = ?").bind(id).first<Row>();
	return row ? toEmission(row) : null;
}

export async function findByReference(db: D1Database, k: Omit<SerieKey, "serie">, reference: string): Promise<Emission | null> {
	const row = await db
		.prepare("SELECT * FROM emissions WHERE doc_id = ? AND kind = ? AND environment = ? AND reference = ?")
		.bind(k.docId, k.kind, k.environment, reference)
		.first<Row>();
	return row ? toEmission(row) : null;
}

export async function findByAccessKey(db: D1Database, accessKey: string): Promise<Emission | null> {
	const row = await db.prepare("SELECT * FROM emissions WHERE access_key = ?").bind(accessKey).first<Row>();
	return row ? toEmission(row) : null;
}

export async function listEmissions(
	db: D1Database,
	limit: number,
	filtro: { kind?: Kind; reference?: string; environment?: Ambiente } = {},
): Promise<Emission[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM emissions WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR reference = ?2)
			 AND (?4 IS NULL OR environment = ?4)
			 ORDER BY created_at DESC, rowid DESC LIMIT ?3`,
		)
		.bind(filtro.kind ?? null, filtro.reference ?? null, Math.min(Math.max(limit, 1), 200), filtro.environment ?? null)
		.all<Row>();
	return results.map(toEmission);
}

/**
 * Emissões com pendência de contingência: as que aguardam transmissão e as que
 * ainda têm uma nota normal sem resposta para conferir. As mais antigas primeiro.
 */
export async function listPendentesDeContingencia(db: D1Database, limit: number): Promise<Emission[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM emissions
			 WHERE status = 'contingencia'
			    OR (status = 'autorizada' AND json_extract(extra, '$.original.chave') IS NOT NULL AND json_extract(extra, '$.original.falha') IS NULL)
			 ORDER BY created_at, rowid LIMIT ?`,
		)
		.bind(Math.min(Math.max(limit, 1), 200))
		.all<Row>();
	return results.map(toEmission);
}

/** Quantas notas estão em contingência, aguardando a transmissão. */
export async function contarEmContingencia(db: D1Database): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM emissions WHERE status = 'contingencia'").first<{ n: number }>();
	return row?.n ?? 0;
}

// ---------- Inutilizações ----------

export interface Inutilizacao extends SerieKey {
	id: string;
	firstNumber: number;
	lastNumber: number;
	protocol: string | null;
	justification: string;
	documentKey: string | null;
	createdAt: number;
}

export async function insertInutilizacao(db: D1Database, i: Inutilizacao): Promise<void> {
	await db
		.prepare(
			`INSERT INTO inutilizacoes (id, doc_id, kind, environment, serie, first_number, last_number, protocol,
			 justification, document_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(i.id, i.docId, i.kind, i.environment, i.serie, i.firstNumber, i.lastNumber, i.protocol, i.justification, i.documentKey, i.createdAt)
		.run();
}

const toInutilizacao = (r: Row): Inutilizacao => ({
	id: r.id as string,
	docId: r.doc_id as string,
	kind: r.kind as Kind,
	environment: r.environment as Ambiente,
	serie: r.serie as string,
	firstNumber: r.first_number as number,
	lastNumber: r.last_number as number,
	protocol: (r.protocol as string | null) ?? null,
	justification: r.justification as string,
	documentKey: (r.document_key as string | null) ?? null,
	createdAt: r.created_at as number,
});

export async function listInutilizacoes(db: D1Database, limit = 200): Promise<Inutilizacao[]> {
	const { results } = await db.prepare("SELECT * FROM inutilizacoes ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(limit).all<Row>();
	return results.map(toInutilizacao);
}

export async function getInutilizacao(db: D1Database, id: string): Promise<Inutilizacao | null> {
	const row = await db.prepare("SELECT * FROM inutilizacoes WHERE id = ?").bind(id).first<Row>();
	return row ? toInutilizacao(row) : null;
}

/** A inutilização exatamente desta faixa, se o cofre já a registrou. */
export async function findInutilizacao(db: D1Database, k: SerieKey, de: number, ate: number): Promise<Inutilizacao | null> {
	const row = await db
		.prepare(
			`SELECT * FROM inutilizacoes WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ?
			 AND first_number = ? AND last_number = ?`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, de, ate)
		.first<Row>();
	return row ? toInutilizacao(row) : null;
}

/** Se o número caiu numa faixa inutilizada, devolve o fim dela; senão, null. */
export async function fimDaFaixaInutilizada(db: D1Database, k: SerieKey, number: number): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT MAX(last_number) AS fim FROM inutilizacoes
			 WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ? AND first_number <= ? AND last_number >= ?`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, number, number)
		.first<{ fim: number | null }>();
	return row?.fim ?? null;
}

/** Há emissão em uso dentro da faixa? (Número autorizado não pode ser inutilizado.) */
export async function numerosEmUsoNaFaixa(db: D1Database, k: SerieKey, de: number, ate: number): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM emissions WHERE doc_id = ? AND kind = ? AND environment = ? AND serie = ?
			 AND number BETWEEN ? AND ? AND status NOT IN ('rejeitada', 'erro')`,
		)
		.bind(k.docId, k.kind, k.environment, k.serie, de, ate)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

// ---------- Chaves de API ----------

export type Escopo = "completo" | "homologacao";

export interface ApiKey {
	id: string;
	name: string;
	prefix: string;
	scope: Escopo;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

const toApiKey = (r: Row): ApiKey => ({
	id: r.id as string,
	name: r.name as string,
	prefix: r.prefix as string,
	scope: r.scope as Escopo,
	createdAt: r.created_at as number,
	lastUsedAt: (r.last_used_at as number | null) ?? null,
	revokedAt: (r.revoked_at as number | null) ?? null,
});

export function looksLikeApiKey(value: string): boolean {
	return /^nfapi_[A-Za-z0-9_-]{40,60}$/.test(value);
}

async function hashKey(key: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
}

/** Cria uma chave. O valor completo só existe no retorno desta função. */
export async function createApiKey(db: D1Database, name: string, scope: Escopo): Promise<{ key: ApiKey; value: string }> {
	const random = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const value = `nfapi_${random}`;
	const key: ApiKey = { id: newId("chv"), name, prefix: value.slice(0, 12), scope, createdAt: Date.now(), lastUsedAt: null, revokedAt: null };
	await db
		.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(key.id, key.name, key.prefix, await hashKey(value), key.scope, key.createdAt)
		.run();
	return { key, value };
}

export async function findApiKey(db: D1Database, value: string): Promise<ApiKey | null> {
	if (!looksLikeApiKey(value)) return null;
	const row = await db
		.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
		.bind(await hashKey(value))
		.first<Row>();
	return row ? toApiKey(row) : null;
}

export async function touchApiKey(db: D1Database, id: string): Promise<void> {
	await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function listApiKeys(db: D1Database): Promise<ApiKey[]> {
	const { results } = await db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all<Row>();
	return results.map(toApiKey);
}

export async function revokeApiKey(db: D1Database, id: string): Promise<boolean> {
	const res = await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), id).run();
	return res.meta.changes > 0;
}
