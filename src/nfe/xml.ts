// Monta o XML da NF-e (modelo 55) e da NFC-e (modelo 65), leiaute 4.00.
//
// A ordem das tags segue os XSD oficiais em schemas/nfe; os testes em
// test-node/nfe.test.ts validam cada grupo contra eles. Os impostos vêm
// calculados no pedido: aqui só há formatação e a soma dos totais.

import type { Ambiente } from "../fiscal/dados";
import { grupo, tag } from "../nfse/dps";
import { CODIGO_UF, type Modelo, dataHoraNaUf, montarChave } from "./chave";
import type { NfeInput, PedidoNfe } from "./schema";

export const NAMESPACE_NFE = "http://www.portalfiscal.inf.br/nfe";

/** Textos que o leiaute exige nos documentos emitidos em homologação. */
const HOMOLOGACAO_DEST = "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
const HOMOLOGACAO_ITEM = "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";

export interface NfeContexto {
	ambiente: Ambiente;
	/** CNPJ do emitente (titular do certificado ou filial de mesma raiz). */
	cnpj: string;
	serie: number;
	numero: number;
	/** Código numérico aleatório da chave (8 dígitos). */
	cNF: string;
	/** Identificação do aplicativo emissor (verProc, até 20 caracteres). */
	versaoAplicativo: string;
	/**
	 * Emissão em contingência offline (tpEmis 9): quando o emitente entrou em
	 * contingência (dhCont) e por quê (xJust, 15 a 256 caracteres).
	 */
	contingencia?: { desde: string; justificativa: string };
	/** Data de emissão já fixada: a nota em contingência reemitida não muda de data. */
	dataEmissao?: string;
	agora?: Date;
}

export interface NfeMontada {
	xml: string;
	chave: string;
	dataEmissao: string;
	/** Valor total da nota (vNF). */
	total: number;
}

type Item = PedidoNfe["itens"][number];
type Icms = Item["impostos"]["icms"];

const CRT = { simples_nacional: "1", simples_excesso: "2", normal: "3", mei: "4" } as const;
const FINALIDADE = { normal: "1", complementar: "2", ajuste: "3", devolucao: "4" } as const;
const PRESENCA = {
	nao_se_aplica: "0", presencial: "1", internet: "2", teleatendimento: "3",
	entrega_domicilio: "4", presencial_fora: "5", outros: "9",
} as const;
const IND_IE = { contribuinte: "1", isento: "2", nao_contribuinte: "9" } as const;
const DESTINO = { interna: "1", interestadual: "2", exterior: "3" } as const;

/** Centavos, para somar sem erro de ponto flutuante. */
const cent = (v: number | undefined) => Math.round((v ?? 0) * 100);
const d2 = (v: number | undefined) => (v === undefined ? undefined : v.toFixed(2));
const d3 = (v: number | undefined) => (v === undefined ? undefined : v.toFixed(3));
/** Até `casas` decimais, sem zeros sobrando, mas com no mínimo `minimo`. */
function dec(v: number | undefined, casas: number, minimo: number): string | undefined {
	if (v === undefined) return undefined;
	const [inteiro, fracao = ""] = v.toFixed(casas).split(".");
	return `${inteiro}.${fracao.replace(/0+$/, "").padEnd(minimo, "0")}`;
}
const pc = (v: number | undefined) => dec(v, 4, 2);
const qtd = (v: number | undefined) => dec(v, 4, 2);
const unit = (v: number | undefined) => dec(v, 10, 2);
const normalizarDataHora = (v: string) => v.replace(/\.\d+/, "").replace(/Z$/, "+00:00");

/** Somatórios do grupo ICMSTot, em centavos. */
interface Totais {
	vBC: number; vICMS: number; vICMSDeson: number; vFCPUFDest: number; vICMSUFDest: number; vFCP: number;
	vBCST: number; vST: number; vFCPST: number; vFCPSTRet: number; vProd: number; vFrete: number; vSeg: number;
	vDesc: number; vII: number; vIPI: number; vPIS: number; vCOFINS: number; vOutro: number; vTotTrib: number;
	/** Desoneração que reduz o valor da nota (indDeduzDeson = 1). */
	deduzido: number;
	temDifal: boolean; temTotTrib: boolean;
	/** IBS e CBS: há o grupo em algum item, e há valores calculados? */
	temIbsCbs: boolean; temValoresIbsCbs: boolean;
	/** Há Imposto Seletivo, estorno de crédito ou IBS/CBS do Simples em algum item? */
	temIs: boolean; temEstorno: boolean; temSimples: boolean;
	/** Totais da reforma tributária, por nome de campo (vBC, vIBSUF, vDifCBS, vCredPresIBS, vIS...). */
	rtc: Record<string, number>;
}

function grupoIcms(i: Icms, t: Totais): string {
	const proprio = (comReducaoAntes: boolean) => {
		t.vBC += cent(i.baseCalculo);
		t.vICMS += cent(i.valor);
		return (
			tag("modBC", i.modalidadeBc ?? 3) +
			(comReducaoAntes ? tag("pRedBC", pc(i.reducaoBc ?? 0)) : "") +
			tag("vBC", d2(i.baseCalculo ?? 0)) +
			(comReducaoAntes ? "" : tag("pRedBC", pc(i.reducaoBc))) +
			tag("pICMS", pc(i.aliquota ?? 0)) +
			tag("vICMS", d2(i.valor ?? 0))
		);
	};
	const fcp = (comBase: boolean) => {
		if (!i.fcp) return "";
		t.vFCP += cent(i.fcp.valor);
		return (comBase ? tag("vBCFCP", d2(i.fcp.baseCalculo ?? i.baseCalculo ?? 0)) : "") + tag("pFCP", pc(i.fcp.aliquota)) + tag("vFCP", d2(i.fcp.valor));
	};
	const st = () => {
		const s = i.st;
		if (!s) return "";
		t.vBCST += cent(s.baseCalculo);
		t.vST += cent(s.valor);
		t.vFCPST += cent(s.fcp?.valor);
		return (
			tag("modBCST", s.modalidadeBc) + tag("pMVAST", pc(s.mva)) + tag("pRedBCST", pc(s.reducaoBc)) +
			tag("vBCST", d2(s.baseCalculo)) + tag("pICMSST", pc(s.aliquota)) + tag("vICMSST", d2(s.valor)) +
			(s.fcp ? tag("vBCFCPST", d2(s.fcp.baseCalculo ?? s.baseCalculo)) + tag("pFCPST", pc(s.fcp.aliquota)) + tag("vFCPST", d2(s.fcp.valor)) : "")
		);
	};
	const desoneracao = () => {
		if (!i.desoneracao) return "";
		t.vICMSDeson += cent(i.desoneracao.valor);
		if (i.desoneracao.deduzDoTotal) t.deduzido += cent(i.desoneracao.valor);
		return (
			tag("vICMSDeson", d2(i.desoneracao.valor)) + tag("motDesICMS", i.desoneracao.motivo) +
			tag("indDeduzDeson", i.desoneracao.deduzDoTotal ? "1" : undefined)
		);
	};
	const retido = () => {
		const r = i.retidoAnteriormente;
		if (!r) return "";
		t.vFCPSTRet += cent(r.fcp?.valor);
		return (
			tag("vBCSTRet", d2(r.baseCalculo)) + tag("pST", pc(r.aliquotaConsumidorFinal)) +
			tag("vICMSSubstituto", d2(r.valorSubstituto)) + tag("vICMSSTRet", d2(r.valor)) +
			(r.fcp ? tag("vBCFCPSTRet", d2(r.fcp.baseCalculo)) + tag("pFCPSTRet", pc(r.fcp.aliquota)) + tag("vFCPSTRet", d2(r.fcp.valor)) : "")
		);
	};
	const credito = () => (i.creditoSimples ? tag("pCredSN", pc(i.creditoSimples.aliquota)) + tag("vCredICMSSN", d2(i.creditoSimples.valor)) : "");
	const proprioOpcional = () => (i.baseCalculo === undefined && i.valor === undefined ? "" : proprio(false));
	const orig = tag("orig", i.origem);

	if (i.csosn) {
		const base = orig + tag("CSOSN", i.csosn);
		switch (i.csosn) {
			case "101":
				return grupo("ICMSSN101", base + tag("pCredSN", pc(i.creditoSimples?.aliquota ?? 0)) + tag("vCredICMSSN", d2(i.creditoSimples?.valor ?? 0)));
			case "201":
				return grupo("ICMSSN201", base + st() + credito());
			case "202":
			case "203":
				return grupo("ICMSSN202", base + st());
			case "500":
				return grupo("ICMSSN500", base + retido());
			case "900":
				return grupo("ICMSSN900", base + proprioOpcional() + st() + credito());
			default:
				return grupo("ICMSSN102", base);
		}
	}

	const base = orig + tag("CST", i.cst);
	switch (i.cst) {
		case "00":
			return grupo("ICMS00", base + proprio(false) + fcp(false));
		case "10":
			return grupo("ICMS10", base + proprio(false) + fcp(true) + st());
		case "20":
			return grupo("ICMS20", base + proprio(true) + fcp(true) + desoneracao());
		case "30":
			return grupo("ICMS30", base + st() + desoneracao());
		case "51": {
			t.vBC += cent(i.baseCalculo);
			t.vICMS += cent(i.valor);
			const d = i.diferimento;
			return grupo(
				"ICMS51",
				base + tag("modBC", i.modalidadeBc) + tag("pRedBC", pc(i.reducaoBc)) + tag("vBC", d2(i.baseCalculo)) +
					tag("pICMS", pc(i.aliquota)) + tag("vICMSOp", d2(d?.valorOperacao)) + tag("pDif", pc(d?.percentual)) +
					tag("vICMSDif", d2(d?.valorDiferido)) + tag("vICMS", d2(i.valor)) + fcp(true),
			);
		}
		case "60":
			return grupo("ICMS60", base + retido());
		case "70":
			return grupo("ICMS70", base + proprio(true) + fcp(true) + st() + desoneracao());
		case "90":
			return grupo("ICMS90", base + proprioOpcional() + fcp(true) + st() + desoneracao());
		default:
			return grupo("ICMS40", base + desoneracao());
	}
}

function grupoPisCofins(nome: "PIS" | "COFINS", p: NonNullable<Item["impostos"]["pis"]>): string {
	const sufixo = nome === "PIS" ? "PIS" : "COFINS";
	const valores = tag("vBC", d2(p.baseCalculo ?? 0)) + tag(`p${sufixo}`, pc(p.aliquota ?? 0)) + tag(`v${sufixo}`, d2(p.valor ?? 0));
	const cst = tag("CST", p.cst);
	if (p.cst === "01" || p.cst === "02") return grupo(nome, grupo(`${nome}Aliq`, cst + valores));
	if (/^0[4-9]$/.test(p.cst)) return grupo(nome, grupo(`${nome}NT`, cst));
	return grupo(nome, grupo(`${nome}Outr`, cst + valores));
}

function grupoIpi(ipi: NonNullable<Item["impostos"]["ipi"]>): string {
	const tributado = ["00", "49", "50", "99"].includes(ipi.cst);
	return grupo(
		"IPI",
		tag("cEnq", ipi.codigoEnquadramento) +
			(tributado
				? grupo("IPITrib", tag("CST", ipi.cst) + tag("vBC", d2(ipi.baseCalculo ?? 0)) + tag("pIPI", pc(ipi.aliquota ?? 0)) + tag("vIPI", d2(ipi.valor ?? 0)))
				: grupo("IPINT", tag("CST", ipi.cst))),
	);
}

const INTERMEDIACAO = { conta_propria: "1", conta_e_ordem: "2", encomenda: "3" } as const;

/** Declarações de importação do item (grupo DI, com as adições). */
function importacoes(item: Item): string {
	return (item.importacao ?? [])
		.map((di) =>
			grupo(
				"DI",
				tag("nDI", di.numero) + tag("dDI", di.data) + tag("xLocDesemb", di.localDesembaraco) + tag("UFDesemb", di.ufDesembaraco) +
					tag("dDesemb", di.dataDesembaraco) + tag("tpViaTransp", di.viaTransporte) + tag("vAFRMM", d2(di.afrmm)) +
					tag("tpIntermedio", INTERMEDIACAO[di.intermediacao]) + tag("CNPJ", di.adquirente?.cnpj) + tag("CPF", di.adquirente?.cpf) +
					tag("UFTerceiro", di.adquirente?.uf) + tag("cExportador", di.codigoExportador) +
					di.adicoes
						.map((a) => grupo("adi", tag("nAdicao", a.numero) + tag("nSeqAdic", a.sequencia) + tag("cFabricante", a.codigoFabricante) + tag("vDescDI", d2(a.desconto)) + tag("nDraw", a.drawback)))
						.join(""),
			),
		)
		.join("");
}

/** Dados de exportação do item (grupo detExport). */
function exportacoes(item: Item): string {
	return (item.exportacao ?? [])
		.map((e) =>
			grupo(
				"detExport",
				tag("nDraw", e.drawback) +
					(e.indireta ? grupo("exportInd", `<nRE>${e.indireta.registroExportacao}</nRE>` + tag("chNFe", e.indireta.chaveNfe) + tag("qExport", qtd(e.indireta.quantidade))) : ""),
			),
		)
		.join("");
}

function detalhe(item: Item, numero: number, t: Totais, descricao: string): string {
	const vProd = item.valorTotal ?? Math.round(item.quantidade * item.valorUnitario * 100) / 100;
	const trib = item.tributavel ?? { ean: item.ean, unidade: item.unidade, quantidade: item.quantidade, valorUnitario: item.valorUnitario };
	const imp = item.impostos;

	if (item.compoeTotal) t.vProd += cent(vProd);
	t.vFrete += cent(item.frete);
	t.vSeg += cent(item.seguro);
	t.vDesc += cent(item.desconto);
	t.vOutro += cent(item.outrasDespesas);
	t.vIPI += cent(imp.ipi?.valor);
	t.vII += cent(imp.ii?.valor);
	t.vPIS += cent(imp.pis?.valor);
	t.vCOFINS += cent(imp.cofins?.valor);
	if (imp.valorAproximadoTributos !== undefined) {
		t.temTotTrib = true;
		t.vTotTrib += cent(imp.valorAproximadoTributos);
	}
	if (imp.difal) {
		t.temDifal = true;
		t.vICMSUFDest += cent(imp.difal.valorDestino);
		t.vFCPUFDest += cent(imp.difal.fcp?.valor);
	}

	const prod = grupo(
		"prod",
		tag("cProd", item.codigo) + tag("cEAN", item.ean ?? "SEM GTIN") + tag("xProd", descricao) + tag("NCM", item.ncm) +
			tag("CEST", item.cest) + tag("cBenef", item.codigoBeneficioFiscal) + tag("CFOP", item.cfop) +
			tag("uCom", item.unidade) + tag("qCom", qtd(item.quantidade)) + tag("vUnCom", unit(item.valorUnitario)) +
			tag("vProd", d2(vProd)) + tag("cEANTrib", trib.ean ?? "SEM GTIN") + tag("uTrib", trib.unidade) +
			tag("qTrib", qtd(trib.quantidade)) + tag("vUnTrib", unit(trib.valorUnitario)) +
			tag("vFrete", item.frete ? d2(item.frete) : undefined) + tag("vSeg", item.seguro ? d2(item.seguro) : undefined) +
			tag("vDesc", item.desconto ? d2(item.desconto) : undefined) + tag("vOutro", item.outrasDespesas ? d2(item.outrasDespesas) : undefined) +
			tag("indTot", item.compoeTotal ? "1" : "0") + importacoes(item) + exportacoes(item) +
			tag("xPed", item.numeroPedido) + tag("nItemPed", item.itemPedido),
	);
	const ii = imp.ii
		? grupo("II", tag("vBC", d2(imp.ii.baseCalculo)) + tag("vDespAdu", d2(imp.ii.despesasAduaneiras)) + tag("vII", d2(imp.ii.valor)) + tag("vIOF", d2(imp.ii.iof)))
		: "";

	const difal = imp.difal
		? grupo(
				"ICMSUFDest",
				tag("vBCUFDest", d2(imp.difal.baseCalculo)) +
					(imp.difal.fcp ? tag("vBCFCPUFDest", d2(imp.difal.fcp.baseCalculo ?? imp.difal.baseCalculo)) + tag("pFCPUFDest", pc(imp.difal.fcp.aliquota)) : "") +
					tag("pICMSUFDest", pc(imp.difal.aliquotaInterna)) + tag("pICMSInter", pc(imp.difal.aliquotaInterestadual)) +
					tag("pICMSInterPart", "100.00") + tag("vFCPUFDest", imp.difal.fcp ? d2(imp.difal.fcp.valor) : undefined) +
					tag("vICMSUFDest", d2(imp.difal.valorDestino)) + tag("vICMSUFRemet", "0.00"),
			)
		: "";

	/** Acumula um total da reforma tributária (IBS, CBS e Imposto Seletivo), em centavos. */
	const soma = (chave: string, v: number | undefined) => {
		t.rtc[chave] = (t.rtc[chave] ?? 0) + cent(v);
	};

	const is = imp.impostoSeletivo;
	let seletivo = "";
	if (is) {
		t.temIs = true;
		soma("vIS", is.valor);
		seletivo = grupo(
			"IS",
			tag("CSTIS", is.cst) + tag("cClassTribIS", is.classificacao) +
				(is.baseCalculo !== undefined
					? tag("vBCIS", d2(is.baseCalculo)) + tag("pIS", pc(is.aliquota ?? 0)) + tag("adRemIS", pc(is.aliquotaEspecifica)) +
						// No Imposto Seletivo a quantidade tributável vai sempre com quatro casas decimais.
						(is.unidade && is.quantidade !== undefined ? tag("uTrib", is.unidade) + tag("qTrib", is.quantidade.toFixed(4)) : "") +
						tag("vIS", d2(is.valor ?? 0))
					: ""),
		);
	}

	const ib = imp.ibsCbs;
	let ibsCbs = "";
	if (ib) {
		t.temIbsCbs = true;
		/** gIBSUF, gIBSMun ou gCBS: a alíquota, os ajustes (diferimento, devolução, redução) e o valor. */
		const tributo = (nome: "IBSUF" | "IBSMun" | "CBS", x: typeof ib.cbs) => {
			soma(`v${nome}`, x?.valor);
			soma(`vDif${nome}`, x?.diferimento?.valor);
			soma(`vDevTrib${nome}`, x?.devolucao?.valor);
			return grupo(
				`g${nome}`,
				tag(`p${nome}`, pc(x?.aliquota ?? 0)) +
					(x?.diferimento ? grupo("gDif", tag("pDif", pc(x.diferimento.percentual)) + tag("vDif", d2(x.diferimento.valor))) : "") +
					(x?.devolucao ? grupo("gDevTrib", tag("pDevTrib", pc(x.devolucao.percentual)) + tag("vDevTrib", d2(x.devolucao.valor))) : "") +
					(x?.reducao ? grupo("gRed", tag("pRedAliq", pc(x.reducao.percentual)) + tag("pAliqEfet", pc(x.reducao.aliquotaEfetiva))) : "") +
					tag(`v${nome}`, d2(x?.valor ?? 0)),
			);
		};
		let valores = "";
		if (ib.baseCalculo !== undefined) {
			t.temValoresIbsCbs = true;
			soma("vBC", ib.baseCalculo);
			const reg = ib.tributacaoRegular;
			const gov = ib.compraGovernamental;
			valores = grupo(
				"gIBSCBS",
				tag("vBC", d2(ib.baseCalculo)) + tributo("IBSUF", ib.ibsUf) + tributo("IBSMun", ib.ibsMunicipio) +
					tag("vIBS", ((cent(ib.ibsUf?.valor) + cent(ib.ibsMunicipio?.valor)) / 100).toFixed(2)) + tributo("CBS", ib.cbs) +
					(reg
						? grupo(
								"gTribRegular",
								tag("CSTReg", reg.cst) + tag("cClassTribReg", reg.classificacao) +
									tag("pAliqEfetRegIBSUF", pc(reg.ibsUf.aliquotaEfetiva)) + tag("vTribRegIBSUF", d2(reg.ibsUf.valor)) +
									tag("pAliqEfetRegIBSMun", pc(reg.ibsMunicipio.aliquotaEfetiva)) + tag("vTribRegIBSMun", d2(reg.ibsMunicipio.valor)) +
									tag("pAliqEfetRegCBS", pc(reg.cbs.aliquotaEfetiva)) + tag("vTribRegCBS", d2(reg.cbs.valor)),
							)
						: "") +
					(gov
						? grupo(
								"gTribCompraGov",
								tag("pAliqIBSUF", pc(gov.ibsUf.aliquota)) + tag("vTribIBSUF", d2(gov.ibsUf.valor)) +
									tag("pAliqIBSMun", pc(gov.ibsMunicipio.aliquota)) + tag("vTribIBSMun", d2(gov.ibsMunicipio.valor)) +
									tag("pAliqCBS", pc(gov.cbs.aliquota)) + tag("vTribCBS", d2(gov.cbs.valor)),
							)
						: ""),
			);
		}
		const sn = ib.simplesNacional;
		if (sn) {
			t.temSimples = true;
			soma("vIBSSN", sn.ibs?.valor);
			soma("vCBSSN", sn.cbs.valor);
		}
		const estorno = ib.estornoCredito;
		if (estorno) {
			t.temEstorno = true;
			soma("vIBSEstCred", estorno.ibs);
			soma("vCBSEstCred", estorno.cbs);
		}
		const cp = ib.creditoPresumido;
		const credito = (nome: "IBS" | "CBS", c: NonNullable<typeof cp>["ibs"]) => {
			if (!c) return "";
			soma(`vCredPres${c.condicaoSuspensiva ? "CondSus" : ""}${nome}`, c.valor);
			return grupo(`g${nome}CredPres`, tag("pCredPres", pc(c.aliquota)) + tag(c.condicaoSuspensiva ? "vCredPresCondSus" : "vCredPres", d2(c.valor)));
		};
		if (cp) t.temValoresIbsCbs = true;
		ibsCbs = grupo(
			"IBSCBS",
			tag("CST", ib.cst) + tag("cClassTrib", ib.classificacao) + tag("indDoacao", ib.doacao ? "1" : undefined) + valores +
				(sn
					? grupo(
							"gTribSN",
							(sn.ibs ? grupo("gIBSSN", tag("pIBSSN", pc(sn.ibs.aliquota)) + tag("vIBSSN", d2(sn.ibs.valor))) : "") +
								grupo("gCBSSN", tag("pCBSSN", pc(sn.cbs.aliquota)) + tag("vCBSSN", d2(sn.cbs.valor))),
						)
					: "") +
				(estorno ? grupo("gEstornoCred", tag("vIBSEstCred", d2(estorno.ibs)) + tag("vCBSEstCred", d2(estorno.cbs))) : "") +
				(cp ? grupo("gCredPresOper", tag("vBCCredPres", d2(cp.baseCalculo)) + tag("cCredPres", cp.codigo) + credito("IBS", cp.ibs) + credito("CBS", cp.cbs)) : ""),
		);
	}

	const imposto = grupo(
		"imposto",
		tag("vTotTrib", d2(imp.valorAproximadoTributos)) + grupo("ICMS", grupoIcms(imp.icms, t)) +
			(imp.ipi ? grupoIpi(imp.ipi) : "") + ii + (imp.pis ? grupoPisCofins("PIS", imp.pis) : "") +
			(imp.cofins ? grupoPisCofins("COFINS", imp.cofins) : "") + difal + seletivo + ibsCbs,
	);

	return `<det nItem="${numero}">${prod}${imposto}${tag("infAdProd", item.informacoesAdicionais)}</det>`;
}

function endereco(nome: "enderEmit" | "enderDest", e: NonNullable<NfeInput["destinatario"]["endereco"]>): string {
	return grupo(
		nome,
		tag("xLgr", e.logradouro) + tag("nro", e.numero) + tag("xCpl", e.complemento) + tag("xBairro", e.bairro) +
			tag("cMun", e.codigoMunicipio) + tag("xMun", e.municipio) + tag("UF", e.uf) + tag("CEP", e.cep) +
			tag("cPais", ("codigoPais" in e ? e.codigoPais : undefined) ?? "1058") + tag("xPais", ("pais" in e ? e.pais : undefined) ?? "Brasil") + tag("fone", e.telefone),
	);
}

export function montarNfe(pedido: PedidoNfe, ctx: NfeContexto): NfeMontada {
	const nfce = pedido.modelo === "65";
	const homologacao = ctx.ambiente === "homologacao";
	const emit = pedido.emitente;
	const uf = emit.endereco.uf;
	const cUF = CODIGO_UF[uf] as string;
	const dataEmissao = normalizarDataHora(ctx.dataEmissao ?? pedido.dataEmissao ?? dataHoraNaUf(ctx.agora ?? new Date(), uf));
	// 1 = emissão normal; 9 = contingência offline da NFC-e. O tipo entra na chave.
	const tpEmis = ctx.contingencia ? "9" : "1";
	const chave = montarChave({ cUF, emissao: dataEmissao, cnpj: ctx.cnpj, modelo: pedido.modelo as Modelo, serie: ctx.serie, numero: ctx.numero, tpEmis, cNF: ctx.cNF });

	const dest = pedido.destinatario;
	const destino = nfce
		? "1"
		: (DESTINO[(pedido as NfeInput).destinoOperacao ?? (dest?.idEstrangeiro !== undefined || dest?.endereco?.uf === "EX" ? "exterior" : !dest?.endereco || dest.endereco.uf === uf ? "interna" : "interestadual")]);
	const presenca = PRESENCA[pedido.presenca];
	const semPresenca = ["2", "3", "4", "9"].includes(presenca);

	const ide = grupo(
		"ide",
		tag("cUF", cUF) + tag("cNF", ctx.cNF) + tag("natOp", pedido.naturezaOperacao) + tag("mod", pedido.modelo) +
			tag("serie", ctx.serie) + tag("nNF", ctx.numero) + tag("dhEmi", dataEmissao) +
			(nfce ? "" : tag("dhSaiEnt", (pedido as NfeInput).dataSaida ? normalizarDataHora((pedido as NfeInput).dataSaida as string) : undefined)) +
			tag("tpNF", nfce || (pedido as NfeInput).tipo === "saida" ? "1" : "0") + tag("idDest", destino) +
			tag("cMunFG", emit.endereco.codigoMunicipio) + tag("tpImp", nfce ? "4" : "1") + tag("tpEmis", tpEmis) +
			tag("cDV", chave.slice(43)) + tag("tpAmb", homologacao ? "2" : "1") + tag("finNFe", FINALIDADE[pedido.finalidade]) +
			tag("indFinal", nfce || (pedido as NfeInput).consumidorFinal ? "1" : "0") + tag("indPres", presenca) +
			(semPresenca ? tag("indIntermed", pedido.intermediador ? "1" : "0") : "") +
			tag("procEmi", "0") + tag("verProc", ctx.versaoAplicativo) +
			(ctx.contingencia ? tag("dhCont", normalizarDataHora(ctx.contingencia.desde)) + tag("xJust", ctx.contingencia.justificativa) : "") +
			(pedido.notasReferenciadas ?? []).map((c) => grupo("NFref", tag("refNFe", c))).join(""),
	);

	const emitente = grupo(
		"emit",
		tag("CNPJ", ctx.cnpj) + tag("xNome", emit.nome) + tag("xFant", emit.fantasia) + endereco("enderEmit", emit.endereco) +
			tag("IE", emit.inscricaoEstadual) + tag("IM", emit.inscricaoMunicipal) +
			tag("CNAE", emit.inscricaoMunicipal ? emit.cnae : undefined) + tag("CRT", CRT[emit.regime]),
	);

	const destinatario = dest
		? grupo(
				"dest",
				tag("CNPJ", dest.cnpj) + tag("CPF", dest.cpf) +
					(dest.idEstrangeiro !== undefined ? `<idEstrangeiro>${dest.idEstrangeiro}</idEstrangeiro>` : "") +
					tag("xNome", homologacao && dest.nome ? HOMOLOGACAO_DEST : dest.nome) +
					(dest.endereco ? endereco("enderDest", dest.endereco as NonNullable<NfeInput["destinatario"]["endereco"]>) : "") +
					tag("indIEDest", nfce ? "9" : IND_IE[dest.indicadorIe]) +
					tag("IE", nfce ? undefined : dest.inscricaoEstadual) + tag("email", dest.email),
			)
		: "";

	const t: Totais = {
		vBC: 0, vICMS: 0, vICMSDeson: 0, vFCPUFDest: 0, vICMSUFDest: 0, vFCP: 0, vBCST: 0, vST: 0, vFCPST: 0,
		vFCPSTRet: 0, vProd: 0, vFrete: 0, vSeg: 0, vDesc: 0, vII: 0, vIPI: 0, vPIS: 0, vCOFINS: 0, vOutro: 0, vTotTrib: 0,
		deduzido: 0, temDifal: false, temTotTrib: false,
		temIbsCbs: false, temValoresIbsCbs: false, temIs: false, temEstorno: false, temSimples: false, rtc: {},
	};
	const itens = pedido.itens
		.map((item, i) => detalhe(item, i + 1, t, homologacao && nfce && i === 0 ? HOMOLOGACAO_ITEM : item.descricao))
		.join("");

	const vNF = t.vProd - t.vDesc - t.deduzido + t.vST + t.vFCPST + t.vFrete + t.vSeg + t.vOutro + t.vII + t.vIPI;
	const r = (centavos: number) => (centavos / 100).toFixed(2);
	const rtc = (chave: string) => r(t.rtc[chave] ?? 0);
	const total = grupo(
		"total",
		grupo(
			"ICMSTot",
			tag("vBC", r(t.vBC)) + tag("vICMS", r(t.vICMS)) + tag("vICMSDeson", r(t.vICMSDeson)) +
				(t.temDifal ? tag("vFCPUFDest", r(t.vFCPUFDest)) + tag("vICMSUFDest", r(t.vICMSUFDest)) + tag("vICMSUFRemet", "0.00") : "") +
				tag("vFCP", r(t.vFCP)) + tag("vBCST", r(t.vBCST)) + tag("vST", r(t.vST)) + tag("vFCPST", r(t.vFCPST)) +
				tag("vFCPSTRet", r(t.vFCPSTRet)) + tag("vProd", r(t.vProd)) + tag("vFrete", r(t.vFrete)) + tag("vSeg", r(t.vSeg)) +
				tag("vDesc", r(t.vDesc)) + tag("vII", r(t.vII)) + tag("vIPI", r(t.vIPI)) + tag("vIPIDevol", "0.00") +
				tag("vPIS", r(t.vPIS)) + tag("vCOFINS", r(t.vCOFINS)) + tag("vOutro", r(t.vOutro)) + tag("vNF", r(vNF)) +
				(t.temTotTrib ? tag("vTotTrib", r(t.vTotTrib)) : ""),
		) +
			(t.temIs ? grupo("ISTot", tag("vIS", rtc("vIS"))) : "") +
			(t.temIbsCbs
				? grupo(
						"IBSCBSTot",
						tag("vBCIBSCBS", rtc("vBC")) +
							(t.temValoresIbsCbs
								? grupo(
										"gIBS",
										grupo("gIBSUF", tag("vDif", rtc("vDifIBSUF")) + tag("vDevTrib", rtc("vDevTribIBSUF")) + tag("vIBSUF", rtc("vIBSUF"))) +
											grupo("gIBSMun", tag("vDif", rtc("vDifIBSMun")) + tag("vDevTrib", rtc("vDevTribIBSMun")) + tag("vIBSMun", rtc("vIBSMun"))) +
											tag("vIBS", r((t.rtc.vIBSUF ?? 0) + (t.rtc.vIBSMun ?? 0))) +
											tag("vCredPres", rtc("vCredPresIBS")) + tag("vCredPresCondSus", rtc("vCredPresCondSusIBS")),
									) +
									grupo(
										"gCBS",
										tag("vDif", rtc("vDifCBS")) + tag("vDevTrib", rtc("vDevTribCBS")) + tag("vCBS", rtc("vCBS")) +
											tag("vCredPres", rtc("vCredPresCBS")) + tag("vCredPresCondSus", rtc("vCredPresCondSusCBS")),
									)
								: "") +
							(t.temEstorno ? grupo("gEstornoCred", tag("vIBSEstCred", rtc("vIBSEstCred")) + tag("vCBSEstCred", rtc("vCBSEstCred"))) : "") +
							(t.temSimples ? grupo("gTribSN", tag("vIBSSN", rtc("vIBSSN")) + tag("vCBSSN", rtc("vCBSSN"))) : ""),
					)
				: ""),
	);

	const tr = pedido.transporte;
	const transporte = grupo(
		"transp",
		tag("modFrete", tr.modalidade) +
			(tr.transportadora
				? grupo(
						"transporta",
						tag("CNPJ", tr.transportadora.cnpj) + tag("CPF", tr.transportadora.cpf) + tag("xNome", tr.transportadora.nome) +
							tag("IE", tr.transportadora.inscricaoEstadual) + tag("xEnder", tr.transportadora.endereco) +
							tag("xMun", tr.transportadora.municipio) + tag("UF", tr.transportadora.uf),
					)
				: "") +
			(tr.veiculo ? grupo("veicTransp", tag("placa", tr.veiculo.placa) + tag("UF", tr.veiculo.uf) + tag("RNTC", tr.veiculo.rntc)) : "") +
			(tr.volumes ?? [])
				.map((v) => grupo("vol", tag("qVol", v.quantidade) + tag("esp", v.especie) + tag("marca", v.marca) + tag("nVol", v.numeracao) + tag("pesoL", d3(v.pesoLiquido)) + tag("pesoB", d3(v.pesoBruto))))
				.join(""),
	);

	const cob = nfce ? undefined : (pedido as NfeInput).cobranca;
	const cobranca = cob
		? grupo(
				"cobr",
				(cob.fatura ? grupo("fat", tag("nFat", cob.fatura.numero) + tag("vOrig", d2(cob.fatura.valorOriginal)) + tag("vDesc", d2(cob.fatura.desconto)) + tag("vLiq", d2(cob.fatura.valorLiquido))) : "") +
					(cob.duplicatas ?? []).map((d) => grupo("dup", tag("nDup", d.numero) + tag("dVenc", d.vencimento) + tag("vDup", d2(d.valor)))).join(""),
			)
		: "";

	const pagamento = grupo(
		"pag",
		pedido.pagamentos
			.map((p) =>
				grupo(
					"detPag",
					tag("indPag", p.indicador ? (p.indicador === "a_vista" ? "0" : "1") : undefined) + tag("tPag", p.forma) +
						tag("xPag", p.forma === "99" ? p.descricao : undefined) + tag("vPag", d2(p.valor)) +
						(p.cartao
							? grupo("card", tag("tpIntegra", p.cartao.integracao === "integrado" ? "1" : "2") + tag("CNPJ", p.cartao.cnpjCredenciadora) + tag("tBand", p.cartao.bandeira) + tag("cAut", p.cartao.autorizacao))
							: ""),
				),
			)
			.join("") + tag("vTroco", pedido.troco ? d2(pedido.troco) : undefined),
	);

	const intermediador = pedido.intermediador && semPresenca
		? grupo("infIntermed", tag("CNPJ", pedido.intermediador.cnpj) + tag("idCadIntTran", pedido.intermediador.identificacao))
		: "";
	const adicionais = grupo("infAdic", tag("infAdFisco", pedido.informacoesFisco) + tag("infCpl", pedido.informacoesComplementares));
	const ex = nfce ? undefined : (pedido as NfeInput).exportacao;
	const exporta = ex ? grupo("exporta", tag("UFSaidaPais", ex.ufEmbarque) + tag("xLocExporta", ex.localEmbarque) + tag("xLocDespacho", ex.localDespacho)) : "";
	const rt = pedido.responsavelTecnico;
	const responsavel = rt ? grupo("infRespTec", tag("CNPJ", rt.cnpj) + tag("xContato", rt.contato) + tag("email", rt.email) + tag("fone", rt.telefone)) : "";

	const xml =
		`<NFe xmlns="${NAMESPACE_NFE}"><infNFe Id="NFe${chave}" versao="4.00">` +
		ide + emitente + destinatario + itens + total + transporte + cobranca + pagamento + intermediador + adicionais + exporta + responsavel +
		"</infNFe></NFe>";
	return { xml, chave, dataEmissao, total: vNF / 100 };
}

/** Acrescenta à NFC-e o grupo do QR Code, entre infNFe e a assinatura. */
export function comSuplementoNfce(xml: string, qrCode: string, urlChave: string): string {
	return xml.replace("</infNFe>", `</infNFe><infNFeSupl><qrCode><![CDATA[${qrCode}]]></qrCode><urlChave>${urlChave}</urlChave></infNFeSupl>`);
}
