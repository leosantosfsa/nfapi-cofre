// Monta o XML da DPS (Declaração de Prestação de Serviços), que a SEFIN
// Nacional converte em NFS-e.
//
// A ordem das tags segue os XSD oficiais em schemas/nfse.
// Há dois leiautes em vigor: o de produção ("1.01") e o da NT 009
// ("1.01-nt009"), já exigido no ambiente de testes. As diferenças estão
// marcadas com `nt009` abaixo e os testes validam os dois contra os XSD.

import type { Ambiente, LeiauteDps } from "../fiscal/dados";
import type { NfseInput } from "./schema";

export const NAMESPACE = "http://www.sped.fazenda.gov.br/nfse";

export interface DpsContexto {
	ambiente: Ambiente;
	leiaute: LeiauteDps;
	/** Titular do certificado: é quem emite e assina a DPS. */
	emitente: { tipo: "cnpj" | "cpf"; numero: string };
	/** Número da DPS já definido (informado pelo cliente ou reservado pela API). */
	numero: number;
	/** Identificação do aplicativo emissor (até 20 caracteres). */
	versaoAplicativo: string;
	agora?: Date;
}

export interface DpsMontada {
	xml: string;
	/** Atributo Id de infDPS: "DPS" + município + tipo + inscrição + série + número. */
	id: string;
	dataEmissao: string;
}

const SIMPLES = { nao_optante: "1", mei: "2", me_epp: "3" } as const;
const TRIB_ISSQN = { tributavel: "1", imunidade: "2", exportacao: "3", nao_incidencia: "4" } as const;
const RETENCAO_ISSQN = { nao_retido: "1", retido_tomador: "2", retido_intermediario: "3" } as const;

function escapar(valor: string): string {
	return (
		valor
			// Caracteres de controle não são permitidos em XML 1.0.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: remoção intencional
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
	);
}

/** Tag com texto; devolve "" quando o valor não foi informado. */
export function tag(nome: string, valor: string | number | undefined): string {
	if (valor === undefined || valor === "") return "";
	return `<${nome}>${escapar(String(valor))}</${nome}>`;
}

/** Tag que agrupa outras; some se não tiver conteúdo. */
export function grupo(nome: string, ...filhos: string[]): string {
	const conteudo = filhos.join("");
	return conteudo ? `<${nome}>${conteudo}</${nome}>` : "";
}

/** Valores e percentuais da DPS sempre com duas casas decimais. */
function decimal(valor: number | undefined): string | undefined {
	return valor === undefined ? undefined : valor.toFixed(2);
}

/** AAAA-MM-DDThh:mm:ss-03:00 (horário de Brasília), como a DPS exige. */
export function agoraEmBrasilia(agora: Date): string {
	const local = new Date(agora.getTime() - 3 * 3_600_000);
	return `${local.toISOString().slice(0, 19)}-03:00`;
}

/** Remove frações de segundo e troca "Z" por "+00:00". */
function normalizarDataHora(valor: string): string {
	return valor.replace(/\.\d+/, "").replace(/Z$/, "+00:00");
}

export function idDps(
	codigoMunicipio: string,
	emitente: DpsContexto["emitente"],
	serie: string,
	numero: number,
): string {
	const tipo = emitente.tipo === "cnpj" ? "2" : "1";
	return `DPS${codigoMunicipio}${tipo}${emitente.numero.padStart(14, "0")}${serie.padStart(5, "0")}${String(numero).padStart(15, "0")}`;
}

function endereco(e: NonNullable<NonNullable<NfseInput["tomador"]>["endereco"]>): string {
	return grupo(
		"end",
		grupo("endNac", tag("cMun", e.codigoMunicipio), tag("CEP", e.cep)),
		tag("xLgr", e.logradouro),
		tag("nro", e.numero),
		tag("xCpl", e.complemento),
		tag("xBairro", e.bairro),
	);
}

function totalTributos(t: NfseInput["tributacao"]["totalTributos"]): string {
	switch (t.tipo) {
		case "nao_informado":
			return grupo("totTrib", tag("indTotTrib", "0"));
		case "percentual_simples":
			return grupo("totTrib", tag("pTotTribSN", decimal(t.percentual)));
		case "valores":
			return grupo(
				"totTrib",
				grupo(
					"vTotTrib",
					tag("vTotTribFed", decimal(t.federal)),
					tag("vTotTribEst", decimal(t.estadual)),
					tag("vTotTribMun", decimal(t.municipal)),
				),
			);
		case "percentuais":
			return grupo(
				"totTrib",
				grupo(
					"pTotTrib",
					tag("pTotTribFed", decimal(t.federal)),
					tag("pTotTribEst", decimal(t.estadual)),
					tag("pTotTribMun", decimal(t.municipal)),
				),
			);
	}
}

export function montarDps(input: NfseInput, ctx: DpsContexto): DpsMontada {
	const nt009 = ctx.leiaute === "1.01-nt009";
	const dataEmissao = input.dataEmissao
		? normalizarDataHora(input.dataEmissao)
		: agoraEmBrasilia(ctx.agora ?? new Date());
	const id = idDps(input.prestador.codigoMunicipio, ctx.emitente, input.serie, ctx.numero);
	const { prestador, tomador, servico, valores, tributacao } = input;
	const regime = prestador.regimeTributario;
	const fed = tributacao.federal;
	const pc = fed?.pisCofins;

	const prest = grupo(
		"prest",
		tag(ctx.emitente.tipo === "cnpj" ? "CNPJ" : "CPF", ctx.emitente.numero),
		tag("IM", prestador.inscricaoMunicipal),
		// Nome e endereço do prestador não vão na DPS quando ele é o emitente:
		// a SEFIN usa os dados do cadastro nacional.
		tag("fone", prestador.telefone),
		tag("email", prestador.email),
		grupo(
			"regTrib",
			tag("opSimpNac", SIMPLES[regime.simplesNacional]),
			tag("regApTribSN", regime.apuracaoSimples),
			tag("regEspTrib", regime.regimeEspecial),
		),
	);

	const toma = tomador
		? grupo(
				"toma",
				tag("CNPJ", tomador.cnpj),
				tag("CPF", tomador.cpf),
				tag("IM", tomador.inscricaoMunicipal),
				tag("xNome", tomador.nome),
				tomador.endereco ? endereco(tomador.endereco) : "",
				tag("fone", tomador.telefone),
				tag("email", tomador.email),
			)
		: "";

	const descricao = tag("xDescServ", servico.descricao);
	const codigos = tag("cNBS", servico.codigoNbs) + tag("cIntContrib", servico.codigoInterno);
	const serv = grupo(
		"serv",
		grupo("locPrest", tag("cLocPrestacao", servico.codigoMunicipioPrestacao)),
		grupo(
			"cServ",
			tag("cTribNac", servico.codigoTributacaoNacional),
			tag("cTribMun", servico.codigoTributacaoMunicipal),
			// nt009: a descrição passou para o fim do grupo.
			nt009 ? codigos + descricao : descricao + codigos,
		),
		grupo("infoCompl", tag("xInfComp", servico.informacoesComplementares)),
	);

	const vals = grupo(
		"valores",
		grupo("vServPrest", tag("vServ", decimal(valores.servico))),
		grupo(
			"vDescCondIncond",
			tag("vDescIncond", decimal(valores.descontoIncondicionado)),
			tag("vDescCond", decimal(valores.descontoCondicionado)),
		),
		grupo(
			"trib",
			grupo(
				"tribMun",
				tag("tribISSQN", TRIB_ISSQN[tributacao.issqn.tipo]),
				tag("tpImunidade", tributacao.issqn.tipoImunidade),
				tag("tpRetISSQN", RETENCAO_ISSQN[tributacao.issqn.retencao]),
				tag("pAliq", decimal(tributacao.issqn.aliquota)),
			),
			grupo(
				"tribFed",
				pc
					? grupo(
							"piscofins",
							tag("CST", pc.cst),
							tag("vBCPisCofins", decimal(pc.baseCalculo)),
							tag("pAliqPis", decimal(pc.aliquotaPis)),
							tag("pAliqCofins", decimal(pc.aliquotaCofins)),
							tag("vPis", decimal(pc.valorPis)),
							tag("vCofins", decimal(pc.valorCofins)),
							tag("tpRetPisCofins", pc.retencao),
						)
					: "",
				tag("vRetCP", decimal(fed?.retencaoCp)),
				tag("vRetIRRF", decimal(fed?.retencaoIrrf)),
				tag("vRetCSLL", decimal(fed?.retencaoCsll)),
			),
			totalTributos(tributacao.totalTributos),
		),
	);

	const infDps =
		tag("tpAmb", ctx.ambiente === "producao" ? "1" : "2") +
		tag("dhEmi", dataEmissao) +
		tag("verAplic", ctx.versaoAplicativo.slice(0, 20)) +
		tag("serie", input.serie) +
		tag("nDPS", ctx.numero) +
		tag("dCompet", input.dataCompetencia ?? dataEmissao.slice(0, 10)) +
		// tpEmit 1: o prestador é o emitente da DPS.
		tag("tpEmit", "1") +
		// nt009: finalidade da NFS-e passou a ser campo obrigatório de infDPS (0 = regular).
		(nt009 ? tag("finNFSe", "0") : "") +
		tag("cLocEmi", prestador.codigoMunicipio) +
		prest +
		toma +
		serv +
		vals;

	const xml = `<DPS xmlns="${NAMESPACE}" versao="1.01"><infDPS Id="${id}">${infDps}</infDPS></DPS>`;
	return { xml, id, dataEmissao };
}
