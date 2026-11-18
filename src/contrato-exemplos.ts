// Exemplos de pedido usados no contrato da API (GET /v1/openapi.json) e nos
// testes: se um exemplo deixar de ser válido, os testes falham.

import { montarChave } from "./nfe/chave";

const ENDERECO_EMITENTE = {
	logradouro: "Rua das Flores",
	numero: "100",
	bairro: "Centro",
	codigoMunicipio: "3550308",
	municipio: "São Paulo",
	uf: "SP",
	cep: "01001000",
	telefone: "1133334444",
} as const;

/** NF-e de venda dentro do estado, emitente do regime normal, a prazo. */
export const EXEMPLO_NFE = {
	ambiente: "homologacao",
	referencia: "pedido-1001",
	serie: 1,
	naturezaOperacao: "Venda de mercadoria",
	presenca: "outros",
	consumidorFinal: false,
	emitente: {
		nome: "Empresa Exemplo Ltda",
		fantasia: "Exemplo",
		inscricaoEstadual: "111111111111",
		regime: "normal",
		endereco: ENDERECO_EMITENTE,
	},
	destinatario: {
		cnpj: "99888777000166",
		nome: "Cliente Ltda",
		indicadorIe: "contribuinte",
		inscricaoEstadual: "222222222222",
		email: "compras@cliente.example",
		endereco: {
			logradouro: "Avenida Brasil",
			numero: "2000",
			bairro: "Jardins",
			codigoMunicipio: "3509502",
			municipio: "Campinas",
			uf: "SP",
			cep: "13010000",
		},
	},
	itens: [
		{
			codigo: "SKU-1",
			descricao: "Cadeira de escritório",
			ncm: "94013090",
			cfop: "5102",
			unidade: "UN",
			quantidade: 2,
			valorUnitario: 350,
			impostos: {
				icms: { origem: 0, cst: "00", modalidadeBc: 3, baseCalculo: 700, aliquota: 18, valor: 126 },
				pis: { cst: "01", baseCalculo: 700, aliquota: 1.65, valor: 11.55 },
				cofins: { cst: "01", baseCalculo: 700, aliquota: 7.6, valor: 53.2 },
				// Reforma tributária: obrigatório para o regime normal. Alíquotas de teste de 2026.
				ibsCbs: {
					cst: "000",
					classificacao: "000001",
					baseCalculo: 509.25,
					ibsUf: { aliquota: 0.1, valor: 0.51 },
					ibsMunicipio: { aliquota: 0, valor: 0 },
					cbs: { aliquota: 0.9, valor: 4.58 },
				},
			},
		},
	],
	transporte: { modalidade: 0 },
	cobranca: {
		fatura: { numero: "1001", valorOriginal: 700, valorLiquido: 700 },
		duplicatas: [{ numero: "001", vencimento: "2026-12-16", valor: 700 }],
	},
	pagamentos: [{ forma: "15", valor: 700, indicador: "a_prazo" }],
	informacoesComplementares: "Pedido 1001",
} as const;

/** NFC-e de venda no caixa, emitente do Simples Nacional, em dinheiro com troco. */
export const EXEMPLO_NFCE = {
	ambiente: "homologacao",
	referencia: "caixa1-venda-5001",
	serie: 1,
	naturezaOperacao: "Venda ao consumidor",
	emitente: {
		nome: "Loja Exemplo Ltda",
		inscricaoEstadual: "111111111111",
		regime: "simples_nacional",
		endereco: ENDERECO_EMITENTE,
	},
	destinatario: { cpf: "12345678909" },
	itens: [
		{
			codigo: "789",
			descricao: "Camiseta de algodão",
			ncm: "61091000",
			cfop: "5102",
			unidade: "UN",
			quantidade: 1,
			valorUnitario: 59.9,
			impostos: { valorAproximadoTributos: 12.5, icms: { origem: 0, csosn: "102" } },
		},
	],
	pagamentos: [{ forma: "01", valor: 100 }],
	troco: 40.1,
} as const;

/** Chave de acesso (fictícia, com dígito verificador válido) de uma NF-e emitida por um fornecedor. */
export const EXEMPLO_CHAVE_RECEBIDA = montarChave({ cUF: "35", emissao: "2026-11-10", cnpj: "44555666000181", modelo: "55", serie: 1, numero: 101, tpEmis: "1", cNF: "87654321" });

export const EXEMPLO_NFSE = {
	ambiente: "homologacao",
	referencia: "pedido-2001",
	prestador: { codigoMunicipio: "3550308", regimeTributario: { simplesNacional: "me_epp", apuracaoSimples: 1 } },
	tomador: { cnpj: "99888777000166", nome: "Cliente Ltda" },
	servico: { codigoMunicipioPrestacao: "3550308", codigoTributacaoNacional: "010701", descricao: "Suporte técnico" },
	valores: { servico: 1500 },
	tributacao: { issqn: { aliquota: 2 }, totalTributos: { tipo: "percentual_simples", percentual: 6 } },
} as const;
