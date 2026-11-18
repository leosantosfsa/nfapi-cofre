// Transporte mTLS: o Worker entrega a requisição ao proxy que roda no Container.

import type { TransmitRequest, TransmitResponse } from "./protocol";
import type { CertificateSecrets } from "./store";

export type TransportResult = Omit<TransmitResponse, "journalKey">;

export class TransportError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "TransportError";
		this.status = status;
		this.code = code;
	}
}

export interface Transport {
	transmit(request: TransmitRequest, cert: CertificateSecrets): Promise<TransportResult>;
}

/** Sufixos sempre aceitos. Outros hosts só entram por configuração explícita do emitente. */
export const DEFAULT_ALLOWED_SUFFIXES = [".gov.br"];

export function isHostAllowed(hostname: string, suffixes = DEFAULT_ALLOWED_SUFFIXES): boolean {
	const host = hostname.toLowerCase();
	return suffixes.some((s) =>
		s.startsWith(".") ? host.endsWith(s) && host.length > s.length : host === s,
	);
}

/** Validação feita no Worker; o Container repete a mesma checagem por conta própria. */
export function assertTransmittable(request: TransmitRequest): URL {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		throw new TransportError(400, "requisicao_invalida", "URL inválida.");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new TransportError(400, "requisicao_invalida", "Somente URLs https sem credenciais.");
	}
	if (url.port && url.port !== "443") {
		throw new TransportError(403, "host_nao_permitido", `Porta não permitida: ${url.port}`);
	}
	if (!isHostAllowed(url.hostname)) {
		throw new TransportError(
			403,
			"host_nao_permitido",
			`O cofre só transmite para serviços do governo (*.gov.br). Recusado: ${url.hostname}`,
		);
	}
	return url;
}

interface ContainerStub {
	fetch(input: string, init: RequestInit): Promise<Response>;
}
interface ContainerNamespace {
	getByName(name: string): ContainerStub;
}

export class ContainerTransport implements Transport {
	private readonly namespace: ContainerNamespace;

	constructor(namespace: ContainerNamespace) {
		this.namespace = namespace;
	}

	async transmit(request: TransmitRequest, cert: CertificateSecrets): Promise<TransportResult> {
		// Uma instância fixa: o Container acorda sob demanda e dorme após ficar ocioso.
		const stub = this.namespace.getByName("mtls");
		let res: Response;
		try {
			res = await stub.fetch("http://mtls.cofre/transmit", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					url: request.url,
					method: request.method ?? "POST",
					headers: request.headers ?? {},
					bodyB64: request.bodyB64,
					maxTls: request.maxTls ?? "1.2",
					timeoutMs: request.timeoutMs,
					certPem: cert.certificatePem,
					chainPem: cert.chainPem,
					keyPem: cert.privateKeyPem,
				}),
			});
		} catch (err) {
			throw new TransportError(
				503,
				"container_indisponivel",
				`O proxy mTLS não respondeu: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const json = (await res.json().catch(() => null)) as
			| (TransportResult & { error?: undefined })
			| { error: { code: string; message: string } }
			| null;
		if (!json) {
			throw new TransportError(502, "container_indisponivel", `Resposta inválida do proxy (HTTP ${res.status}).`);
		}
		if (json.error) throw new TransportError(res.status, json.error.code, json.error.message);
		return json;
	}
}
