// Pedido de registro de evento da NFS-e. Por enquanto, só o cancelamento
// (evento e101101). O leiaute é o mesmo nos dois ambientes; os testes validam
// contra os XSD oficiais de cada um.

import type { Ambiente } from "../fiscal/dados";
import { z } from "zod";
import { NAMESPACE, agoraEmBrasilia, grupo, tag } from "./dps";

export const CancelamentoInput = z.object({
	/** Por que a nota está sendo cancelada. */
	motivo: z.enum(["erro_emissao", "servico_nao_prestado", "outros"]),
	/** Explicação do motivo, de 15 a 255 caracteres (exigência do leiaute). */
	justificativa: z.string().trim().min(15, "justificativa: mínimo de 15 caracteres").max(255),
});
export type CancelamentoInput = z.infer<typeof CancelamentoInput>;

const MOTIVO = { erro_emissao: "1", servico_nao_prestado: "2", outros: "9" } as const;
const EVENTO_CANCELAMENTO = "101101";

export interface EventoContexto {
	ambiente: Ambiente;
	/** Quem pede o evento: o titular do certificado que assina. */
	autor: { tipo: "cnpj" | "cpf"; numero: string };
	chaveAcesso: string;
	versaoAplicativo: string;
	agora?: Date;
}

export function montarPedidoCancelamento(
	input: CancelamentoInput,
	ctx: EventoContexto,
): { xml: string; id: string } {
	if (!/^[0-9A-Z]{50}$/.test(ctx.chaveAcesso)) throw new Error("Chave de acesso inválida.");
	// Id: "PRE" + chave de acesso (50) + código do evento (6).
	const id = `PRE${ctx.chaveAcesso}${EVENTO_CANCELAMENTO}`;
	const inf =
		tag("tpAmb", ctx.ambiente === "producao" ? "1" : "2") +
		tag("verAplic", ctx.versaoAplicativo.slice(0, 20)) +
		tag("dhEvento", agoraEmBrasilia(ctx.agora ?? new Date())) +
		tag(ctx.autor.tipo === "cnpj" ? "CNPJAutor" : "CPFAutor", ctx.autor.numero) +
		tag("chNFSe", ctx.chaveAcesso) +
		grupo(
			`e${EVENTO_CANCELAMENTO}`,
			tag("xDesc", "Cancelamento de NFS-e"),
			tag("cMotivo", MOTIVO[input.motivo]),
			tag("xMotivo", input.justificativa),
		);
	return {
		id,
		xml: `<pedRegEvento xmlns="${NAMESPACE}" versao="1.01"><infPedReg Id="${id}">${inf}</infPedReg></pedRegEvento>`,
	};
}
