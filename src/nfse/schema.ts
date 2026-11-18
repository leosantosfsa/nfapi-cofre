// O que o cliente da API envia para emitir uma NFS-e. Nomes em português e por
// extenso; a tradução para as tags e códigos da DPS fica em dps.ts.
//
// Cobre o caso comum: o prestador é o emitente, tomador no Brasil e serviço
// prestado em município brasileiro. Fora do escopo por enquanto: tomador no
// exterior, intermediário, obra, evento, comércio exterior, deduções e o grupo
// IBS/CBS (opcional nos schemas atuais).

import { z } from "zod";

const digitos = (n: number, nome: string) =>
	z.string().regex(new RegExp(`^\\d{${n}}$`), `${nome} deve ter ${n} dígitos`);
const texto = (max: number) => z.string().trim().min(1).max(max);

const dinheiro = z
	.number()
	.nonnegative()
	.max(999_999_999_999_999)
	.refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "use no máximo 2 casas decimais");
const percentual = (max: number) =>
	z
		.number()
		.nonnegative()
		.max(max)
		.refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "use no máximo 2 casas decimais");

export const Endereco = z.object({
	codigoMunicipio: digitos(7, "codigoMunicipio (IBGE)"),
	cep: digitos(8, "cep"),
	logradouro: texto(255),
	numero: texto(60),
	complemento: texto(156).optional(),
	bairro: texto(60),
});

export const Tomador = z
	.object({
		cnpj: z
			.string()
			.regex(/^[0-9A-Z]{12}\d{2}$/, "cnpj deve ter 14 caracteres, sem máscara")
			.optional(),
		cpf: digitos(11, "cpf").optional(),
		nome: texto(300),
		inscricaoMunicipal: texto(15).optional(),
		endereco: Endereco.optional(),
		telefone: z.string().regex(/^\d{6,20}$/, "telefone: só dígitos, de 6 a 20").optional(),
		email: z.email().max(80).optional(),
	})
	.refine((t) => Boolean(t.cnpj) !== Boolean(t.cpf), "informe cnpj ou cpf do tomador (apenas um)");

export const RegimeTributario = z.object({
	/** Situação perante o Simples Nacional. */
	simplesNacional: z.enum(["nao_optante", "mei", "me_epp"]),
	/**
	 * Só para ME/EPP. 1: tributos federais e ISSQN pelo Simples; 2: federais pelo
	 * Simples e ISSQN fora; 3: federais e ISSQN fora do Simples.
	 */
	apuracaoSimples: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
	/**
	 * Regime especial de tributação (código da DPS). 0: nenhum; 1: ato cooperado;
	 * 2: estimativa; 3: microempresa municipal; 4: notário ou registrador;
	 * 5: profissional autônomo; 6: sociedade de profissionais; 9: outros.
	 */
	regimeEspecial: z
		.union([0, 1, 2, 3, 4, 5, 6, 9].map((n) => z.literal(n)))
		.default(0),
});

const TotalTributos = z.discriminatedUnion("tipo", [
	z.object({ tipo: z.literal("nao_informado") }),
	/** Percentual aproximado de tributos para optantes do Simples Nacional. */
	z.object({ tipo: z.literal("percentual_simples"), percentual: percentual(99.99) }),
	z.object({
		tipo: z.literal("valores"),
		federal: dinheiro,
		estadual: dinheiro,
		municipal: dinheiro,
	}),
	z.object({
		tipo: z.literal("percentuais"),
		federal: percentual(999.99),
		estadual: percentual(999.99),
		municipal: percentual(999.99),
	}),
]);

export const NfseInput = z.object({
	serie: z.string().regex(/^\d{1,5}$/, "serie: de 1 a 5 dígitos").default("1"),
	/** Número da DPS. Se omitido, a API usa o próximo da série. */
	numero: z.number().int().positive().max(999_999_999_999_999).optional(),
	/** Data e hora da emissão com fuso (ex.: 2026-11-16T10:00:00-03:00). Padrão: agora. */
	dataEmissao: z.iso.datetime({ offset: true }).optional(),
	/** Data de competência (AAAA-MM-DD). Padrão: o dia da emissão. */
	dataCompetencia: z.iso.date().optional(),

	prestador: z.object({
		/** Município do prestador (código IBGE), que é o município emissor da nota. */
		codigoMunicipio: digitos(7, "codigoMunicipio (IBGE)"),
		inscricaoMunicipal: texto(15).optional(),
		telefone: z.string().regex(/^\d{6,20}$/, "telefone: só dígitos, de 6 a 20").optional(),
		email: z.email().max(80).optional(),
		regimeTributario: RegimeTributario,
	}),

	tomador: Tomador.optional(),

	servico: z.object({
		/** Município onde o serviço foi prestado (código IBGE). */
		codigoMunicipioPrestacao: digitos(7, "codigoMunicipioPrestacao (IBGE)"),
		/** Código de tributação nacional (item, subitem e desdobro da LC 116), 6 dígitos. */
		codigoTributacaoNacional: digitos(6, "codigoTributacaoNacional"),
		codigoTributacaoMunicipal: digitos(3, "codigoTributacaoMunicipal").optional(),
		descricao: texto(2000),
		codigoNbs: digitos(9, "codigoNbs").optional(),
		codigoInterno: z.string().regex(/^[a-zA-Z0-9]{1,20}$/).optional(),
		informacoesComplementares: texto(2000).optional(),
	}),

	valores: z.object({
		servico: dinheiro,
		descontoIncondicionado: dinheiro.optional(),
		descontoCondicionado: dinheiro.optional(),
	}),

	tributacao: z.object({
		issqn: z.object({
			tipo: z.enum(["tributavel", "imunidade", "exportacao", "nao_incidencia"]).default("tributavel"),
			/** Só quando tipo = imunidade (código de 0 a 5 da DPS). */
			tipoImunidade: z.number().int().min(0).max(5).optional(),
			retencao: z.enum(["nao_retido", "retido_tomador", "retido_intermediario"]).default("nao_retido"),
			/** Alíquota do ISSQN em % (ex.: 5 ou 2.5). */
			aliquota: percentual(9.99).optional(),
		}),
		federal: z
			.object({
				pisCofins: z
					.object({
						cst: z.string().regex(/^\d{2}$/, "cst: 2 dígitos"),
						baseCalculo: dinheiro.optional(),
						aliquotaPis: percentual(99.99).optional(),
						aliquotaCofins: percentual(99.99).optional(),
						valorPis: dinheiro.optional(),
						valorCofins: dinheiro.optional(),
						/** Tipo de retenção do PIS/COFINS (código de 0 a 9 da DPS). */
						retencao: z.number().int().min(0).max(9).optional(),
					})
					.optional(),
				retencaoCp: dinheiro.optional(),
				retencaoIrrf: dinheiro.optional(),
				retencaoCsll: dinheiro.optional(),
			})
			.optional(),
		totalTributos: TotalTributos.default({ tipo: "nao_informado" }),
	}),
});

export type NfseInput = z.infer<typeof NfseInput>;
