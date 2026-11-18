// Relatórios por período: totais por situação, por dia, por CFOP, por natureza
// e por destinatário ou emitente, com a soma dos impostos.
//
// Os impostos de cada nota vêm do XML arquivado. O cofre os lê uma vez e guarda
// o resumo; enquanto houver notas do período ainda não lidas, o relatório
// informa quantas faltam e os totais de impostos estão incompletos.

import type { AppEnv } from "./app";
import type { EmissionStatus, Kind } from "./emissao/banco";
import type { Ambiente } from "./fiscal/dados";
import { type ResumoFiscal, VALORES_ZERADOS, type ValoresFiscais, resumoFiscal, somarValores } from "./fiscal/resumo";
import * as store from "./store";

type Row = Record<string, unknown>;

export interface Periodo {
	de: string;
	ate: string;
	environment: Ambiente;
}

const DIA_DA_RECEBIDA = "COALESCE(substr(issued_at, 1, 10), date(created_at / 1000, 'unixepoch', '-3 hours'))";
/** Situações em que há um XML fiscal arquivado. */
const COM_XML = "status IN ('autorizada', 'cancelada', 'denegada')";

const lerFiscal = (v: unknown): Partial<ResumoFiscal> | null => {
	if (typeof v !== "string") return null;
	try {
		return JSON.parse(v) as Partial<ResumoFiscal>;
	} catch {
		return {};
	}
};

// ---------- Leitura dos XML ----------

/**
 * Lê o resumo fiscal das notas do período que ainda não o têm, até `limite`
 * arquivos nesta chamada. Devolve quantas ficaram para a próxima.
 */
export async function completarFiscal(env: AppEnv, p: Periodo, limite = 150): Promise<number> {
	const ler = async (chave: string | null) => {
		const objeto = chave ? await store.getDocument(env.DOCS, chave) : null;
		// '{}' marca a nota como lida mesmo sem XML, para não ser tentada a cada relatório.
		return JSON.stringify((objeto ? resumoFiscal(await objeto.text()) : null) ?? {});
	};
	const emitidas = await env.DB
		.prepare(`SELECT id, document_key FROM emissions WHERE fiscal IS NULL AND ${COM_XML} AND environment = ? AND issued_day >= ? AND issued_day <= ? LIMIT ?`)
		.bind(p.environment, p.de, p.ate, limite)
		.all<{ id: string; document_key: string | null }>();
	for (const e of emitidas.results) await env.DB.prepare("UPDATE emissions SET fiscal = ? WHERE id = ?").bind(await ler(e.document_key), e.id).run();

	const resto = limite - emitidas.results.length;
	if (resto > 0) {
		const recebidas = await env.DB
			.prepare(`SELECT id, xml_key FROM recebidas WHERE fiscal IS NULL AND xml_key IS NOT NULL AND environment = ? AND ${DIA_DA_RECEBIDA} >= ? AND ${DIA_DA_RECEBIDA} <= ? LIMIT ?`)
			.bind(p.environment, p.de, p.ate, resto)
			.all<{ id: string; xml_key: string }>();
		for (const r of recebidas.results) await env.DB.prepare("UPDATE recebidas SET fiscal = ? WHERE id = ?").bind(await ler(r.xml_key), r.id).run();
	}

	const falta = await env.DB
		.prepare(
			`SELECT (SELECT COUNT(*) FROM emissions WHERE fiscal IS NULL AND ${COM_XML} AND environment = ?1 AND issued_day >= ?2 AND issued_day <= ?3)
			      + (SELECT COUNT(*) FROM recebidas WHERE fiscal IS NULL AND xml_key IS NOT NULL AND environment = ?1 AND ${DIA_DA_RECEBIDA} >= ?2 AND ${DIA_DA_RECEBIDA} <= ?3) AS n`,
		)
		.bind(p.environment, p.de, p.ate)
		.first<{ n: number }>();
	return falta?.n ?? 0;
}

// ---------- Leitura das notas do período ----------

export interface NotaEmitida {
	id: string;
	kind: Kind;
	status: EmissionStatus;
	serie: string;
	number: number;
	fiscalNumber: string | null;
	accessKey: string | null;
	protocol: string | null;
	reference: string | null;
	issuedAt: string | null;
	issuedDay: string;
	value: number | null;
	recipientDoc: string | null;
	recipientName: string | null;
	documentKey: string | null;
	fiscal: Partial<ResumoFiscal> | null;
}

/** Todas as notas emitidas do período, em ordem de emissão. */
export async function emitidasDoPeriodo(db: D1Database, p: Periodo): Promise<NotaEmitida[]> {
	const saida: NotaEmitida[] = [];
	for (let salto = 0; ; salto += 1000) {
		const { results } = await db
			.prepare(
				`SELECT id, kind, status, serie, number, fiscal_number, access_key, protocol, reference, issued_at, issued_day, value, recipient_doc, recipient_name, document_key, fiscal
				 FROM emissions WHERE environment = ? AND issued_day >= ? AND issued_day <= ? ORDER BY issued_day, created_at, rowid LIMIT 1000 OFFSET ?`,
			)
			.bind(p.environment, p.de, p.ate, salto)
			.all<Row>();
		for (const r of results) {
			saida.push({
				id: r.id as string, kind: r.kind as Kind, status: r.status as EmissionStatus, serie: r.serie as string, number: r.number as number,
				fiscalNumber: (r.fiscal_number as string | null) ?? null, accessKey: (r.access_key as string | null) ?? null, protocol: (r.protocol as string | null) ?? null,
				reference: (r.reference as string | null) ?? null, issuedAt: (r.issued_at as string | null) ?? null, issuedDay: r.issued_day as string,
				value: (r.value as number | null) ?? null, recipientDoc: (r.recipient_doc as string | null) ?? null, recipientName: (r.recipient_name as string | null) ?? null,
				documentKey: (r.document_key as string | null) ?? null, fiscal: lerFiscal(r.fiscal),
			});
		}
		if (results.length < 1000) return saida;
	}
}

export interface NotaRecebida {
	id: string;
	accessKey: string;
	role: "destinatario" | "terceiro";
	situation: string | null;
	issuedAt: string | null;
	day: string;
	value: number | null;
	emitDoc: string | null;
	emitName: string | null;
	protocol: string | null;
	summaryKey: string | null;
	xmlKey: string | null;
	manifestacoes: { tipo: string; documentKey: string | null }[];
	fiscal: Partial<ResumoFiscal> | null;
}

/** Todas as notas recebidas do período, em ordem de emissão. */
export async function recebidasDoPeriodo(db: D1Database, p: Periodo): Promise<NotaRecebida[]> {
	const saida: NotaRecebida[] = [];
	for (let salto = 0; ; salto += 1000) {
		const { results } = await db
			.prepare(
				`SELECT id, access_key, role, situation, issued_at, ${DIA_DA_RECEBIDA} AS dia, value, emit_doc, emit_name, protocol, summary_key, xml_key, extra, fiscal
				 FROM recebidas WHERE environment = ? AND ${DIA_DA_RECEBIDA} >= ? AND ${DIA_DA_RECEBIDA} <= ? ORDER BY dia, seq LIMIT 1000 OFFSET ?`,
			)
			.bind(p.environment, p.de, p.ate, salto)
			.all<Row>();
		for (const r of results) {
			const extra = JSON.parse((r.extra as string | null) ?? "{}") as { manifestacoes?: { tipo: string; documentKey: string | null }[] };
			saida.push({
				id: r.id as string, accessKey: r.access_key as string, role: r.role as NotaRecebida["role"], situation: (r.situation as string | null) ?? null,
				issuedAt: (r.issued_at as string | null) ?? null, day: r.dia as string, value: (r.value as number | null) ?? null,
				emitDoc: (r.emit_doc as string | null) ?? null, emitName: (r.emit_name as string | null) ?? null, protocol: (r.protocol as string | null) ?? null,
				summaryKey: (r.summary_key as string | null) ?? null, xmlKey: (r.xml_key as string | null) ?? null, manifestacoes: extra.manifestacoes ?? [], fiscal: lerFiscal(r.fiscal),
			});
		}
		if (results.length < 1000) return saida;
	}
}

// ---------- Relatório ----------

interface Fatia {
	quantidade: number;
	valor: number;
}
const centavos = (v: number) => Math.round(v * 100) / 100;

class Grupos<T extends object> {
	private readonly mapa = new Map<string, T & Fatia>();
	somar(chave: string, dados: T, valor: number) {
		const atual = this.mapa.get(chave) ?? { ...dados, quantidade: 0, valor: 0 };
		atual.quantidade++;
		atual.valor = centavos(atual.valor + valor);
		this.mapa.set(chave, atual);
	}
	/** Do maior valor para o menor; `limite` corta a lista. */
	lista(limite?: number): (T & Fatia)[] {
		const ordenada = [...this.mapa.values()].sort((a, b) => b.valor - a.valor || b.quantidade - a.quantidade);
		return limite ? ordenada.slice(0, limite) : ordenada;
	}
}

/** Soma os CFOP de uma nota: a quantidade conta notas, o valor soma os itens. */
function somarCfops(grupos: Grupos<{ cfop: string }>, fiscal: Partial<ResumoFiscal> | null) {
	for (const c of fiscal?.cfops ?? []) grupos.somar(c.cfop, { cfop: c.cfop }, c.valor);
}

const MAIORES = 50;

export async function relatorio(env: AppEnv, p: Periodo) {
	const pendentes = await completarFiscal(env, p);
	const [emitidas, recebidas] = await Promise.all([emitidasDoPeriodo(env.DB, p), recebidasDoPeriodo(env.DB, p)]);

	const porSituacao = new Grupos<{ modelo: Kind; situacao: EmissionStatus }>();
	const porDia = new Grupos<{ dia: string }>();
	const porCfop = new Grupos<{ cfop: string }>();
	const porNatureza = new Grupos<{ natureza: string }>();
	const porDestinatario = new Grupos<{ documento: string | null; nome: string | null }>();
	let impostos: ValoresFiscais = { ...VALORES_ZERADOS };
	let autorizadas = 0;
	let valorAutorizado = 0;
	for (const n of emitidas) {
		porSituacao.somar(`${n.kind}:${n.status}`, { modelo: n.kind, situacao: n.status }, n.value ?? 0);
		// Só a nota autorizada entra nos totais fiscais: a cancelada e a recusada não geram imposto.
		if (n.status !== "autorizada") continue;
		autorizadas++;
		valorAutorizado = centavos(valorAutorizado + (n.value ?? 0));
		porDia.somar(n.issuedDay, { dia: n.issuedDay }, n.value ?? 0);
		impostos = somarValores(impostos, n.fiscal?.valores);
		somarCfops(porCfop, n.fiscal);
		porNatureza.somar(n.fiscal?.natureza ?? "Não informada", { natureza: n.fiscal?.natureza ?? "Não informada" }, n.value ?? 0);
		porDestinatario.somar(n.recipientDoc ?? n.recipientName ?? "", { documento: n.recipientDoc, nome: n.recipientName }, n.value ?? 0);
	}

	const recebidasPorSituacao = new Grupos<{ situacao: string }>();
	const porEmitente = new Grupos<{ documento: string | null; nome: string | null }>();
	const cfopsRecebidos = new Grupos<{ cfop: string }>();
	let impostosRecebidos: ValoresFiscais = { ...VALORES_ZERADOS };
	const validas = { quantidade: 0, valor: 0, comXml: 0, comoTerceiro: 0 };
	for (const n of recebidas) {
		// As notas em que a empresa é só transportadora ou autorizada não são compras dela.
		if (n.role === "terceiro") {
			validas.comoTerceiro++;
			continue;
		}
		recebidasPorSituacao.somar(n.situation ?? "desconhecida", { situacao: n.situation ?? "desconhecida" }, n.value ?? 0);
		if (n.situation !== "autorizada") continue;
		validas.quantidade++;
		validas.valor = centavos(validas.valor + (n.value ?? 0));
		if (n.xmlKey) validas.comXml++;
		impostosRecebidos = somarValores(impostosRecebidos, n.fiscal?.valores);
		somarCfops(cfopsRecebidos, n.fiscal);
		porEmitente.somar(n.emitDoc ?? "", { documento: n.emitDoc, nome: n.emitName }, n.value ?? 0);
	}

	return {
		ambiente: p.environment,
		periodo: { de: p.de, ate: p.ate },
		/** Notas do período cujo XML o cofre ainda não leu: enquanto não for zero, os totais de impostos, CFOP e natureza estão incompletos. Peça de novo. */
		notasPorLer: pendentes,
		emitidas: {
			porSituacao: porSituacao.lista(),
			autorizadas: { quantidade: autorizadas, valor: valorAutorizado, impostos },
			porDia: porDia.lista().sort((a, b) => a.dia.localeCompare(b.dia)),
			porCfop: porCfop.lista(),
			porNatureza: porNatureza.lista(),
			porDestinatario: porDestinatario.lista(MAIORES),
		},
		recebidas: {
			porSituacao: recebidasPorSituacao.lista(),
			/** Só as autorizadas em que a empresa é a destinatária. Os impostos somam apenas as que já têm o XML completo (`comXml`). */
			autorizadas: { quantidade: validas.quantidade, valor: validas.valor, comXml: validas.comXml, impostos: impostosRecebidos },
			comoTerceiro: validas.comoTerceiro,
			porCfop: cfopsRecebidos.lista(),
			porEmitente: porEmitente.lista(MAIORES),
		},
	};
}
