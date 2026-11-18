// Resumo fiscal de uma nota, lido do XML arquivado: natureza da operação, CFOP
// e os totais de impostos. É o que os relatórios e a planilha da exportação
// somam. Nada aqui conhece banco ou rede.

import { type No, filho, filhos, primeiro, raizDoXml, texto } from "../danfe/leitura";

export interface ValoresFiscais {
	/** Valor total do documento (vNF na NF-e e na NFC-e; valor líquido na NFS-e). */
	total: number;
	produtos: number;
	servicos: number;
	desconto: number;
	frete: number;
	seguro: number;
	outras: number;
	icms: number;
	icmsSt: number;
	fcp: number;
	ipi: number;
	pis: number;
	cofins: number;
	ii: number;
	iss: number;
	ibs: number;
	cbs: number;
	is: number;
}

export interface ResumoFiscal {
	/** Natureza da operação (NF-e, NFC-e) ou o código de tributação nacional do serviço (NFS-e). */
	natureza: string | null;
	/** Valor dos itens por CFOP (NF-e e NFC-e). */
	cfops: { cfop: string; valor: number }[];
	valores: ValoresFiscais;
	destinatario: { documento: string | null; nome: string | null; uf: string | null } | null;
	/** Data de emissão que está no XML. */
	emitidaEm: string | null;
}

export const VALORES_ZERADOS: ValoresFiscais = {
	total: 0, produtos: 0, servicos: 0, desconto: 0, frete: 0, seguro: 0, outras: 0,
	icms: 0, icmsSt: 0, fcp: 0, ipi: 0, pis: 0, cofins: 0, ii: 0, iss: 0, ibs: 0, cbs: 0, is: 0,
};

const n = (pai: No | undefined, nome: string) => {
	const v = Number(texto(pai, nome) ?? 0);
	return Number.isFinite(v) ? v : 0;
};
const centavos = (v: number) => Math.round(v * 100) / 100;
const quem = (no: No | undefined) =>
	no ? { documento: texto(no, "CNPJ") ?? texto(no, "CPF") ?? texto(no, "idEstrangeiro") ?? texto(no, "NIF") ?? null, nome: texto(no, "xNome") ?? null } : null;

function daNfe(inf: No): ResumoFiscal {
	const ide = filho(inf, "ide");
	const total = filho(inf, "total");
	const tot = filho(total, "ICMSTot");
	const rtc = filho(total, "IBSCBSTot");
	const dest = filho(inf, "dest");
	const porCfop = new Map<string, number>();
	for (const det of filhos(inf, "det")) {
		const prod = filho(det, "prod");
		const cfop = texto(prod, "CFOP");
		if (cfop) porCfop.set(cfop, (porCfop.get(cfop) ?? 0) + n(prod, "vProd"));
	}
	const d = quem(dest);
	return {
		natureza: texto(ide, "natOp") ?? null,
		cfops: [...porCfop].map(([cfop, valor]) => ({ cfop, valor: centavos(valor) })).sort((a, b) => a.cfop.localeCompare(b.cfop)),
		valores: {
			...VALORES_ZERADOS,
			total: n(tot, "vNF"), produtos: n(tot, "vProd"), desconto: n(tot, "vDesc"), frete: n(tot, "vFrete"), seguro: n(tot, "vSeg"), outras: n(tot, "vOutro"),
			icms: n(tot, "vICMS"), icmsSt: n(tot, "vST"), fcp: centavos(n(tot, "vFCP") + n(tot, "vFCPST")), ipi: n(tot, "vIPI"), pis: n(tot, "vPIS"), cofins: n(tot, "vCOFINS"), ii: n(tot, "vII"),
			// Regime normal: grupos gIBS e gCBS. Simples Nacional: gTribSN.
			ibs: centavos(n(filho(rtc, "gIBS"), "vIBS") + n(filho(rtc, "gTribSN"), "vIBSSN")),
			cbs: centavos(n(filho(rtc, "gCBS"), "vCBS") + n(filho(rtc, "gTribSN"), "vCBSSN")),
			is: n(filho(total, "ISTot"), "vIS"),
		},
		destinatario: d ? { ...d, uf: texto(filho(dest, "enderDest"), "UF") ?? null } : null,
		emitidaEm: texto(ide, "dhEmi") ?? null,
	};
}

function daNfse(raiz: No): ResumoFiscal {
	const nfse = primeiro(raiz, "infNFSe");
	const dps = primeiro(raiz, "infDPS");
	const valoresDaNota = filho(nfse, "valores");
	const valoresDaDps = filho(dps, "valores");
	const servico = n(filho(valoresDaDps, "vServPrest"), "vServ");
	const descontos = filho(valoresDaDps, "vDescCondIncond");
	const toma = filho(dps, "toma");
	const d = quem(toma);
	const codigo = texto(primeiro(dps, "cServ"), "cTribNac");
	return {
		natureza: codigo ? `Serviço ${codigo}` : null,
		cfops: [],
		valores: {
			...VALORES_ZERADOS,
			total: valoresDaNota && texto(valoresDaNota, "vLiq") ? n(valoresDaNota, "vLiq") : servico,
			servicos: servico,
			desconto: centavos(n(descontos, "vDescIncond") + n(descontos, "vDescCond")),
			iss: n(valoresDaNota, "vISSQN"),
		},
		destinatario: d ? { ...d, uf: texto(primeiro(toma, "endNac"), "UF") ?? null } : null,
		emitidaEm: texto(dps, "dhEmi") ?? null,
	};
}

/** Resumo fiscal do XML de uma NF-e, NFC-e (com ou sem protocolo) ou NFS-e; null quando o XML não é uma nota. */
export function resumoFiscal(xml: string): ResumoFiscal | null {
	const raiz = raizDoXml(xml);
	const inf = primeiro(raiz, "infNFe");
	if (inf) return daNfe(inf);
	if (raiz && (primeiro(raiz, "infNFSe") || primeiro(raiz, "infDPS"))) return daNfse(raiz);
	return null;
}

/** Soma dois conjuntos de valores, campo a campo. */
export function somarValores(a: ValoresFiscais, b: Partial<ValoresFiscais> | undefined): ValoresFiscais {
	const saida = { ...a };
	for (const campo of Object.keys(VALORES_ZERADOS) as (keyof ValoresFiscais)[]) saida[campo] = centavos(saida[campo] + (b?.[campo] ?? 0));
	return saida;
}
