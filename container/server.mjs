// Proxy mTLS do cofre NFapi.
//
// Roda dentro do Cloudflare Container e só é alcançável pelo Worker do cofre.
// Existe porque o fetch() do Workers não aceita os certificados de servidor
// ICP-Brasil usados pelas SEFAZ estaduais nem permite fixar TLS 1.2 ou
// renegociar a conexão. Aqui o TLS é feito pelo OpenSSL do Node, com a cadeia
// ICP-Brasil embutida em ./ca.
//
// O certificado do emitente chega em cada requisição e vive só na memória
// desta chamada: nada é gravado em disco nem em log.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const CA_DIR = process.env.CA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "ca");
const ALLOWED_SUFFIXES = list(process.env.ALLOWED_HOST_SUFFIXES ?? ".gov.br");
const ALLOWED_PORTS = list(process.env.ALLOWED_PORTS ?? "443").map(Number);
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function list(value) {
	return value
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

/** Raízes públicas do Node + tudo que estiver em ./ca (ICP-Brasil). */
function loadTrustStore() {
	const extra = [];
	for (const file of fs.existsSync(CA_DIR) ? fs.readdirSync(CA_DIR) : []) {
		if (file.endsWith(".pem")) extra.push(fs.readFileSync(path.join(CA_DIR, file), "utf8"));
	}
	return { ca: [...tls.rootCertificates, ...extra], extraCount: extra.length };
}

const trust = loadTrustStore();

class ProxyError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function isHostAllowed(hostname, suffixes = ALLOWED_SUFFIXES) {
	const host = hostname.toLowerCase();
	return suffixes.some((s) =>
		s.startsWith(".") ? host.endsWith(s) && host.length > s.length : host === s,
	);
}

function validate(input) {
	if (!input || typeof input !== "object") {
		throw new ProxyError(400, "requisicao_invalida", "Corpo JSON ausente.");
	}
	let url;
	try {
		url = new URL(input.url);
	} catch {
		throw new ProxyError(400, "requisicao_invalida", "URL inválida.");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new ProxyError(400, "requisicao_invalida", "Somente URLs https sem credenciais.");
	}
	if (!isHostAllowed(url.hostname)) {
		throw new ProxyError(403, "host_nao_permitido", `Host fora da lista permitida: ${url.hostname}`);
	}
	const port = url.port ? Number(url.port) : 443;
	if (!ALLOWED_PORTS.includes(port)) {
		throw new ProxyError(403, "host_nao_permitido", `Porta não permitida: ${port}`);
	}
	const method = String(input.method ?? "POST").toUpperCase();
	if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method)) {
		throw new ProxyError(400, "requisicao_invalida", `Método não suportado: ${method}`);
	}
	if (typeof input.certPem !== "string" || typeof input.keyPem !== "string") {
		throw new ProxyError(400, "requisicao_invalida", "certPem e keyPem são obrigatórios.");
	}
	const maxTls = input.maxTls === "1.3" ? "TLSv1.3" : "TLSv1.2";
	const timeout = Math.min(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
	const body = input.bodyB64 ? Buffer.from(String(input.bodyB64), "base64") : undefined;
	const headers = {};
	for (const [k, v] of Object.entries(input.headers ?? {})) {
		const name = k.toLowerCase();
		// Cabeçalhos de transporte são definidos aqui, nunca pelo chamador.
		if (["host", "content-length", "connection", "transfer-encoding"].includes(name)) continue;
		headers[name] = String(v);
	}
	if (body) headers["content-length"] = String(body.length);
	return { url, method, headers, body, maxTls, timeout, input };
}

function transmit({ url, method, headers, body, maxTls, timeout, input }) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const req = https.request(
			url,
			{
				method,
				headers,
				// Certificado do titular seguido da cadeia: algumas SEFAZ recusam só a folha.
				cert: [input.certPem, ...(input.chainPem ?? [])].join("\n"),
				key: input.keyPem,
				ca: trust.ca,
				minVersion: "TLSv1.2",
				maxVersion: maxTls,
				rejectUnauthorized: true,
				agent: false,
				timeout,
			},
			(res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > MAX_RESPONSE_BYTES) {
						req.destroy(new ProxyError(502, "resposta_grande_demais", "Resposta excede o limite."));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					const socket = res.socket;
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						bodyB64: Buffer.concat(chunks).toString("base64"),
						tls: {
							protocol: socket.getProtocol?.() ?? null,
							cipher: socket.getCipher?.()?.name ?? null,
							peerIssuer: socket.getPeerCertificate?.()?.issuer?.CN ?? null,
						},
						ms: Date.now() - started,
					});
				});
				res.on("error", reject);
			},
		);
		req.on("timeout", () => {
			req.destroy(new ProxyError(504, "tempo_esgotado", `Sem resposta em ${timeout} ms.`));
		});
		req.on("error", reject);
		req.end(body);
	});
}

function toProxyError(err) {
	if (err instanceof ProxyError) return err;
	const code = String(err?.code ?? "");
	const message = String(err?.message ?? err);
	// Códigos de verificação X.509 do OpenSSL/Node (cadeia, validade, finalidade, nome).
	if (/CERT|SELF_SIGNED|UNABLE_TO_|ALTNAME|INVALID_PURPOSE|INVALID_CA|HOSTNAME_MISMATCH|PATH_LENGTH|CRL/.test(code)) {
		return new ProxyError(502, "certificado_do_servidor_nao_confiavel", `${code}: ${message}`);
	}
	if (/SSL|TLS|EPROTO|ECONNRESET/.test(code) || /handshake|alert|ssl/i.test(message)) {
		return new ProxyError(502, "tls_falhou", `${code}: ${message}`);
	}
	if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/.test(code)) {
		return new ProxyError(502, "conexao_falhou", `${code}: ${message}`);
	}
	if (/PEM|key values mismatch|bad decrypt/i.test(message)) {
		return new ProxyError(400, "certificado_do_cliente_invalido", message);
	}
	return new ProxyError(502, "erro_de_transporte", `${code}: ${message}`);
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				reject(new ProxyError(413, "requisicao_grande_demais", "Requisição excede o limite."));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new ProxyError(400, "requisicao_invalida", "JSON inválido."));
			}
		});
		req.on("error", reject);
	});
}

function send(res, status, payload) {
	const data = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(data);
}

export const server = http.createServer(async (req, res) => {
	const pathname = new URL(req.url ?? "/", "http://cofre").pathname;
	if (req.method === "GET" && (pathname === "/ping" || pathname === "/health")) {
		return send(res, 200, { ok: true, node: process.version, cas: trust.extraCount });
	}
	if (req.method !== "POST" || pathname !== "/transmit") {
		return send(res, 404, { error: { code: "nao_encontrado", message: "Rota inexistente." } });
	}
	let host = "?";
	try {
		const request = validate(await readJson(req));
		host = request.url.hostname;
		const result = await transmit(request);
		console.log(`transmit ${host} -> ${result.status} em ${result.ms} ms (${result.tls.protocol})`);
		send(res, 200, result);
	} catch (err) {
		const e = toProxyError(err);
		console.log(`transmit ${host} -> erro ${e.code}`);
		send(res, e.status, { error: { code: e.code, message: e.message } });
	}
});

// Executado direto (node server.mjs): sobe o servidor. Importado em teste: não.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	server.listen(PORT, () => {
		console.log(`proxy mTLS do cofre na porta ${PORT}; ${trust.extraCount} CA(s) ICP-Brasil carregada(s)`);
	});
}
