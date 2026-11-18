// Pedidos dos relatórios e da exportação por período. Fica separado das rotas
// para o contrato (OpenAPI) poder usá-lo sem carregar o resto.

import { z } from "zod";

/** O que pode entrar numa exportação. */
export const TIPOS = ["nfse", "nfe", "nfce", "eventos", "inutilizacoes", "recebidas"] as const;
export type Tipo = (typeof TIPOS)[number];

/** Dias entre as duas datas (AAAA-MM-DD), contando as duas; NaN se alguma não existe. */
export function diasDoPeriodo(de: string, ate: string): number {
	// O 30 de fevereiro não pode virar 2 de março em silêncio.
	const instante = (dia: string) => {
		const ms = Date.parse(`${dia}T00:00:00Z`);
		return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === dia ? ms : Number.NaN;
	};
	return Math.round((instante(ate) - instante(de)) / 86_400_000) + 1;
}

const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use o formato AAAA-MM-DD");
const Campos = {
	ambiente: z.enum(["homologacao", "producao"]),
	de: Dia.describe("Primeiro dia de emissão do período, inclusive (AAAA-MM-DD)."),
	ate: Dia.describe("Último dia de emissão do período, inclusive. O período vai até 366 dias."),
};
const periodoValido = <T extends { de: string; ate: string }>(p: T, ctx: z.RefinementCtx) => {
	const dias = diasDoPeriodo(p.de, p.ate);
	// Data inexistente dá NaN, que cai na primeira regra.
	if (!(dias >= 1)) ctx.addIssue({ code: "custom", path: ["ate"], message: "o período termina antes de começar ou tem uma data inexistente" });
	else if (dias > 366) ctx.addIssue({ code: "custom", path: ["ate"], message: "o período vai até 366 dias" });
};

/** Período de um relatório: pelos dias de emissão, em um ambiente. */
export const PeriodoBase = z.object(Campos);
export const PeriodoInput = PeriodoBase.superRefine(periodoValido);

export const ExportacaoBase = z.object({
	...Campos,
	incluir: z
		.array(z.enum(TIPOS))
		.min(1)
		.default([...TIPOS])
		.describe("O que entra no arquivo. `eventos` vale para as notas emitidas e para as recebidas que entrarem. Padrão: tudo."),
});
export const ExportacaoInput = ExportacaoBase.superRefine(periodoValido);
