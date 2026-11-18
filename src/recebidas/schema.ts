// Pedidos da API de notas recebidas. Os mesmos schemas validam as requisições
// e geram o contrato (contrato.ts).

import { z } from "zod";
import { MANIFESTACOES, type Manifestacao } from "../nfe/eventos";
import { UFS } from "../nfe/schema";

const Ambiente = z.enum(["homologacao", "producao"]);
const Cnpj = z.string().regex(/^[0-9A-Z]{12}\d{2}$/, "CNPJ com 14 posições, sem pontuação");
const Chave = z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/, "chave de acesso com 44 posições");
const TIPOS = Object.keys(MANIFESTACOES) as [Manifestacao, ...Manifestacao[]];

export const ManifestacaoInput = z.object({
	tipo: z.enum(TIPOS).describe(
		"ciencia: sabe da nota e ainda não tem a palavra final (libera o XML completo). confirmacao: a operação aconteceu. desconhecimento: não reconhece a operação. nao_realizada: a operação não se concretizou (recusa da mercadoria, por exemplo).",
	),
	justificativa: z.string().trim().min(15).max(255).optional().describe("Obrigatória na operação não realizada (15 a 255 caracteres); ignorada nas demais."),
});

export const ManifestacaoPorChaveInput = ManifestacaoInput.extend({
	ambiente: Ambiente.default("homologacao"),
	chaveAcesso: Chave,
	cnpj: Cnpj.optional().describe("CNPJ do destinatário, quando é uma filial do titular do certificado."),
});

export const SincronizarInput = z.object({
	ambiente: Ambiente.default("homologacao"),
	cnpj: Cnpj.optional().describe("Filial a consultar; padrão: o titular do certificado."),
});

export const ConsultarChaveInput = SincronizarInput.extend({ chaveAcesso: Chave });

/** Configuração feita pelo emitente na tela /setup. */
export const ConfiguracaoInput = z.object({
	ambiente: Ambiente,
	uf: z.enum(UFS),
	consultaAutomatica: z.boolean(),
	cienciaAutomatica: z.boolean().default(false),
	cnpj: Cnpj.optional(),
});
