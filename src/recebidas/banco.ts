// NF-e recebidas e o estado da distribuição de DF-e no D1 do cofre.

import { termosDeBusca } from "../emissao/banco";
import type { Ambiente } from "../fiscal/dados";
import type { SituacaoRecebida } from "../nfe/distribuicao";
import type { Manifestacao } from "../nfe/eventos";

type Row = Record<string, unknown>;

// ---------- Cursor da distribuição (um por CNPJ e ambiente) ----------

export interface Cursor {
	docId: string;
	environment: Ambiente;
	/** Sigla da UF do interessado. */
	uf: string;
	/** O agendador consulta sozinho? */
	auto: boolean;
	/** O agendador registra a ciência da operação das notas novas? */
	autoCiencia: boolean;
	ultNsu: number;
	maxNsu: number;
	/** Nenhuma consulta por sequência sai antes deste instante. */
	nextAt: number;
	lastAt: number | null;
	lastCode: string | null;
	lastMessage: string | null;
	/** Instantes das consultas pontuais (por chave ou por NSU) ainda dentro da última hora. */
	pontuais: number[];
	/** NSU que o cofre pulou e ainda vai buscar um a um: intervalos [de, até], inclusivos, em ordem. */
	lacunas: Lacuna[];
}

export type Lacuna = [de: number, ate: number];

/** Quantos NSU ainda faltam buscar. */
export const contarPulados = (lacunas: Lacuna[]) => lacunas.reduce((n, [de, ate]) => n + (ate - de + 1), 0);

/** O menor NSU pulado, ou null quando não há nenhum. */
export const proximoPulado = (lacunas: Lacuna[]): number | null => lacunas[0]?.[0] ?? null;

/** Tira da lista o menor NSU pulado. */
export function semOProximo(lacunas: Lacuna[]): Lacuna[] {
	const [primeira, ...resto] = lacunas;
	if (!primeira) return [];
	return primeira[0] < primeira[1] ? [[primeira[0] + 1, primeira[1]], ...resto] : resto;
}

/**
 * Acrescenta um intervalo pulado. A lista guarda no máximo `limite` NSU, os
 * mais recentes; devolve também quantos ficaram de fora.
 */
export function comLacuna(lacunas: Lacuna[], de: number, ate: number, limite: number): { lacunas: Lacuna[]; descartados: number } {
	let lista: Lacuna[] = ate >= de ? [...lacunas, [de, ate]] : [...lacunas];
	let excesso = contarPulados(lista) - limite;
	const descartados = Math.max(excesso, 0);
	while (excesso > 0 && lista[0]) {
		const [inicio, fim] = lista[0];
		const tamanho = fim - inicio + 1;
		lista = tamanho <= excesso ? lista.slice(1) : [[inicio + excesso, fim], ...lista.slice(1)];
		excesso -= Math.min(tamanho, excesso);
	}
	return { lacunas: lista, descartados };
}

const toCursor = (r: Row): Cursor => ({
	docId: r.doc_id as string,
	environment: r.environment as Ambiente,
	uf: r.uf as string,
	auto: r.auto === 1,
	autoCiencia: r.auto_ciencia === 1,
	ultNsu: r.ult_nsu as number,
	maxNsu: r.max_nsu as number,
	nextAt: r.next_at as number,
	lastAt: (r.last_at as number | null) ?? null,
	lastCode: (r.last_code as string | null) ?? null,
	lastMessage: (r.last_message as string | null) ?? null,
	pontuais: JSON.parse((r.pontuais as string | null) ?? "[]") as number[],
	lacunas: JSON.parse((r.lacunas as string | null) ?? "[]") as Lacuna[],
});

export async function getCursor(db: D1Database, docId: string, environment: Ambiente): Promise<Cursor | null> {
	const row = await db.prepare("SELECT * FROM dfe_cursores WHERE doc_id = ? AND environment = ?").bind(docId, environment).first<Row>();
	return row ? toCursor(row) : null;
}

export async function listCursores(db: D1Database): Promise<Cursor[]> {
	const { results } = await db.prepare("SELECT * FROM dfe_cursores ORDER BY environment DESC, doc_id").all<Row>();
	return results.map(toCursor);
}

/** Cria ou altera a configuração; o NSU e a espera não mudam. */
export async function configurarCursor(
	db: D1Database,
	k: { docId: string; environment: Ambiente },
	config: { uf: string; auto: boolean; autoCiencia: boolean },
): Promise<Cursor> {
	await db
		.prepare(
			`INSERT INTO dfe_cursores (doc_id, environment, uf, auto, auto_ciencia) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (doc_id, environment) DO UPDATE SET uf = excluded.uf, auto = excluded.auto, auto_ciencia = excluded.auto_ciencia`,
		)
		.bind(k.docId, k.environment, config.uf, config.auto ? 1 : 0, config.autoCiencia ? 1 : 0)
		.run();
	return (await getCursor(db, k.docId, k.environment)) as Cursor;
}

/**
 * Reserva a vez de consultar: só passa quem encontra a espera vencida, e a
 * reserva empurra a próxima consulta para `ate`. Assim duas execuções (o
 * agendador e um pedido manual) nunca consultam o mesmo NSU ao mesmo tempo.
 */
export async function reservarConsulta(db: D1Database, c: Cursor, agora: number, ate: number): Promise<boolean> {
	const res = await db
		.prepare("UPDATE dfe_cursores SET next_at = ? WHERE doc_id = ? AND environment = ? AND next_at <= ?")
		.bind(ate, c.docId, c.environment, agora)
		.run();
	return res.meta.changes > 0;
}

export async function atualizarCursor(
	db: D1Database,
	c: Cursor,
	patch: Partial<Pick<Cursor, "ultNsu" | "maxNsu" | "nextAt" | "lastAt" | "lastCode" | "lastMessage" | "pontuais" | "lacunas">>,
): Promise<Cursor> {
	const n = { ...c, ...patch };
	await db
		.prepare(
			`UPDATE dfe_cursores SET ult_nsu = ?, max_nsu = ?, next_at = ?, last_at = ?, last_code = ?, last_message = ?, pontuais = ?, lacunas = ?
			 WHERE doc_id = ? AND environment = ?`,
		)
		.bind(n.ultNsu, n.maxNsu, n.nextAt, n.lastAt, n.lastCode, n.lastMessage, JSON.stringify(n.pontuais), JSON.stringify(n.lacunas), c.docId, c.environment)
		.run();
	return n;
}

// ---------- Documentos distribuídos (registro bruto, por ordem de chegada) ----------

export type TipoDocumento = "resumo_nfe" | "nfe" | "resumo_evento" | "evento" | "outro";

export interface DocumentoDfe {
	seq: number;
	docId: string;
	environment: Ambiente;
	nsu: number | null;
	schema: string;
	kind: TipoDocumento;
	accessKey: string | null;
	eventType: string | null;
	eventSeq: number | null;
	detail: { descricao?: string | null; em?: string | null; protocolo?: string | null; autor?: string | null };
	documentKey: string;
	receivedAt: number;
}

const toDocumento = (r: Row): DocumentoDfe => ({
	seq: r.seq as number,
	docId: r.doc_id as string,
	environment: r.environment as Ambiente,
	nsu: (r.nsu as number | null) ?? null,
	schema: r.schema as string,
	kind: r.kind as TipoDocumento,
	accessKey: (r.access_key as string | null) ?? null,
	eventType: (r.event_type as string | null) ?? null,
	eventSeq: (r.event_seq as number | null) ?? null,
	detail: JSON.parse((r.detail as string | null) ?? "{}") as DocumentoDfe["detail"],
	documentKey: r.document_key as string,
	receivedAt: r.received_at as number,
});

/**
 * Registra o documento. Devolve false quando ele já estava registrado: pelo
 * NSU ou, sem NSU (consulta por chave), pelo arquivo.
 */
export async function inserirDocumento(db: D1Database, d: Omit<DocumentoDfe, "seq">): Promise<boolean> {
	if (d.nsu === null) {
		const igual = await db.prepare("SELECT 1 AS ok FROM dfe_documentos WHERE document_key = ? AND environment = ?").bind(d.documentKey, d.environment).first();
		if (igual) return false;
	}
	const res = await db
		.prepare(
			`INSERT OR IGNORE INTO dfe_documentos (doc_id, environment, nsu, schema, kind, access_key, event_type, event_seq, detail, document_key, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(d.docId, d.environment, d.nsu, d.schema, d.kind, d.accessKey, d.eventType, d.eventSeq, JSON.stringify(d.detail), d.documentKey, d.receivedAt)
		.run();
	return res.meta.changes > 0;
}

export async function listDocumentos(
	db: D1Database,
	filtro: { depois?: number; limite?: number; environment?: Ambiente; accessKey?: string; eventos?: boolean } = {},
): Promise<DocumentoDfe[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM dfe_documentos WHERE seq > ?1 AND (?2 IS NULL OR environment = ?2) AND (?3 IS NULL OR access_key = ?3)
			 AND (?4 = 0 OR kind IN ('evento', 'resumo_evento'))
			 ORDER BY seq LIMIT ?5`,
		)
		.bind(filtro.depois ?? 0, filtro.environment ?? null, filtro.accessKey ?? null, filtro.eventos ? 1 : 0, Math.min(Math.max(filtro.limite ?? 50, 1), 200))
		.all<Row>();
	return results.map(toDocumento);
}

/** O documento deste NSU já está no cofre? */
export async function temNsu(db: D1Database, c: Pick<Cursor, "docId" | "environment">, nsu: number): Promise<boolean> {
	return (await db.prepare("SELECT 1 AS ok FROM dfe_documentos WHERE doc_id = ? AND environment = ? AND nsu = ?").bind(c.docId, c.environment, nsu).first()) !== null;
}

/** O cofre já recebeu algum destes eventos para a nota? (O evento pode chegar antes da nota.) */
export async function temEvento(db: D1Database, environment: Ambiente, accessKey: string, tipos: Iterable<string>): Promise<boolean> {
	const lista = [...tipos];
	if (lista.length === 0) return false;
	const row = await db
		.prepare(`SELECT 1 AS ok FROM dfe_documentos WHERE environment = ? AND access_key = ? AND event_type IN (${lista.map(() => "?").join(", ")}) LIMIT 1`)
		.bind(environment, accessKey, ...lista)
		.first();
	return row !== null;
}

export async function getDocumento(db: D1Database, seq: number): Promise<DocumentoDfe | null> {
	const row = await db.prepare("SELECT * FROM dfe_documentos WHERE seq = ?").bind(seq).first<Row>();
	return row ? toDocumento(row) : null;
}

// ---------- NF-e recebidas ----------

export interface ManifestacaoRegistrada {
	tipo: Manifestacao;
	sequencia: number;
	/** Null quando o evento já estava no Ambiente Nacional (registrado fora do cofre). */
	protocolo: string | null;
	em: string;
	justificativa: string | null;
	documentKey: string | null;
	/** `agendador` na ciência automática; senão, quem pediu. */
	origem: string;
}

export interface Recebida {
	id: string;
	/** CNPJ do titular (ou da filial) a quem a nota interessa. */
	docId: string;
	environment: Ambiente;
	accessKey: string;
	/** Cresce a cada mudança da nota. */
	seq: number;
	role: "destinatario" | "terceiro";
	emitDoc: string | null;
	emitName: string | null;
	emitIe: string | null;
	issuedAt: string | null;
	operation: "entrada" | "saida" | null;
	value: number | null;
	situation: SituacaoRecebida | null;
	protocol: string | null;
	authorizedAt: string | null;
	summaryKey: string | null;
	xmlKey: string | null;
	extra: { manifestacoes?: ManifestacaoRegistrada[]; cienciaAutomatica?: { codigo: string; descricao: string } };
	createdAt: number;
	updatedAt: number;
}

const toRecebida = (r: Row): Recebida => ({
	id: r.id as string,
	docId: r.doc_id as string,
	environment: r.environment as Ambiente,
	accessKey: r.access_key as string,
	seq: r.seq as number,
	role: r.role as Recebida["role"],
	emitDoc: (r.emit_doc as string | null) ?? null,
	emitName: (r.emit_name as string | null) ?? null,
	emitIe: (r.emit_ie as string | null) ?? null,
	issuedAt: (r.issued_at as string | null) ?? null,
	operation: (r.operation as Recebida["operation"]) ?? null,
	value: (r.value as number | null) ?? null,
	situation: (r.situation as SituacaoRecebida | null) ?? null,
	protocol: (r.protocol as string | null) ?? null,
	authorizedAt: (r.authorized_at as string | null) ?? null,
	summaryKey: (r.summary_key as string | null) ?? null,
	xmlKey: (r.xml_key as string | null) ?? null,
	extra: JSON.parse((r.extra as string | null) ?? "{}") as Recebida["extra"],
	createdAt: r.created_at as number,
	updatedAt: r.updated_at as number,
});

const PROXIMA_SEQ = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM recebidas)";

export async function getRecebida(db: D1Database, id: string): Promise<Recebida | null> {
	const row = await db.prepare("SELECT * FROM recebidas WHERE id = ?").bind(id).first<Row>();
	return row ? toRecebida(row) : null;
}

export async function findRecebida(db: D1Database, environment: Ambiente, accessKey: string): Promise<Recebida | null> {
	const row = await db.prepare("SELECT * FROM recebidas WHERE environment = ? AND access_key = ?").bind(environment, accessKey).first<Row>();
	return row ? toRecebida(row) : null;
}

export type DadosDaRecebida = Partial<
	Pick<Recebida, "role" | "emitDoc" | "emitName" | "emitIe" | "issuedAt" | "operation" | "value" | "situation" | "protocol" | "authorizedAt" | "summaryKey" | "xmlKey" | "extra">
>;

const novoId = () => `rcb_${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * Cria a nota recebida ou junta os dados novos aos que já existem, e avança a
 * sequência de leitura. Dado ausente não apaga o que já se sabia, e a nota
 * cancelada ou denegada não volta a "autorizada" (o XML completo traz sempre o
 * protocolo de autorização, mesmo de nota cancelada depois).
 */
export async function salvarRecebida(
	db: D1Database,
	k: { docId: string; environment: Ambiente; accessKey: string },
	dados: DadosDaRecebida,
	agora = Date.now(),
): Promise<{ recebida: Recebida; nova: boolean }> {
	const atual = await findRecebida(db, k.environment, k.accessKey);
	const base: Recebida = atual ?? {
		id: novoId(), ...k, seq: 0, role: "destinatario", emitDoc: null, emitName: null, emitIe: null, issuedAt: null, operation: null,
		value: null, situation: null, protocol: null, authorizedAt: null, summaryKey: null, xmlKey: null, extra: {}, createdAt: agora, updatedAt: agora,
	};
	const n: Recebida = { ...base, updatedAt: agora };
	for (const [campo, valor] of Object.entries(dados) as [keyof DadosDaRecebida, unknown][]) {
		if (valor === null || valor === undefined) continue;
		if (campo === "situation" && base.situation && base.situation !== "autorizada") continue;
		(n as unknown as Record<string, unknown>)[campo] = valor;
	}
	if (atual) {
		await db
			.prepare(
				`UPDATE recebidas SET seq = ${PROXIMA_SEQ}, role = ?, emit_doc = ?, emit_name = ?, emit_ie = ?, issued_at = ?, operation = ?, value = ?,
				 situation = ?, protocol = ?, authorized_at = ?, summary_key = ?, xml_key = ?, extra = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(n.role, n.emitDoc, n.emitName, n.emitIe, n.issuedAt, n.operation, n.value, n.situation, n.protocol, n.authorizedAt, n.summaryKey, n.xmlKey, JSON.stringify(n.extra), n.updatedAt, n.id)
			.run();
	} else {
		await db
			.prepare(
				`INSERT INTO recebidas (id, doc_id, environment, access_key, seq, role, emit_doc, emit_name, emit_ie, issued_at, operation, value,
				 situation, protocol, authorized_at, summary_key, xml_key, extra, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ${PROXIMA_SEQ}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(n.id, n.docId, n.environment, n.accessKey, n.role, n.emitDoc, n.emitName, n.emitIe, n.issuedAt, n.operation, n.value, n.situation, n.protocol, n.authorizedAt, n.summaryKey, n.xmlKey, JSON.stringify(n.extra), n.createdAt, n.updatedAt)
			.run();
	}
	return { recebida: (await getRecebida(db, n.id)) as Recebida, nova: !atual };
}

/**
 * Notas na ordem da sequência de leitura (`depois` = última sequência que o
 * cliente já viu). Com `recentes`, as mais novas primeiro, para o painel.
 */
export async function listRecebidas(
	db: D1Database,
	filtro: { depois?: number; limite?: number; environment?: Ambiente; accessKey?: string; recentes?: boolean } = {},
): Promise<Recebida[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM recebidas WHERE seq > ?1 AND (?2 IS NULL OR environment = ?2) AND (?3 IS NULL OR access_key = ?3)
			 ORDER BY seq ${filtro.recentes ? "DESC" : "ASC"} LIMIT ?4`,
		)
		.bind(filtro.depois ?? 0, filtro.environment ?? null, filtro.accessKey ?? null, Math.min(Math.max(filtro.limite ?? 50, 1), 200))
		.all<Row>();
	return results.map(toRecebida);
}

export interface FiltroDeRecebidas {
	/** Período, pelo dia de emissão (AAAA-MM-DD), inclusive. */
	de?: string;
	ate?: string;
	environment?: Ambiente;
	situation?: SituacaoRecebida;
	/** `completo`: com o XML; `resumo`: só o resumo. */
	xml?: "completo" | "resumo";
	/** Chave de acesso, número da nota, ou parte do nome ou do CNPJ do emitente. */
	busca?: string;
}

// O dia de emissão vem com fuso (horário local do emitente); sem ele, vale o dia em que a nota chegou.
const DIA_DA_RECEBIDA = "COALESCE(substr(issued_at, 1, 10), date(created_at / 1000, 'unixepoch', '-3 hours'))";
const ONDE_RECEBIDAS = `(?1 IS NULL OR ${DIA_DA_RECEBIDA} >= ?1) AND (?2 IS NULL OR ${DIA_DA_RECEBIDA} <= ?2) AND (?3 IS NULL OR environment = ?3)
	AND (?4 IS NULL OR situation = ?4) AND (?5 IS NULL OR (?5 = 'completo' AND xml_key IS NOT NULL) OR (?5 = 'resumo' AND xml_key IS NULL))
	AND (?6 IS NULL OR access_key = ?6
	     OR (length(?6) <= 9 AND ?6 NOT GLOB '*[^0-9]*' AND CAST(substr(access_key, 26, 9) AS INTEGER) = CAST(?6 AS INTEGER))
	     OR emit_doc LIKE ?7 ESCAPE '\\' OR emit_name LIKE ?8 ESCAPE '\\')`;

function parametrosDeRecebidas(f: FiltroDeRecebidas): (string | null)[] {
	return [f.de ?? null, f.ate ?? null, f.environment ?? null, f.situation ?? null, f.xml ?? null, ...termosDeBusca(f.busca)];
}

/** Notas recebidas do filtro, da emissão mais recente para a mais antiga, com o total e a soma dos valores. */
export async function buscarRecebidas(
	db: D1Database,
	filtro: FiltroDeRecebidas,
	pagina: { limite: number; salto: number },
): Promise<{ itens: Recebida[]; total: number; valor: number; semXml: number }> {
	const p = parametrosDeRecebidas(filtro);
	const [lista, soma] = await Promise.all([
		db
			.prepare(`SELECT * FROM recebidas WHERE ${ONDE_RECEBIDAS} ORDER BY ${DIA_DA_RECEBIDA} DESC, seq DESC LIMIT ?9 OFFSET ?10`)
			.bind(...p, Math.min(Math.max(pagina.limite, 1), 200), Math.max(pagina.salto, 0))
			.all<Row>(),
		db
			.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v, COALESCE(SUM(CASE WHEN xml_key IS NULL THEN 1 ELSE 0 END), 0) AS s FROM recebidas WHERE ${ONDE_RECEBIDAS}`)
			.bind(...p)
			.first<{ n: number; v: number; s: number }>(),
	]);
	return { itens: lista.results.map(toRecebida), total: soma?.n ?? 0, valor: soma?.v ?? 0, semXml: soma?.s ?? 0 };
}

/**
 * Notas em que o titular é o destinatário, autorizadas a partir do dia `desde`
 * (AAAA-MM-DD), das quais o cofre só tem o resumo e ainda não há manifestação
 * nem tentativa de ciência automática.
 */
export async function listSemCiencia(db: D1Database, c: Cursor, desde: string, limite: number): Promise<Recebida[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM recebidas WHERE doc_id = ? AND environment = ? AND role = 'destinatario' AND situation = 'autorizada'
			 AND xml_key IS NULL AND summary_key IS NOT NULL AND substr(authorized_at, 1, 10) >= ?
			 AND json_extract(extra, '$.manifestacoes') IS NULL AND json_extract(extra, '$.cienciaAutomatica') IS NULL
			 ORDER BY seq LIMIT ?`,
		)
		.bind(c.docId, c.environment, desde, limite)
		.all<Row>();
	return results.map(toRecebida);
}

/** Quantas notas recebidas há em cada ambiente e quantas ainda estão só com o resumo. */
export async function contarRecebidas(db: D1Database): Promise<{ environment: Ambiente; total: number; semXml: number }[]> {
	const { results } = await db
		.prepare("SELECT environment, COUNT(*) AS total, SUM(CASE WHEN xml_key IS NULL THEN 1 ELSE 0 END) AS sem_xml FROM recebidas GROUP BY environment")
		.all<Row>();
	return results.map((r) => ({ environment: r.environment as Ambiente, total: r.total as number, semXml: (r.sem_xml as number | null) ?? 0 }));
}
