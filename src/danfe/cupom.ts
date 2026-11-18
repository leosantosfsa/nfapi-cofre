// Conteúdo do DANFE NFC-e (o cupom da NFC-e), montado a partir do XML arquivado.
//
// Segue o "Manual de Especificações Técnicas do DANFE NFC-e e QR Code", versão
// 6.0: as divisões, a ordem e os dizeres obrigatórios vêm de lá. O resultado é
// um JSON organizado em seções e linhas, para o sistema do caixa montar a
// impressão na bobina (58 ou 80 mm) com o motor de cupom que já tem. O cofre
// não conhece impressora: não há largura, corte nem comando aqui.
//
// Os textos fixos usam só caracteres comuns às páginas de código de impressoras
// térmicas (sem travessão, reticências ou símbolos tipográficos).

import { atributo, dataHora, dinheiro, documento, endereco, filho, filhos, numero, primeiro, raizDoXml, texto } from "./leitura";

export type Alinhamento = "esquerda" | "centro" | "direita";

export type Linha =
	| { tipo: "texto"; texto: string; alinhamento: Alinhamento; negrito: boolean; tamanho: "normal" | "dobrado" }
	| { tipo: "separador" }
	| {
			tipo: "item";
			numero: number;
			codigo: string;
			descricao: string;
			quantidade: number;
			unidade: string;
			valorUnitario: number;
			valorTotal: number;
			/** Os mesmos valores já no formato de impressão (vírgula decimal, ponto de milhar). */
			quantidadeTexto: string;
			valorUnitarioTexto: string;
			valorTotalTexto: string;
	  }
	| { tipo: "par"; rotulo: string; valor: string; negrito: boolean }
	/** Chave de acesso: só os 44 caracteres. Imprima em 11 blocos de 4, separados por espaço. */
	| { tipo: "chave"; chave: string }
	/** QR Code: gere a imagem a partir deste texto, sem alterar nem truncar. */
	| { tipo: "qrcode"; texto: string; tamanhoMinimoMm: number };

export interface Secao {
	/** Divisão do manual do DANFE NFC-e a que as linhas pertencem. */
	divisao:
		| "cabecalho"
		| "itens"
		| "totais"
		| "consulta"
		| "consumidor"
		| "identificacao"
		| "qrcode"
		| "mensagem_fiscal"
		| "mensagem_contribuinte";
	linhas: Linha[];
}

export interface Cupom {
	modelo: "nfce";
	chaveAcesso: string;
	ambiente: "homologacao" | "producao";
	/** Nota emitida em contingência offline (tipo de emissão 9). */
	contingencia: boolean;
	/** A nota em contingência ainda não foi autorizada: o cupom sai sem protocolo. */
	pendenteDeAutorizacao: boolean;
	via: "consumidor" | "estabelecimento";
	numero: number;
	serie: number;
	emitidaEm: string;
	protocolo: string | null;
	autorizadaEm: string | null;
	valorAPagar: number;
	qrCode: string;
	urlConsulta: string;
	secoes: Secao[];
}

const HOMOLOGACAO = "EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL";

/** Formas de pagamento (tPag) como vão impressas. */
const FORMAS: Record<string, string> = {
	"01": "Dinheiro", "02": "Cheque", "03": "Cartão de Crédito", "04": "Cartão de Débito", "05": "Cartão da Loja",
	"10": "Vale Alimentação", "11": "Vale Refeição", "12": "Vale Presente", "13": "Vale Combustível", "14": "Duplicata Mercantil",
	"15": "Boleto Bancário", "16": "Depósito Bancário", "17": "PIX", "18": "Transferência Bancária",
	"19": "Programa de Fidelidade", "20": "PIX", "21": "Crédito em Loja", "90": "Sem Pagamento", "99": "Outros",
};

/** Quantidade com até quatro casas, sem zeros sobrando: 2 -> "2", 1.5 -> "1,5". */
function quantidade(valor: number): string {
	return String(Number(valor.toFixed(4))).replace(".", ",");
}

const linha = (t: string, alinhamento: Alinhamento = "esquerda", negrito = false, tamanho: "normal" | "dobrado" = "normal"): Linha => ({
	tipo: "texto", texto: t, alinhamento, negrito, tamanho,
});
const par = (rotulo: string, valor: string, negrito = false): Linha => ({ tipo: "par", rotulo, valor, negrito });
const SEPARADOR: Linha = { tipo: "separador" };

export class CupomError extends Error {}

/**
 * Monta o cupom a partir do XML arquivado: o nfeProc (nota autorizada) ou a
 * NFC-e assinada que ainda aguarda autorização (contingência).
 */
export function montarCupom(xml: string, opcoes: { via?: "consumidor" | "estabelecimento" } = {}): Cupom {
	const raiz = raizDoXml(xml);
	const inf = primeiro(raiz, "infNFe");
	const ide = filho(inf, "ide");
	if (!raiz || !inf || !ide || texto(ide, "mod") !== "65") throw new CupomError("O XML arquivado não é de uma NFC-e.");

	const emit = filho(inf, "emit");
	const dest = filho(inf, "dest");
	const tot = filho(filho(inf, "total"), "ICMSTot");
	const pag = filho(inf, "pag");
	const adic = filho(inf, "infAdic");
	const supl = primeiro(raiz, "infNFeSupl");
	const prot = primeiro(raiz, "infProt");

	const chave = atributo(inf, "Id")?.replace(/^NFe/, "") ?? "";
	const homologacao = texto(ide, "tpAmb") === "2";
	const contingencia = texto(ide, "tpEmis") === "9";
	const protocolo = texto(prot, "nProt") ?? null;
	const autorizadaEm = texto(prot, "dhRecbto") ?? null;
	const pendente = contingencia && !protocolo;
	const via = contingencia && opcoes.via === "estabelecimento" ? "estabelecimento" : "consumidor";
	const dizeresDeContingencia: Linha[] = [linha("EMITIDA EM CONTINGÊNCIA", "centro", true, "dobrado"), linha("Pendente de autorização", "centro", true)];
	const emitidaEm = texto(ide, "dhEmi") ?? "";

	// ----- I: cabeçalho -----
	const docEmit = texto(emit, "CNPJ") ?? texto(emit, "CPF") ?? "";
	const cabecalho: Linha[] = [
		linha(texto(emit, "xNome") ?? "", "centro", true),
		linha(`${docEmit.length === 11 ? "CPF" : "CNPJ"}: ${documento(docEmit)}`, "centro"),
		linha(endereco(filho(emit, "enderEmit")), "centro"),
		linha("Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica", "centro", true),
	];
	if (pendente) cabecalho.push(SEPARADOR, ...dizeresDeContingencia, SEPARADOR);

	// ----- II: itens -----
	const dets = filhos(inf, "det");
	const itens: Linha[] = dets.map((det, i): Linha => {
		const prod = filho(det, "prod");
		const q = numero(texto(prod, "qCom"));
		const unitario = numero(texto(prod, "vUnCom"));
		const total = numero(texto(prod, "vProd"));
		return {
			tipo: "item",
			numero: i + 1,
			codigo: texto(prod, "cProd") ?? "",
			descricao: texto(prod, "xProd") ?? "",
			quantidade: q,
			unidade: texto(prod, "uCom") ?? "",
			valorUnitario: unitario,
			valorTotal: total,
			quantidadeTexto: quantidade(q),
			valorUnitarioTexto: dinheiro(unitario),
			valorTotalTexto: dinheiro(total),
		};
	});

	// ----- III: totais e pagamentos -----
	const vProd = numero(texto(tot, "vProd"));
	const vNF = numero(texto(tot, "vNF"));
	const acrescimos = numero(texto(tot, "vFrete")) + numero(texto(tot, "vSeg")) + numero(texto(tot, "vOutro"));
	const descontos = numero(texto(tot, "vDesc"));
	const totais: Linha[] = [par("Qtde. total de itens", String(dets.length)), par("Valor total R$", dinheiro(vProd))];
	// As linhas de acréscimo, desconto e valor a pagar só existem quando há acréscimo ou desconto.
	if (acrescimos > 0) totais.push(par("Acréscimos R$", dinheiro(acrescimos)));
	if (descontos > 0) totais.push(par("Desconto R$", dinheiro(descontos)));
	if (acrescimos > 0 || descontos > 0) totais.push(par("Valor a Pagar R$", dinheiro(vNF), true));
	totais.push(par("FORMA PAGAMENTO", "VALOR PAGO R$"));
	for (const p of filhos(pag, "detPag")) {
		const forma = texto(p, "tPag") ?? "";
		totais.push(par(forma === "99" ? (texto(p, "xPag") ?? "Outros") : (FORMAS[forma] ?? `Forma ${forma}`), dinheiro(numero(texto(p, "vPag")))));
	}
	const troco = numero(texto(pag, "vTroco"));
	if (troco > 0) totais.push(par("Troco R$", dinheiro(troco)));

	// ----- IV: consulta pela chave -----
	const urlConsulta = texto(supl, "urlChave") ?? "";
	const consulta: Linha[] = [linha("Consulte pela Chave de Acesso em", "centro", true), linha(urlConsulta, "centro"), { tipo: "chave", chave }];

	// ----- VI: consumidor -----
	const consumidor: Linha[] = [];
	const cnpj = texto(dest, "CNPJ");
	const cpf = texto(dest, "CPF");
	const estrangeiro = texto(dest, "idEstrangeiro");
	if (cnpj) consumidor.push(linha(`CONSUMIDOR CNPJ: ${documento(cnpj)}`, "centro", true));
	else if (cpf) consumidor.push(linha(`CONSUMIDOR CPF: ${documento(cpf)}`, "centro", true));
	else if (estrangeiro) consumidor.push(linha(`CONSUMIDOR Id. Estrangeiro: ${estrangeiro}`, "centro", true));
	else consumidor.push(linha("CONSUMIDOR NÃO IDENTIFICADO", "centro", true));
	// Em homologação o nome do destinatário é o texto padrão do ambiente: não é o nome do consumidor.
	const nomeConsumidor = homologacao ? undefined : texto(dest, "xNome");
	if (nomeConsumidor) consumidor.push(linha(nomeConsumidor, "centro"));
	const enderecoConsumidor = endereco(filho(dest, "enderDest"));
	if (enderecoConsumidor) consumidor.push(linha(enderecoConsumidor, "centro"));

	// ----- VII: identificação e protocolo -----
	const identificacao: Linha[] = [
		linha(`NFC-e n. ${texto(ide, "nNF") ?? ""} Série ${texto(ide, "serie") ?? ""} ${dataHora(emitidaEm)}`, "centro", true),
		linha(via === "estabelecimento" ? "Via do Estabelecimento" : "Via Consumidor", "centro"),
	];
	if (pendente) identificacao.push(...dizeresDeContingencia);
	else if (protocolo) {
		identificacao.push(linha(`Protocolo de autorização: ${protocolo}`, "centro"), linha(`Data de autorização ${dataHora(autorizadaEm ?? undefined)}`, "centro"));
	}

	// ----- V: QR Code -----
	const qrCode = texto(supl, "qrCode") ?? "";

	// ----- VIII: mensagem fiscal -----
	const fiscal: Linha[] = [];
	if (homologacao) fiscal.push(linha(HOMOLOGACAO, "centro", true));
	const infAdFisco = texto(adic, "infAdFisco");
	if (infAdFisco) fiscal.push(linha(infAdFisco, "esquerda"));

	// ----- IX: mensagem do contribuinte -----
	const contribuinte: Linha[] = [];
	const tributos = texto(tot, "vTotTrib");
	if (tributos) contribuinte.push(par("Tributos Totais Incidentes (Lei Federal 12.741/2012) R$", dinheiro(numero(tributos))));
	const infCpl = texto(adic, "infCpl");
	if (infCpl) contribuinte.push(linha(infCpl, "esquerda"));

	const secoes: Secao[] = [
		{ divisao: "cabecalho", linhas: cabecalho },
		{ divisao: "itens", linhas: itens },
		{ divisao: "totais", linhas: totais },
		{ divisao: "consulta", linhas: consulta },
		{ divisao: "consumidor", linhas: consumidor },
		{ divisao: "identificacao", linhas: identificacao },
		{ divisao: "qrcode", linhas: [{ tipo: "qrcode", texto: qrCode, tamanhoMinimoMm: 25 }] },
		{ divisao: "mensagem_fiscal", linhas: fiscal },
		{ divisao: "mensagem_contribuinte", linhas: contribuinte },
	];

	return {
		modelo: "nfce",
		chaveAcesso: chave,
		ambiente: homologacao ? "homologacao" : "producao",
		contingencia,
		pendenteDeAutorizacao: pendente,
		via,
		numero: numero(texto(ide, "nNF")),
		serie: numero(texto(ide, "serie")),
		emitidaEm,
		protocolo,
		autorizadaEm,
		valorAPagar: vNF,
		qrCode,
		urlConsulta,
		// Seções vazias (por exemplo, sem mensagem do contribuinte) não vão.
		secoes: secoes.filter((s) => s.linhas.length > 0),
	};
}
