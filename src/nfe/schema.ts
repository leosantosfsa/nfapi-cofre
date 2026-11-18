// Formato do pedido de NF-e (modelo 55) e NFC-e (modelo 65).
//
// O cofre não calcula imposto: quem chama informa bases, alíquotas e valores
// de cada item, e o cofre monta o XML, soma os totais, numera, assina e
// transmite. Os nomes são em português; a correspondência com as tags do
// leiaute 4.00 está em xml.ts.

import { z } from "zod";

const texto = (max: number, min = 1) => z.string().trim().min(min).max(max);
const digitos = (n: number) => z.string().regex(new RegExp(`^\\d{${n}}$`), `${n} dígitos, sem pontuação`);
const valor = z.number().min(0).max(9_999_999_999_999.99);
const percentual = z.number().min(0).max(999.9999);
const cnpj = z.string().regex(/^[0-9A-Z]{12}\d{2}$/, "CNPJ com 14 posições, sem pontuação");
const cpf = digitos(11);
const dataHora = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "data e hora ISO 8601 com fuso");
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data AAAA-MM-DD");

export const UFS = [
	"AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
	"PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;
const Uf = z.enum(UFS);

const Endereco = z.object({
	logradouro: texto(60, 2),
	numero: texto(60),
	complemento: texto(60).optional(),
	bairro: texto(60, 2),
	/** Código IBGE do município, 7 dígitos. */
	codigoMunicipio: digitos(7),
	municipio: texto(60, 2),
	uf: Uf,
	cep: digitos(8),
	telefone: z.string().regex(/^\d{6,14}$/, "só dígitos, com DDD").optional(),
});

const Emitente = z.object({
	/** Só é preciso informar para emitir por uma filial (mesma raiz do CNPJ do certificado). */
	cnpj: cnpj.optional(),
	nome: texto(60, 2),
	fantasia: texto(60).optional(),
	inscricaoEstadual: z.string().regex(/^\d{2,14}$/, "só dígitos"),
	inscricaoMunicipal: texto(15).optional(),
	cnae: digitos(7).optional(),
	/** CRT: simples_nacional (1), simples_excesso (2), normal (3), mei (4). */
	regime: z.enum(["simples_nacional", "simples_excesso", "normal", "mei"]),
	endereco: Endereco,
});

const Destinatario = z
	.object({
		cnpj: cnpj.optional(),
		cpf: cpf.optional(),
		/** Documento de estrangeiro (operação com o exterior). */
		idEstrangeiro: z
			.string()
			.regex(/^([A-Za-z0-9]{5,20})?$/, "vazio ou de 5 a 20 letras e números")
			.optional()
			.describe('Passaporte ou outro documento do estrangeiro. Use "" quando não houver documento.'),
		nome: texto(60, 2).optional(),
		/** contribuinte (1), isento (2) ou nao_contribuinte (9). */
		indicadorIe: z.enum(["contribuinte", "isento", "nao_contribuinte"]).default("nao_contribuinte"),
		inscricaoEstadual: z.string().regex(/^\d{2,14}$/, "só dígitos").optional(),
		email: z.string().trim().max(60).email().optional(),
		endereco: Endereco.extend({
			cep: digitos(8).optional(),
			uf: z.enum([...UFS, "EX"]).describe('UF do destinatário. No exterior: "EX", com codigoMunicipio "9999999" e municipio "EXTERIOR".'),
			codigoPais: z.string().regex(/^\d{1,4}$/).optional().describe("Código do país na tabela do Banco Central (padrão: 1058, Brasil)."),
			pais: texto(60).optional().describe("Nome do país (padrão: Brasil)."),
		}).optional(),
	})
	.refine((d) => [d.cnpj, d.cpf, d.idEstrangeiro].filter((v) => v !== undefined).length === 1, {
		message: "informe exatamente um entre cnpj, cpf e idEstrangeiro",
	})
	.refine((d) => d.indicadorIe !== "contribuinte" || d.inscricaoEstadual, {
		message: "inscricaoEstadual é obrigatória para destinatário contribuinte",
		path: ["inscricaoEstadual"],
	});

const Fcp = z.object({ baseCalculo: valor.optional(), aliquota: percentual, valor });

const Icms = z
	.object({
		/** Origem da mercadoria (0 a 8). */
		origem: z.number().int().min(0).max(8).default(0),
		/** Regime normal. */
		cst: z.enum(["00", "10", "20", "30", "40", "41", "50", "51", "60", "70", "90"]).optional(),
		/** Simples Nacional e MEI. */
		csosn: z.enum(["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"]).optional(),
		/** modBC: 0 margem, 1 pauta, 2 preço tabelado, 3 valor da operação. */
		modalidadeBc: z.number().int().min(0).max(3).optional(),
		reducaoBc: percentual.optional(),
		baseCalculo: valor.optional(),
		aliquota: percentual.optional(),
		valor: valor.optional(),
		fcp: Fcp.optional(),
		st: z
			.object({
				/** modBCST: 0 a 6 (4 = margem de valor agregado). */
				modalidadeBc: z.number().int().min(0).max(6),
				mva: percentual.optional(),
				reducaoBc: percentual.optional(),
				baseCalculo: valor,
				aliquota: percentual,
				valor,
				fcp: Fcp.optional(),
			})
			.optional(),
		desoneracao: z
			.object({
				valor,
				motivo: z.number().int().min(1).max(99),
				/** O valor desonerado é abatido do total da nota (indDeduzDeson)? */
				deduzDoTotal: z.boolean().default(false),
			})
			.optional(),
		/** CST 51. */
		diferimento: z.object({ valorOperacao: valor, percentual, valorDiferido: valor }).optional(),
		/** CSOSN 101, 201 e 900: crédito que o destinatário pode aproveitar. */
		creditoSimples: z.object({ aliquota: percentual, valor }).optional(),
		/** CST 60 e CSOSN 500: ICMS retido anteriormente por substituição. */
		retidoAnteriormente: z
			.object({
				baseCalculo: valor,
				aliquotaConsumidorFinal: percentual,
				valorSubstituto: valor.optional(),
				valor,
				fcp: Fcp.extend({ baseCalculo: valor }).optional(),
			})
			.optional(),
	})
	.refine((i) => (i.cst === undefined) !== (i.csosn === undefined), { message: "informe cst ou csosn (um dos dois)" });

/** IBS (da UF ou do município) ou CBS de um item, com os ajustes que a reforma prevê. */
const TributoIbsCbs = z.object({
	aliquota: percentual,
	valor,
	/** Diferimento (gDif). */
	diferimento: z.object({ percentual, valor }).optional(),
	/** Devolução de tributo (gDevTrib). */
	devolucao: z.object({ percentual: percentual.optional(), valor }).optional(),
	/** Redução de alíquota (gRed): o percentual de redução e a alíquota efetiva que resulta. */
	reducao: z.object({ percentual, aliquotaEfetiva: percentual }).optional(),
});
const AliquotaValor = z.object({ aliquota: percentual, valor });
const AliquotaEfetiva = z.object({ aliquotaEfetiva: percentual, valor });
const CreditoPresumido = z.object({
	aliquota: percentual,
	valor,
	/** O crédito está sob condição suspensiva (vai em vCredPresCondSus). */
	condicaoSuspensiva: z.boolean().default(false),
});

const PisCofins = z.object({
	/** 01/02 alíquota, 04 a 09 não tributado, 49 a 99 outras operações. */
	cst: z.string().regex(/^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$/, "CST de PIS/COFINS inválido"),
	baseCalculo: valor.optional(),
	aliquota: percentual.optional(),
	valor: valor.optional(),
});

/** Declaração de importação (DI, DSI, DIRE ou DUImp) de um item importado. */
const Importacao = z
	.object({
		numero: texto(15),
		data,
		localDesembaraco: texto(60),
		ufDesembaraco: Uf,
		dataDesembaraco: data,
		/** tpViaTransp: 1 marítima, 4 aérea, 5 postal, 7 rodoviária... até 13. */
		viaTransporte: z.number().int().min(1).max(13),
		/** Adicional ao Frete para Renovação da Marinha Mercante (obrigatório na via marítima). */
		afrmm: valor.optional(),
		/** tpIntermedio: conta_propria (1), conta_e_ordem (2) ou encomenda (3). */
		intermediacao: z.enum(["conta_propria", "conta_e_ordem", "encomenda"]).default("conta_propria"),
		/** Adquirente ou encomendante, quando a importação não é por conta própria. */
		adquirente: z.object({ cnpj: cnpj.optional(), cpf: cpf.optional(), uf: Uf.optional() }).optional(),
		codigoExportador: texto(60),
		adicoes: z
			.array(
				z.object({
					numero: z.number().int().min(1).max(999).optional(),
					sequencia: z.number().int().min(1).max(99_999),
					codigoFabricante: texto(60),
					desconto: z.number().positive().max(9_999_999_999_999.99).optional(),
					drawback: texto(20).optional(),
				}),
			)
			.min(1)
			.max(999),
	})
	.refine((i) => i.intermediacao === "conta_propria" || i.adquirente?.cnpj || i.adquirente?.cpf, {
		message: "informe o adquirente (cnpj ou cpf) na importação por conta e ordem ou por encomenda",
		path: ["adquirente"],
	});

/** Dados de exportação de um item: drawback e, na exportação indireta, a nota de remessa. */
const ExportacaoDoItem = z.object({
	drawback: texto(20).optional(),
	indireta: z
		.object({
			registroExportacao: z.string().regex(/^\d{0,12}$/, "até 12 dígitos"),
			chaveNfe: z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/, "chave de acesso com 44 posições"),
			quantidade: z.number().min(0).max(99_999_999_999.9999),
		})
		.optional(),
});

const Item = z.object({
	codigo: texto(60),
	/** GTIN; sem código de barras, deixe em branco ("SEM GTIN"). */
	ean: z.string().regex(/^(\d{8}|\d{12,14})$/).optional(),
	descricao: texto(120),
	ncm: z.string().regex(/^(\d{2}|\d{8})$/, "NCM com 8 dígitos (ou 00 para serviço)"),
	cest: digitos(7).optional(),
	codigoBeneficioFiscal: z.string().regex(/^([A-Za-z0-9]{8}|[A-Za-z0-9]{10}|SEM CBENEF)$/).optional(),
	cfop: digitos(4),
	unidade: texto(6),
	quantidade: z.number().positive().max(99_999_999_999.9999),
	valorUnitario: z.number().min(0).max(99_999_999_999.9999999999),
	/** Valor bruto do item; quando omitido, é quantidade × valorUnitario. */
	valorTotal: valor.optional(),
	/** Unidade tributável; quando omitida, repete a comercial. */
	tributavel: z
		.object({
			ean: z.string().regex(/^(\d{8}|\d{12,14})$/).optional(),
			unidade: texto(6),
			quantidade: z.number().positive().max(99_999_999_999.9999),
			valorUnitario: z.number().min(0).max(99_999_999_999.9999999999),
		})
		.optional(),
	frete: valor.optional(),
	seguro: valor.optional(),
	desconto: valor.optional(),
	outrasDespesas: valor.optional(),
	/** O valor do item entra no total da nota? */
	compoeTotal: z.boolean().default(true),
	/** Item importado: uma entrada por declaração de importação. */
	importacao: z.array(Importacao).max(100).optional(),
	/** Item exportado: drawback e dados da exportação indireta. */
	exportacao: z.array(ExportacaoDoItem).max(500).optional(),
	numeroPedido: texto(15).optional(),
	itemPedido: z.number().int().min(0).max(999_999).optional(),
	informacoesAdicionais: texto(500).optional(),
	impostos: z.object({
		/** Valor aproximado dos tributos (Lei da Transparência). */
		valorAproximadoTributos: valor.optional(),
		icms: Icms,
		ipi: z
			.object({
				cst: z.enum(["00", "01", "02", "03", "04", "05", "49", "50", "51", "52", "53", "54", "55", "99"]),
				codigoEnquadramento: z.string().regex(/^\d{1,3}$/).default("999"),
				baseCalculo: valor.optional(),
				aliquota: percentual.optional(),
				valor: valor.optional(),
			})
			.optional(),
		/** Imposto de importação. */
		ii: z.object({ baseCalculo: valor, despesasAduaneiras: valor, valor, iof: valor }).optional(),
		pis: PisCofins.optional(),
		cofins: PisCofins.optional(),
		/**
		 * IBS e CBS (reforma tributária). Obrigatório para o regime normal; o MEI
		 * não informa. Sem baseCalculo, vão só o CST e a classificação.
		 */
		ibsCbs: z
			.object({
				cst: digitos(3),
				/** cClassTrib: código de classificação tributária, 6 dígitos. */
				classificacao: digitos(6),
				/** Operação de doação (indDoacao). */
				doacao: z.boolean().optional(),
				baseCalculo: valor.optional(),
				ibsUf: TributoIbsCbs.optional(),
				ibsMunicipio: TributoIbsCbs.optional(),
				cbs: TributoIbsCbs.optional(),
				/** Como seria a tributação regular, quando a operação tem tratamento diferenciado (gTribRegular). */
				tributacaoRegular: z
					.object({ cst: digitos(3), classificacao: digitos(6), ibsUf: AliquotaEfetiva, ibsMunicipio: AliquotaEfetiva, cbs: AliquotaEfetiva })
					.optional(),
				/** Venda a órgão público (gTribCompraGov). */
				compraGovernamental: z.object({ ibsUf: AliquotaValor, ibsMunicipio: AliquotaValor, cbs: AliquotaValor }).optional(),
				/** Optante do Simples Nacional que recolhe IBS e CBS pelo regime (gTribSN). */
				simplesNacional: z.object({ ibs: AliquotaValor.optional(), cbs: AliquotaValor }).optional(),
				/** Estorno de crédito (gEstornoCred). */
				estornoCredito: z.object({ ibs: valor, cbs: valor }).optional(),
				/** Crédito presumido da operação (gCredPresOper). */
				creditoPresumido: z
					.object({ baseCalculo: valor, codigo: digitos(2), ibs: CreditoPresumido.optional(), cbs: CreditoPresumido.optional() })
					.optional(),
			})
			.optional()
			.describe(
				"IBS e CBS do item, como calculados pelo sistema emissor. Sem baseCalculo, vão só o CST e a classificação. Não há suporte ao regime monofásico (combustíveis), à transferência de crédito, ao ajuste de competência nem ao crédito presumido da Zona Franca de Manaus.",
			),
		/** Imposto Seletivo. */
		impostoSeletivo: z
			.object({
				cst: digitos(3),
				classificacao: digitos(6),
				baseCalculo: valor.optional(),
				aliquota: percentual.optional(),
				/** Alíquota específica, por unidade (adRemIS). */
				aliquotaEspecifica: z.number().min(0).max(999.9999).optional(),
				unidade: texto(6).optional(),
				quantidade: z.number().min(0).max(99_999_999_999.9999).optional(),
				valor: valor.optional(),
			})
			.optional(),
		/** Diferencial de alíquota na venda interestadual a consumidor final não contribuinte. */
		difal: z
			.object({
				baseCalculo: valor,
				aliquotaInterna: percentual,
				aliquotaInterestadual: percentual,
				valorDestino: valor,
				fcp: Fcp.optional(),
			})
			.optional(),
	}),
});

const Pagamento = z.object({
	/** tPag: 01 dinheiro, 03 cartão de crédito, 04 débito, 15 boleto, 17 PIX, 90 sem pagamento, 99 outros. */
	forma: digitos(2),
	valor,
	/** Obrigatória quando a forma é 99. */
	descricao: texto(60, 2).optional(),
	/** a_vista (0) ou a_prazo (1). */
	indicador: z.enum(["a_vista", "a_prazo"]).optional(),
	cartao: z
		.object({
			/** integrado (TEF, 1) ou nao_integrado (POS, 2). */
			integracao: z.enum(["integrado", "nao_integrado"]).default("nao_integrado"),
			cnpjCredenciadora: cnpj.optional(),
			bandeira: digitos(2).optional(),
			autorizacao: texto(128).optional(),
		})
		.optional(),
});

const Transporte = z.object({
	/** modFrete: 0 remetente (CIF), 1 destinatário (FOB), 2 terceiros, 3 próprio remetente, 4 próprio destinatário, 9 sem frete. */
	modalidade: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(9)]).default(9),
	transportadora: z
		.object({
			cnpj: cnpj.optional(),
			cpf: cpf.optional(),
			nome: texto(60, 2).optional(),
			inscricaoEstadual: z.string().regex(/^\d{2,14}$/).optional(),
			endereco: texto(60).optional(),
			municipio: texto(60).optional(),
			uf: Uf.optional(),
		})
		.optional(),
	veiculo: z.object({ placa: z.string().regex(/^[A-Z]{2,3}[0-9]{4}$|^[A-Z]{3,4}[0-9]{3}$|^[A-Z0-9]{7}$/), uf: Uf.optional(), rntc: texto(20).optional() }).optional(),
	volumes: z
		.array(
			z.object({
				quantidade: z.number().int().min(0).optional(),
				especie: texto(60).optional(),
				marca: texto(60).optional(),
				numeracao: texto(60).optional(),
				pesoLiquido: z.number().min(0).optional(),
				pesoBruto: z.number().min(0).optional(),
			}),
		)
		.max(5000)
		.optional(),
});

const Comum = {
	serie: z
		.number()
		.int()
		.min(0)
		.max(889)
		.optional()
		.describe("Série cadastrada no cofre. Pode ser omitida quando só há uma para o modelo e o ambiente."),
	naturezaOperacao: texto(60),
	dataEmissao: dataHora
		.optional()
		.describe(
			"Prefira omitir: o cofre usa a hora da emissão, no fuso da UF. Se for informada, entra na comparação de conteúdo da referência, e uma NFC-e com data antiga é rejeitada pela SEFAZ.",
		),
	/** normal (1), complementar (2), ajuste (3), devolucao (4). */
	finalidade: z.enum(["normal", "complementar", "ajuste", "devolucao"]).default("normal"),
	/** Chaves das notas referenciadas (obrigatório em devolução e complementar). */
	notasReferenciadas: z.array(z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/, "chave de acesso com 44 posições")).max(999).optional(),
	/** Marketplace ou plataforma que intermediou a venda. */
	intermediador: z.object({ cnpj, identificacao: texto(60, 2) }).optional(),
	emitente: Emitente,
	itens: z.array(Item).min(1).max(990),
	pagamentos: z.array(Pagamento).min(1).max(100),
	troco: valor.optional(),
	informacoesComplementares: texto(5000).optional(),
	informacoesFisco: texto(2000).optional(),
	responsavelTecnico: z
		.object({ cnpj, contato: texto(60, 2), email: z.string().trim().min(6).max(60).email(), telefone: z.string().regex(/^\d{6,14}$/) })
		.optional(),
};

/** O regime do emitente decide entre CST (normal) e CSOSN (Simples e MEI). */
function conferirRegime(pedido: { emitente: { regime: string }; itens: { impostos: { icms: { cst?: string; csosn?: string } } }[] }, ctx: z.RefinementCtx) {
	const simples = pedido.emitente.regime === "simples_nacional" || pedido.emitente.regime === "mei";
	pedido.itens.forEach((item, i) => {
		if (simples && item.impostos.icms.csosn === undefined) {
			ctx.addIssue({ code: "custom", path: ["itens", i, "impostos", "icms", "csosn"], message: "emitente do Simples Nacional informa csosn, não cst" });
		}
		if (!simples && item.impostos.icms.cst === undefined) {
			ctx.addIssue({ code: "custom", path: ["itens", i, "impostos", "icms", "cst"], message: "emitente do regime normal informa cst, não csosn" });
		}
	});
}

function conferirPagamentos(pedido: { pagamentos: { forma: string; descricao?: string }[] }, ctx: z.RefinementCtx) {
	pedido.pagamentos.forEach((p, i) => {
		if (p.forma === "99" && !p.descricao) {
			ctx.addIssue({ code: "custom", path: ["pagamentos", i, "descricao"], message: "descreva a forma de pagamento quando ela é 99 (outros)" });
		}
	});
}

export const NfeInput = z
	.object({
		...Comum,
		/** saida (1) ou entrada (0). */
		tipo: z.enum(["saida", "entrada"]).default("saida"),
		dataSaida: dataHora.optional(),
		consumidorFinal: z.boolean().default(false),
		/** indPres: como o comprador estava presente na operação. */
		presenca: z.enum(["nao_se_aplica", "presencial", "internet", "teleatendimento", "entrega_domicilio", "presencial_fora", "outros"]),
		/** Padrão: decidido pelas UFs do emitente e do destinatário. */
		destinoOperacao: z.enum(["interna", "interestadual", "exterior"]).optional(),
		destinatario: Destinatario,
		/** Nota de exportação: por onde a mercadoria sai do país. */
		exportacao: z
			.object({
				ufEmbarque: Uf,
				localEmbarque: texto(60),
				localDespacho: texto(60).optional(),
			})
			.optional(),
		transporte: Transporte.default({ modalidade: 9 }),
		cobranca: z
			.object({
				fatura: z.object({ numero: texto(60), valorOriginal: valor, desconto: valor.optional(), valorLiquido: valor }).optional(),
				duplicatas: z.array(z.object({ numero: texto(60), vencimento: data, valor })).max(120).optional(),
			})
			.optional(),
	})
	.superRefine((pedido, ctx) => {
		conferirRegime(pedido, ctx);
		conferirPagamentos(pedido, ctx);
		pedido.itens.forEach((item, i) => {
			for (const tributo of ["pis", "cofins"] as const) {
				if (!item.impostos[tributo]) {
					ctx.addIssue({ code: "custom", path: ["itens", i, "impostos", tributo], message: `informe ${tributo} (obrigatório na NF-e)` });
				}
			}
		});
		if ((pedido.finalidade === "devolucao" || pedido.finalidade === "complementar") && !pedido.notasReferenciadas?.length) {
			ctx.addIssue({ code: "custom", path: ["notasReferenciadas"], message: "informe a nota referenciada" });
		}
	});
export type NfeInput = z.infer<typeof NfeInput>;

export const NfceInput = z
	.object({
		...Comum,
		/** presencial (1) ou entrega_domicilio (4). */
		presenca: z.enum(["presencial", "entrega_domicilio"]).default("presencial"),
		/** Opcional na NFC-e: consumidor identificado (CPF na nota). */
		destinatario: Destinatario.optional(),
		transporte: Transporte.default({ modalidade: 9 }),
	})
	.superRefine((pedido, ctx) => {
		conferirRegime(pedido, ctx);
		conferirPagamentos(pedido, ctx);
		if (pedido.finalidade !== "normal") {
			ctx.addIssue({ code: "custom", path: ["finalidade"], message: "a NFC-e só tem finalidade normal" });
		}
	});
export type NfceInput = z.infer<typeof NfceInput>;

/** Pedido de qualquer um dos dois modelos, já validado. */
export type PedidoNfe = (NfeInput & { modelo: "55" }) | (NfceInput & { modelo: "65" });

export const CancelamentoNfe = z.object({ justificativa: texto(255, 15) });
export type CancelamentoNfe = z.infer<typeof CancelamentoNfe>;

export const CartaCorrecao = z.object({ correcao: texto(1000, 15) });
export type CartaCorrecao = z.infer<typeof CartaCorrecao>;

export const InutilizacaoInput = z
	.object({
		modelo: z.enum(["nfe", "nfce"]),
		ambiente: z.enum(["homologacao", "producao"]).default("homologacao"),
		serie: z.number().int().min(0).max(889),
		numeroInicial: z.number().int().min(1).max(999_999_999),
		numeroFinal: z.number().int().min(1).max(999_999_999),
		justificativa: texto(255, 15),
		/** UF e CNPJ do emitente da faixa; o CNPJ só é preciso para filial. */
		uf: Uf,
		cnpj: cnpj.optional(),
	})
	.refine((i) => i.numeroFinal >= i.numeroInicial, { message: "numeroFinal não pode ser menor que numeroInicial", path: ["numeroFinal"] });
export type InutilizacaoInput = z.infer<typeof InutilizacaoInput>;
