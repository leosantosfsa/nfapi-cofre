// Autoteste de conexão: consultas de status nos ambientes de HOMOLOGAÇÃO, usando
// o certificado instalado. Não emite nem altera nenhum documento.

import { fromBase64, toBase64 } from "./crypto";
import type { TransmitRequest } from "./protocol";
import type { CertificateSecrets } from "./store";
import { type Transport, TransportError } from "./transport";

export interface SelfTestResult {
	name: string;
	host: string;
	ok: boolean;
	detail: string;
	ms?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const soapStatus = (cUF: number) =>
	`<?xml version="1.0" encoding="utf-8"?>` +
	`<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
	`<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">` +
	`<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
	`<tpAmb>2</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>` +
	`</nfeDadosMsg></soap12:Body></soap12:Envelope>`;

interface Target {
	name: string;
	request: TransmitRequest;
}

const nfeStatus = (name: string, url: string, cUF: number): Target => ({
	name,
	request: {
		url,
		method: "POST",
		headers: {
			"content-type":
				'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF"',
		},
		bodyB64: toBase64(encoder.encode(soapStatus(cUF))),
		timeoutMs: 30_000,
	},
});

export const SELF_TEST_TARGETS: Target[] = [
	nfeStatus(
		"NF-e homologação — SVRS",
		"https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
		// 33 = RJ, uma UF atendida pela SVRS. O RS (43) tem autorizador próprio e
		// a SVRS responde cStat 410 para ele.
		33,
	),
	nfeStatus(
		"NF-e homologação — São Paulo",
		"https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx",
		35,
	),
	{
		name: "NFS-e Nacional — produção restrita",
		request: {
			// Chave inexistente de propósito: qualquer resposta da aplicação prova que o mTLS foi aceito.
			url: `https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse/${"0".repeat(50)}`,
			method: "GET",
			headers: { accept: "application/json" },
			timeoutMs: 30_000,
		},
	},
];

/** Respostas do servidor web (antes da aplicação) que indicam certificado recusado. */
const REFUSED = new Set([401, 403, 495, 496]);

export async function runSelfTest(
	transport: Transport,
	cert: CertificateSecrets,
	targets: Target[] = SELF_TEST_TARGETS,
): Promise<SelfTestResult[]> {
	return Promise.all(
		targets.map(async ({ name, request }): Promise<SelfTestResult> => {
			const host = new URL(request.url).hostname;
			try {
				const res = await transport.transmit(request, cert);
				const text = decoder.decode(fromBase64(res.bodyB64));
				const cStat = /<cStat>(\d+)<\/cStat>/.exec(text)?.[1];
				const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(text)?.[1];
				if (cStat) {
					return { name, host, ok: true, detail: `cStat ${cStat} — ${xMotivo ?? ""}`.trim(), ms: res.ms };
				}
				if (REFUSED.has(res.status)) {
					return { name, host, ok: false, detail: `Certificado recusado (HTTP ${res.status}).`, ms: res.ms };
				}
				return { name, host, ok: true, detail: `Conexão aceita (HTTP ${res.status}).`, ms: res.ms };
			} catch (err) {
				const detail =
					err instanceof TransportError ? `${err.code}: ${err.message}` : String(err);
				return { name, host, ok: false, detail };
			}
		}),
	);
}
