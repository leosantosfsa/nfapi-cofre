// Trabalho periódico do cofre (Cron Trigger, a cada 5 minutos):
//
//   - quando há NFC-e em contingência, confere se a SEFAZ voltou e transmite a fila;
//   - quando a consulta automática das notas recebidas está ligada e a espera
//     exigida pelo Ambiente Nacional já venceu, baixa o que chegou e, se o
//     emitente pediu, registra a ciência da operação das notas novas;
//   - quando uma consulta deixou documentos para trás (outro sistema consultou o
//     mesmo CNPJ na frente), busca-os um a um, mesmo com a consulta automática
//     desligada.
//
// Sem pendência, não faz nada: nem abre o certificado, nem acorda o Container.

import type { AppEnv } from "./app";
import { secretIsStrong } from "./crypto";
import * as banco from "./emissao/banco";
import { type ResumoPendencias, processarPendencias } from "./emissao/nfe";
import { OperacaoError, type Operacoes, abrirOperacoes } from "./operacoes";
import * as recebidas from "./recebidas/banco";
import { darCienciaAutomatica, haCienciaPendente, podeRecuperar, sincronizar } from "./recebidas/servico";
import * as store from "./store";
import type { Transport } from "./transport";

export interface ResumoRecebidas {
	documentos: number;
	notasNovas: number;
	cienciasRegistradas: number;
}

export interface ResumoAgendado {
	/** Null quando não havia nota em contingência. */
	contingencia: ResumoPendencias | null;
	/** Null quando nenhuma consulta automática estava na hora. */
	recebidas: ResumoRecebidas | null;
}

/** Consulta automática das notas recebidas, para cada CNPJ e ambiente que a ligou. */
async function processarRecebidas(env: AppEnv, ops: Operacoes, cursores: recebidas.Cursor[], agora: number): Promise<ResumoRecebidas> {
	const resumo = { documentos: 0, notasNovas: 0, cienciasRegistradas: 0 };
	for (const cursor of cursores) {
		if (cursor.nextAt <= agora) {
			// Com a consulta automática desligada, o agendador só termina de buscar o que uma
			// consulta pedida deixou para trás (NSU pulados); não consulta a sequência.
			const r = await sincronizar(env.DB, ops, cursor, { agora, soRecuperar: !cursor.auto });
			if (!("ok" in r) && r.consultou) {
				resumo.documentos += r.documentos;
				resumo.notasNovas += r.notasNovas;
			}
		}
		if (cursor.auto && cursor.autoCiencia) {
			const c = await darCienciaAutomatica(env.DB, ops, cursor, 10, agora);
			if (!("ok" in c)) resumo.cienciasRegistradas += c.registradas;
		}
	}
	return resumo;
}

export async function executarAgendado(env: AppEnv, transport: Transport, agora = Date.now()): Promise<ResumoAgendado | null> {
	if (!secretIsStrong(env.VAULT_SECRET)) return null;
	const [pendentes, estados, cursores] = await Promise.all([
		banco.listPendentesDeContingencia(env.DB, 1),
		store.listSettingKeys(env.DB, "contingencia_nfce_"),
		recebidas.listCursores(env.DB),
	]);
	const haContingencia = pendentes.length > 0 || estados.length > 0;
	// Entram os que estão na hora de consultar e os que ainda têm ciência automática por
	// registrar (há um limite por execução, então pode sobrar da anterior).
	const automaticos: recebidas.Cursor[] = [];
	for (const c of cursores) {
		if (c.auto ? c.nextAt <= agora || (c.autoCiencia && (await haCienciaPendente(env.DB, c, agora))) : c.nextAt <= agora && podeRecuperar(c, agora)) automaticos.push(c);
	}
	if (!haContingencia && automaticos.length === 0) return null;
	try {
		const ops = await abrirOperacoes(env, transport, "agendador");
		const resumo: ResumoAgendado = { contingencia: null, recebidas: null };
		if (haContingencia) {
			resumo.contingencia = await processarPendencias(env.DB, ops);
			await store.audit(env.DB, { action: "contingencia.processar", actor: "agendador", outcome: "ok", detail: { ...resumo.contingencia } });
		}
		if (automaticos.length > 0) {
			resumo.recebidas = await processarRecebidas(env, ops, automaticos, agora);
			// Só fica no histórico a execução que trouxe ou registrou alguma coisa.
			if (resumo.recebidas.documentos > 0 || resumo.recebidas.cienciasRegistradas > 0) {
				await store.audit(env.DB, { action: "distribuicao.consultar", actor: "agendador", outcome: "ok", detail: { ...resumo.recebidas } });
			}
		}
		return resumo;
	} catch (err) {
		// Sem certificado (ou com ele vencido) não há o que transmitir.
		if (err instanceof OperacaoError) return null;
		throw err;
	}
}
