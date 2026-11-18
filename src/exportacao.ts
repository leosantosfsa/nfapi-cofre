// Exportação de XML por período, para mandar ao contador: um ZIP com os XML
// organizados em pastas e uma planilha de resumo.
//
// O Worker tem limite de operações por requisição, então nada é montado de uma
// vez. A exportação guarda no R2 só a lista dos arquivos e a planilha; o ZIP é
// escrito durante o download, em partes de até ARQUIVOS_POR_PARTE arquivos. A
// planilha precisa do resumo fiscal de cada nota, lido do XML: enquanto houver
// notas por ler, a exportação fica "preparando" e avança a cada consulta.

import type { AppEnv } from "./app";
import type { Ambiente } from "./fiscal/dados";
import type { ValoresFiscais } from "./fiscal/resumo";
import { type Aba, type Coluna, planilhaXlsx } from "./planilha";
import type { Tipo } from "./relatorios-schema";
import { type NotaEmitida, type NotaRecebida, type Periodo, completarFiscal, emitidasDoPeriodo, recebidasDoPeriodo } from "./relatorios";
import * as store from "./store";
import { type EntradaZip, zipStream } from "./zip";


/** A exportação e os arquivos dela somem depois deste prazo. */
export const VALIDADE_MS = 24 * 3_600_000;
/** Cada link de download vale por este tempo; consultar a exportação devolve links novos. */
export const VALIDADE_DO_LINK_MS = 30 * 60_000;
/** Cada arquivo é uma leitura no R2, e o Worker aceita um número limitado delas por requisição. */
export const ARQUIVOS_POR_PARTE = 400;

export interface Exportacao {
	id: string;
	environment: Ambiente;
	de: string;
	ate: string;
	incluir: Tipo[];
	status: "preparando" | "pronta";
	files: number;
	parts: number;
	/** Quantos arquivos de cada tipo entraram. */
	summary: Record<string, number>;
	actor: string;
	createdAt: number;
	expiresAt: number;
}

interface Entrada {
	/** Caminho dentro do ZIP. */
	caminho: string;
	/** Chave do documento no cofre. */
	chave: string;
}

type Row = Record<string, unknown>;
const pasta = (id: string) => `exportacoes/${id}`;
const nomeDe = (chave: string) => chave.split("/").pop() ?? chave;

const toExportacao = (r: Row): Exportacao => ({
	id: r.id as string,
	environment: r.environment as Ambiente,
	de: r.first_day as string,
	ate: r.last_day as string,
	incluir: JSON.parse(r.include as string) as Tipo[],
	status: r.status as Exportacao["status"],
	files: r.files as number,
	parts: r.parts as number,
	summary: JSON.parse((r.summary as string | null) ?? "{}") as Record<string, number>,
	actor: r.actor as string,
	createdAt: r.created_at as number,
	expiresAt: r.expires_at as number,
});

export async function getExportacao(db: D1Database, id: string, agora = Date.now()): Promise<Exportacao | null> {
	const row = await db.prepare("SELECT * FROM exportacoes WHERE id = ? AND expires_at > ?").bind(id, agora).first<Row>();
	return row ? toExportacao(row) : null;
}

export async function listExportacoes(db: D1Database, agora = Date.now()): Promise<Exportacao[]> {
	const { results } = await db.prepare("SELECT * FROM exportacoes WHERE expires_at > ? ORDER BY created_at DESC LIMIT 20").bind(agora).all<Row>();
	return results.map(toExportacao);
}

/** Apaga as exportações vencidas e os arquivos delas. */
async function limparVencidas(env: AppEnv, agora: number): Promise<void> {
	const { results } = await env.DB.prepare("SELECT id FROM exportacoes WHERE expires_at <= ? LIMIT 20").bind(agora).all<{ id: string }>();
	for (const { id } of results) {
		await env.DOCS.delete([`${pasta(id)}/manifesto.json`, `${pasta(id)}/resumo.xlsx`]);
		await env.DB.prepare("DELETE FROM exportacoes WHERE id = ?").bind(id).run();
	}
}

export async function criarExportacao(
	env: AppEnv,
	pedido: { environment: Ambiente; de: string; ate: string; incluir: Tipo[] },
	actor: string,
	agora = Date.now(),
): Promise<{ exportacao: Exportacao; notasPorLer: number }> {
	await limparVencidas(env, agora);
	const id = `exp_${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	await env.DB
		.prepare("INSERT INTO exportacoes (id, environment, first_day, last_day, include, status, actor, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'preparando', ?, ?, ?)")
		.bind(id, pedido.environment, pedido.de, pedido.ate, JSON.stringify(pedido.incluir), actor, agora, agora + VALIDADE_MS)
		.run();
	return avancarExportacao(env, (await getExportacao(env.DB, id, agora)) as Exportacao);
}

// ---------- Planilha ----------

const NOMES = { nfse: "NFS-e", nfe: "NF-e", nfce: "NFC-e" } as const;
const SITUACOES: Record<string, string> = {
	autorizada: "Autorizada", cancelada: "Cancelada", rejeitada: "Rejeitada", denegada: "Denegada", contingencia: "Em contingência",
	indefinida: "Sem resposta", processando: "Em andamento", erro: "Não enviada",
};
const MANIFESTACOES: Record<string, string> = {
	ciencia: "Ciência da operação", confirmacao: "Confirmação da operação", desconhecimento: "Desconhecimento da operação", nao_realizada: "Operação não realizada",
};

/** Data e hora como estão na nota (horário local do emitente); as datas em UTC valem por Brasília. */
function dataHora(iso: string | null): string {
	if (!iso) return "";
	const local = iso.endsWith("Z") ? new Date(Date.parse(iso) - 3 * 3_600_000).toISOString() : iso;
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
	return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : iso;
}

const IMPOSTOS: { campo: keyof ValoresFiscais; titulo: string }[] = [
	{ campo: "produtos", titulo: "Produtos" }, { campo: "servicos", titulo: "Serviços" }, { campo: "desconto", titulo: "Desconto" }, { campo: "frete", titulo: "Frete" },
	{ campo: "icms", titulo: "ICMS" }, { campo: "icmsSt", titulo: "ICMS ST" }, { campo: "fcp", titulo: "FCP" }, { campo: "ipi", titulo: "IPI" },
	{ campo: "pis", titulo: "PIS" }, { campo: "cofins", titulo: "COFINS" }, { campo: "ii", titulo: "II" }, { campo: "iss", titulo: "ISS" },
	{ campo: "ibs", titulo: "IBS" }, { campo: "cbs", titulo: "CBS" }, { campo: "is", titulo: "IS" },
];
const colunasDeImpostos: Coluna[] = IMPOSTOS.map((i) => ({ titulo: i.titulo, tipo: "valor", largura: 12 }));
const impostosDe = (fiscal: NotaEmitida["fiscal"]) => IMPOSTOS.map((i) => fiscal?.valores?.[i.campo] ?? null);
const cfopsDe = (fiscal: NotaEmitida["fiscal"]) => (fiscal?.cfops ?? []).map((c) => c.cfop).join(", ");

function abaDeEmitidas(notas: NotaEmitida[]): Aba {
	return {
		nome: "Emitidas",
		colunas: [
			{ titulo: "Documento", tipo: "texto", largura: 11 }, { titulo: "Série", tipo: "texto", largura: 8 }, { titulo: "Número", tipo: "texto", largura: 10 },
			{ titulo: "Chave de acesso", tipo: "texto", largura: 48 }, { titulo: "Emissão", tipo: "texto", largura: 17 }, { titulo: "Situação", tipo: "texto", largura: 15 },
			{ titulo: "Destinatário", tipo: "texto", largura: 36 }, { titulo: "CPF/CNPJ", tipo: "texto", largura: 17 }, { titulo: "UF", tipo: "texto", largura: 5 },
			{ titulo: "Natureza", tipo: "texto", largura: 28 }, { titulo: "CFOP", tipo: "texto", largura: 12 }, { titulo: "Valor total", tipo: "valor", largura: 14 },
			...colunasDeImpostos,
			{ titulo: "Protocolo", tipo: "texto", largura: 18 }, { titulo: "Referência", tipo: "texto", largura: 18 },
		],
		linhas: notas.map((n) => [
			NOMES[n.kind], n.serie, n.kind === "nfse" ? (n.fiscalNumber ?? "") : String(n.number), n.accessKey, dataHora(n.issuedAt), SITUACOES[n.status] ?? n.status,
			n.recipientName, n.recipientDoc, n.fiscal?.destinatario?.uf ?? null, n.fiscal?.natureza ?? null, cfopsDe(n.fiscal), n.value,
			...impostosDe(n.fiscal),
			n.protocol, n.reference,
		]),
	};
}

function abaDeRecebidas(notas: NotaRecebida[]): Aba {
	return {
		nome: "Recebidas",
		colunas: [
			{ titulo: "Série", tipo: "texto", largura: 8 }, { titulo: "Número", tipo: "texto", largura: 10 }, { titulo: "Chave de acesso", tipo: "texto", largura: 48 },
			{ titulo: "Emissão", tipo: "texto", largura: 17 }, { titulo: "Situação", tipo: "texto", largura: 13 }, { titulo: "Emitente", tipo: "texto", largura: 36 },
			{ titulo: "CNPJ", tipo: "texto", largura: 17 }, { titulo: "Papel da empresa", tipo: "texto", largura: 16 }, { titulo: "Manifestação", tipo: "texto", largura: 28 },
			{ titulo: "Arquivo", tipo: "texto", largura: 14 }, { titulo: "Natureza", tipo: "texto", largura: 28 }, { titulo: "CFOP", tipo: "texto", largura: 12 },
			{ titulo: "Valor total", tipo: "valor", largura: 14 },
			...colunasDeImpostos,
			{ titulo: "Protocolo", tipo: "texto", largura: 18 },
		],
		linhas: notas.map((n) => {
			const ultima = n.manifestacoes[n.manifestacoes.length - 1];
			return [
				String(Number(n.accessKey.slice(22, 25))), String(Number(n.accessKey.slice(25, 34))), n.accessKey, dataHora(n.issuedAt), SITUACOES[n.situation ?? ""] ?? n.situation,
				n.emitName, n.emitDoc ?? n.accessKey.slice(6, 20), n.role === "terceiro" ? "Terceiro" : "Destinatária", ultima ? (MANIFESTACOES[ultima.tipo] ?? ultima.tipo) : null,
				n.xmlKey ? "XML completo" : "Só o resumo", n.fiscal?.natureza ?? null, cfopsDe(n.fiscal), n.value,
				...impostosDe(n.fiscal),
				n.protocol,
			];
		}),
	};
}

// ---------- Lista dos arquivos ----------

const COM_XML = new Set(["autorizada", "cancelada", "denegada"]);
const EVENTOS = new Set(["cancelamento", "carta_correcao"]);

async function montar(env: AppEnv, exp: Exportacao): Promise<{ entradas: Entrada[]; contagem: Record<string, number>; planilha: Uint8Array }> {
	const p: Periodo = { de: exp.de, ate: exp.ate, environment: exp.environment };
	const quer = (t: Tipo) => exp.incluir.includes(t);
	const entradas: Entrada[] = [];
	const contagem: Record<string, number> = {};
	const contar = (tipo: string) => {
		contagem[tipo] = (contagem[tipo] ?? 0) + 1;
	};
	// Os arquivos de uma nota nascem na emissão ou depois dela.
	const desde = Date.parse(`${exp.de}T00:00:00-03:00`) - 2 * 86_400_000;

	const emitidas = (await emitidasDoPeriodo(env.DB, p)).filter((n) => quer(n.kind));
	const porChave = new Map<string, NotaEmitida>();
	for (const n of emitidas) if (n.accessKey && COM_XML.has(n.status)) porChave.set(n.accessKey, n);
	for (let salto = 0; porChave.size > 0; salto += 2000) {
		const { results } = await env.DB
			.prepare(
				`SELECT key, meta FROM documents WHERE (key LIKE 'nfse/%' OR key LIKE 'nfe/%' OR key LIKE 'nfce/%') AND created_at >= ?
				 ORDER BY created_at, key LIMIT 2000 OFFSET ?`,
			)
			.bind(desde, salto)
			.all<{ key: string; meta: string }>();
		for (const d of results) {
			const meta = JSON.parse(d.meta) as { tipo?: string; chaveAcesso?: string };
			const nota = meta.chaveAcesso ? porChave.get(meta.chaveAcesso) : undefined;
			if (!nota || !meta.tipo || meta.tipo === "enviada") continue;
			if (meta.tipo === nota.kind) {
				entradas.push({ caminho: `emitidas/${nota.kind}/${nomeDe(d.key)}`, chave: d.key });
				contar(nota.kind);
			} else if (meta.tipo === "dps") {
				entradas.push({ caminho: `emitidas/nfse/dps/${nomeDe(d.key)}`, chave: d.key });
			} else if (EVENTOS.has(meta.tipo) && quer("eventos")) {
				entradas.push({ caminho: `emitidas/${nota.kind}/eventos/${nomeDe(d.key)}`, chave: d.key });
				contar("eventos");
			}
		}
		if (results.length < 2000) break;
	}

	if (quer("inutilizacoes")) {
		const { results } = await env.DB
			.prepare(
				`SELECT document_key FROM inutilizacoes WHERE environment = ? AND document_key IS NOT NULL
				 AND date(created_at / 1000, 'unixepoch', '-3 hours') >= ? AND date(created_at / 1000, 'unixepoch', '-3 hours') <= ? ORDER BY created_at`,
			)
			.bind(exp.environment, exp.de, exp.ate)
			.all<{ document_key: string }>();
		for (const i of results) {
			entradas.push({ caminho: `inutilizacoes/${nomeDe(i.document_key)}`, chave: i.document_key });
			contar("inutilizacoes");
		}
	}

	const recebidas = quer("recebidas") ? await recebidasDoPeriodo(env.DB, p) : [];
	const chavesRecebidas = new Set<string>();
	for (const n of recebidas) {
		chavesRecebidas.add(n.accessKey);
		if (n.xmlKey) entradas.push({ caminho: `recebidas/${n.accessKey}-nfe.xml`, chave: n.xmlKey });
		else if (n.summaryKey) entradas.push({ caminho: `recebidas/resumos/${n.accessKey}-resumo.xml`, chave: n.summaryKey });
		else continue;
		contar("recebidas");
		for (const m of n.manifestacoes) {
			if (!m.documentKey) continue;
			entradas.push({ caminho: `recebidas/manifestacoes/${n.accessKey}-${nomeDe(m.documentKey)}`, chave: m.documentKey });
			contar("manifestacoes");
		}
	}
	for (let salto = 0; chavesRecebidas.size > 0 && quer("eventos"); salto += 2000) {
		const { results } = await env.DB
			.prepare("SELECT access_key, document_key FROM dfe_documentos WHERE environment = ? AND kind = 'evento' AND access_key IS NOT NULL AND received_at >= ? ORDER BY seq LIMIT 2000 OFFSET ?")
			.bind(exp.environment, desde, salto)
			.all<{ access_key: string; document_key: string }>();
		for (const d of results) {
			if (!chavesRecebidas.has(d.access_key)) continue;
			entradas.push({ caminho: `recebidas/eventos/${d.access_key}-${nomeDe(d.document_key)}`, chave: d.document_key });
			contar("eventosRecebidos");
		}
		if (results.length < 2000) break;
	}

	const abas = [...(emitidas.length > 0 || exp.incluir.some((t) => t === "nfse" || t === "nfe" || t === "nfce") ? [abaDeEmitidas(emitidas)] : []), ...(quer("recebidas") ? [abaDeRecebidas(recebidas)] : [])];
	const planilha = await planilhaXlsx(abas.length > 0 ? abas : [abaDeEmitidas([])], new Date(exp.createdAt));
	return { entradas, contagem, planilha };
}

/**
 * Leva a exportação adiante: lê os XML que faltam para a planilha e, quando não
 * falta nenhum, grava a lista dos arquivos e a planilha. Chamar de novo enquanto
 * a situação for "preparando".
 */
export async function avancarExportacao(env: AppEnv, exp: Exportacao): Promise<{ exportacao: Exportacao; notasPorLer: number }> {
	if (exp.status === "pronta") return { exportacao: exp, notasPorLer: 0 };
	const notasPorLer = await completarFiscal(env, { de: exp.de, ate: exp.ate, environment: exp.environment }, 200);
	if (notasPorLer > 0) return { exportacao: exp, notasPorLer };

	const { entradas, contagem, planilha } = await montar(env, exp);
	await env.DOCS.put(`${pasta(exp.id)}/manifesto.json`, JSON.stringify(entradas), { httpMetadata: { contentType: "application/json" } });
	await env.DOCS.put(`${pasta(exp.id)}/resumo.xlsx`, planilha, { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
	const parts = Math.ceil(entradas.length / ARQUIVOS_POR_PARTE);
	await env.DB.prepare("UPDATE exportacoes SET status = 'pronta', files = ?, parts = ?, summary = ? WHERE id = ?").bind(entradas.length, parts, JSON.stringify(contagem), exp.id).run();
	return { exportacao: { ...exp, status: "pronta", files: entradas.length, parts, summary: contagem }, notasPorLer: 0 };
}

// ---------- Download ----------

/** Nome do arquivo de uma parte, como "notas-2026-11-01-a-2026-11-30-parte-1-de-2.zip". */
export function nomeDaParte(exp: Exportacao, parte: number): string {
	return `notas-${exp.de}-a-${exp.ate}${exp.parts > 1 ? `-parte-${parte}-de-${exp.parts}` : ""}.zip`;
}
export const nomeDaPlanilha = (exp: Exportacao) => `resumo-${exp.de}-a-${exp.ate}.xlsx`;

export async function lerPlanilha(env: AppEnv, exp: Exportacao): Promise<R2ObjectBody | null> {
	return env.DOCS.get(`${pasta(exp.id)}/resumo.xlsx`);
}

/** O ZIP de uma parte, escrito enquanto é enviado; null se a parte não existe. A planilha vai na primeira. */
export async function zipDaParte(env: AppEnv, exp: Exportacao, parte: number): Promise<ReadableStream<Uint8Array> | null> {
	if (exp.status !== "pronta" || !Number.isInteger(parte) || parte < 1 || parte > exp.parts) return null;
	const manifesto = await env.DOCS.get(`${pasta(exp.id)}/manifesto.json`);
	if (!manifesto) return null;
	const entradas = ((await manifesto.json()) as Entrada[]).slice((parte - 1) * ARQUIVOS_POR_PARTE, parte * ARQUIVOS_POR_PARTE);
	const arquivos: EntradaZip[] = entradas.map((e) => ({
		nome: e.caminho,
		dados: async () => {
			const objeto = await store.getDocument(env.DOCS, e.chave);
			return objeto ? new Uint8Array(await objeto.arrayBuffer()) : null;
		},
	}));
	if (parte === 1) {
		arquivos.unshift({
			nome: nomeDaPlanilha(exp),
			dados: async () => {
				const objeto = await lerPlanilha(env, exp);
				return objeto ? new Uint8Array(await objeto.arrayBuffer()) : null;
			},
		});
	}
	return zipStream(arquivos, new Date(exp.createdAt));
}

// ---------- Links assinados ----------

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function chaveDeAssinatura(segredo: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(`nfapi-exportacao:${segredo}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const mensagem = (id: string, arquivo: string, expira: number) => new TextEncoder().encode(`${id}|${arquivo}|${expira}`);

/** Endereço de download de um arquivo da exportação (`parte-1`, `planilha`), válido até `expira`. */
export async function linkAssinado(segredo: string, origem: string, id: string, arquivo: string, expira: number): Promise<string> {
	const assinatura = hex(await crypto.subtle.sign("HMAC", await chaveDeAssinatura(segredo), mensagem(id, arquivo, expira)));
	return `${origem}/exportacoes/${id}/${arquivo}?expira=${expira}&assinatura=${assinatura}`;
}

export async function assinaturaValida(segredo: string, id: string, arquivo: string, expira: number, assinatura: string, agora = Date.now()): Promise<boolean> {
	if (!Number.isFinite(expira) || expira <= agora || !/^[0-9a-f]{64}$/.test(assinatura)) return false;
	const bytes = new Uint8Array((assinatura.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));
	return crypto.subtle.verify("HMAC", await chaveDeAssinatura(segredo), bytes, mensagem(id, arquivo, expira));
}
