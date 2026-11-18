// Chave de acesso da NF-e/NFC-e (44 posições) e utilitários de UF.
//
//   cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)

export type Modelo = "55" | "65";

/** Código IBGE de cada UF. */
export const CODIGO_UF: Record<string, string> = {
	RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17",
	MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29",
	MG: "31", ES: "32", RJ: "33", SP: "35",
	PR: "41", SC: "42", RS: "43",
	MS: "50", MT: "51", GO: "52", DF: "53",
};

/** Diferença para o UTC do horário oficial de cada UF (sem horário de verão desde 2019). */
const FUSO: Record<string, number> = { AC: -5, AM: -4, RO: -4, RR: -4, MT: -4, MS: -4 };

/** Data e hora no fuso da UF, no formato AAAA-MM-DDThh:mm:ss-03:00. */
export function dataHoraNaUf(agora: Date, uf: string): string {
	const horas = FUSO[uf] ?? -3;
	const local = new Date(agora.getTime() + horas * 3_600_000);
	return `${local.toISOString().slice(0, 19)}-0${Math.abs(horas)}:00`;
}

/**
 * Dígito verificador (módulo 11, pesos de 2 a 9 da direita para a esquerda).
 * Com o CNPJ alfanumérico, cada caractere vale o seu código ASCII menos 48:
 * dígitos continuam valendo 0 a 9 e as letras, de 17 ("A") a 42 ("Z").
 */
export function digitoVerificador(chave43: string): string {
	let soma = 0;
	let peso = 2;
	for (let i = chave43.length - 1; i >= 0; i--) {
		soma += (chave43.charCodeAt(i) - 48) * peso;
		peso = peso === 9 ? 2 : peso + 1;
	}
	const resto = soma % 11;
	return resto < 2 ? "0" : String(11 - resto);
}

export interface PartesDaChave {
	cUF: string;
	/** Data de emissão (só ano e mês entram na chave). */
	emissao: string;
	cnpj: string;
	modelo: Modelo;
	serie: number;
	numero: number;
	/** 1 = emissão normal. */
	tpEmis: string;
	/** Código numérico de 8 dígitos. */
	cNF: string;
}

export function montarChave(p: PartesDaChave): string {
	const base =
		p.cUF +
		p.emissao.slice(2, 4) +
		p.emissao.slice(5, 7) +
		p.cnpj.padStart(14, "0") +
		p.modelo +
		String(p.serie).padStart(3, "0") +
		String(p.numero).padStart(9, "0") +
		p.tpEmis +
		p.cNF;
	return base + digitoVerificador(base);
}

/** A chave tem 44 posições e o dígito verificador confere? */
export function chaveValida(chave: string): boolean {
	return /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(chave) && digitoVerificador(chave.slice(0, 43)) === chave[43];
}

/**
 * Código numérico aleatório da chave. O leiaute recusa o próprio número da
 * nota e sequências óbvias (00000000, 11111111, 12345678...).
 */
export function gerarCodigoNumerico(numero: number): string {
	const proibidos = new Set([
		String(numero).padStart(8, "0").slice(-8),
		"12345678", "23456789", "34567890", "45678901", "56789012", "67890123", "78901234", "89012345", "90123456", "01234567",
	]);
	for (;;) {
		const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
		const cNF = String(n % 100_000_000).padStart(8, "0");
		if (!proibidos.has(cNF) && !/^(\d)\1{7}$/.test(cNF)) return cNF;
	}
}
