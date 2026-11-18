// Dados fiscais: tudo aqui muda por publicação do governo, não por decisão de
// código. É a área que o monitor de IA pode atualizar sozinho quando os testes
// passam (ver plano: "atualização por risco").

import nfeAmbienteNacional from "./nfe-ambiente-nacional.json";
import nfeAutorizadores from "./nfe-autorizadores.json";
import nfeStatus from "./nfe-status-homologacao.json";
import nfse from "./nfse-nacional.json";

export type Ambiente = "producao" | "homologacao";

/** Leiautes da DPS que a API sabe gerar. */
export type LeiauteDps = "1.01" | "1.01-nt009";

export type PerfilAssinatura = "rsa-sha1" | "rsa-sha256";

export interface NfseAmbiente {
	/** Base da API SEFIN Nacional (emissão, consulta e eventos). */
	sefin: string;
	/** Host do Ambiente de Dados Nacional (parametrização municipal, distribuição). */
	adn: string;
	leiaute: LeiauteDps;
	/** Pasta dos XSD oficiais em schemas/nfse/. */
	schemas: string;
}

export const NFSE_NACIONAL = nfse as {
	assinatura: PerfilAssinatura;
	ambientes: Record<Ambiente, NfseAmbiente>;
};

export function nfseAmbiente(ambiente: Ambiente): NfseAmbiente {
	return NFSE_NACIONAL.ambientes[ambiente];
}

// ---------- NF-e / NFC-e: autorizadores ----------

export type ServicoNfe = "autorizacao" | "retAutorizacao" | "consulta" | "status" | "evento" | "inutilizacao";

export interface Autorizador {
	nome: string;
	servicos: Record<ServicoNfe, string>;
	/** Só na NFC-e: endereços do QR Code e da consulta por chave da UF. */
	nfce?: { qrCode: string; urlChave: string };
}

/** A inutilização de numeração ainda existe para o modelo na UF? */
export function temInutilizacao(modelo: "55" | "65", uf: string): boolean {
	return !AUTORIZADORES[modelo].semInutilizacao?.includes(uf);
}

type Enderecos = Record<Ambiente, Record<ServicoNfe, string>>;
interface TabelaDoModelo {
	ufs: Record<string, string>;
	autorizadores: Record<string, Enderecos>;
	nfce?: Record<string, Record<Ambiente, { qrCode: string; urlChave: string }>>;
	/** UFs em que a inutilização de numeração deixou de existir. */
	semInutilizacao?: string[];
}
const AUTORIZADORES = nfeAutorizadores as unknown as Record<"55" | "65", TabelaDoModelo>;

/** Quem autoriza o modelo para a UF (sigla) no ambiente. Null se a UF ainda não é atendida. */
export function autorizadorNfe(modelo: "55" | "65", uf: string, ambiente: Ambiente): Autorizador | null {
	const tabela = AUTORIZADORES[modelo];
	const nome = tabela.ufs[uf];
	const servicos = nome ? tabela.autorizadores[nome]?.[ambiente] : undefined;
	if (!nome || !servicos) return null;
	if (modelo === "55") return { nome, servicos };
	const consulta = tabela.nfce?.[uf];
	if (!consulta) return null;
	return { nome, servicos, nfce: consulta[ambiente] };
}

/** UFs em que o cofre emite o modelo. */
export function ufsAtendidas(modelo: "55" | "65"): string[] {
	const tabela = AUTORIZADORES[modelo];
	return Object.keys(tabela.ufs)
		.filter((uf) => modelo === "55" || tabela.nfce?.[uf])
		.sort();
}

// ---------- NF-e: Ambiente Nacional (distribuição de DF-e e manifestação) ----------

export interface AmbienteNacional {
	/** NFeDistribuicaoDFe: notas e eventos de interesse do titular. */
	distribuicao: string;
	/** RecepcaoEvento 4.00: manifestação do destinatário. */
	evento: string;
}

export function ambienteNacional(ambiente: Ambiente): AmbienteNacional {
	return (nfeAmbienteNacional as unknown as Record<Ambiente, AmbienteNacional>)[ambiente];
}

// ---------- NF-e / NFC-e: serviço de status em homologação (tabela parcial) ----------

export interface AutorizadorStatus {
	autorizador: string;
	/** Códigos IBGE das UFs atendidas. */
	ufs: string[];
	status: string;
	/** O endereço já respondeu em teste real com certificado A1? */
	verificado: boolean;
}

const STATUS_HOMOLOGACAO = nfeStatus as unknown as Record<"nfe" | "nfce", AutorizadorStatus[]>;

/** Quem atende a UF (código IBGE de 2 dígitos) no serviço de status de homologação. */
export function statusHomologacao(modelo: "nfe" | "nfce", cUF: string): AutorizadorStatus | null {
	return STATUS_HOMOLOGACAO[modelo].find((a) => a.ufs.includes(cUF)) ?? null;
}
