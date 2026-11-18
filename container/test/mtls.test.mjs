// Testes do proxy mTLS contra servidores TLS locais que imitam o comportamento
// dos webservices fiscais: exigem certificado de cliente, TLS 1.2 e, em um dos
// casos, pedem o certificado só depois da conexão aberta (renegociação, como o IIS).
//
// Rodar: node --test container/test/

import assert from "node:assert/strict";
import { constants } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), "utf8");

const servidor = {
	cert: read("fixtures", "ca", "servidor-local.cert.pem"),
	key: read("fixtures", "servidor-local.key.pem"),
};
const cliente = {
	cert: read("..", "..", "test", "fixtures", "a1-teste.cert.pem"),
	key: read("..", "..", "test", "fixtures", "a1-teste.key.pem"),
};
const CN_CLIENTE = "EMPRESA TESTE NFAPI LTDA:11222333000181";

const listen = (srv) =>
	new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));

let proxy;
let proxyPort;
const fakes = {};

before(async () => {
	// "SEFAZ" que exige o certificado do cliente já no handshake.
	fakes.handshake = https.createServer(
		{ ...servidor, ca: [cliente.cert], requestCert: true, rejectUnauthorized: true, maxVersion: "TLSv1.2" },
		(req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/xml" });
				res.end(`<ok cn="${req.socket.getPeerCertificate().subject.CN}" eco="${body}"/>`);
			});
		},
	);
	// "SEFAZ" estilo IIS: só pede o certificado depois, renegociando a conexão.
	// Sem retomada de sessão na renegociação, senão o handshake é abreviado e o
	// certificado nunca é pedido.
	fakes.renegocia = https.createServer(
		{
			...servidor,
			ca: [cliente.cert],
			requestCert: false,
			maxVersion: "TLSv1.2",
			secureOptions:
				constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION | constants.SSL_OP_NO_TICKET,
		},
		(req, res) => {
			req.socket.renegotiate({ requestCert: true, rejectUnauthorized: true }, (err) => {
				const cn = req.socket.getPeerCertificate()?.subject?.CN;
				if (err || !cn) {
					res.writeHead(403);
					return res.end("sem certificado");
				}
				res.writeHead(200);
				res.end(`<ok cn="${cn}"/>`);
			});
		},
	);
	// Servidor com certificado que não está em nenhuma CA confiável.
	fakes.naoConfiavel = https.createServer({ cert: cliente.cert, key: cliente.key }, (_req, res) =>
		res.end("nunca deveria chegar aqui"),
	);

	const ports = {};
	for (const [name, srv] of Object.entries(fakes)) ports[name] = await listen(srv);
	fakes.ports = ports;

	process.env.ALLOWED_HOST_SUFFIXES = "localhost";
	process.env.ALLOWED_PORTS = Object.values(ports).join(",");
	process.env.CA_DIR = path.join(here, "fixtures", "ca");
	({ server: proxy } = await import("../server.mjs"));
	proxyPort = await listen(proxy);
});

after(() => {
	proxy?.close();
	for (const srv of Object.values(fakes)) srv.close?.();
});

async function transmit(payload) {
	const res = await fetch(`http://127.0.0.1:${proxyPort}/transmit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	return { status: res.status, json: await res.json() };
}

const base = (name, extra = {}) => ({
	url: `https://localhost:${fakes.ports[name]}/ws/NFeAutorizacao4`,
	certPem: cliente.cert,
	keyPem: cliente.key,
	...extra,
});
const body = (json) => Buffer.from(json.bodyB64, "base64").toString("utf8");

test("apresenta o certificado do cliente no handshake e devolve a resposta", async () => {
	const { status, json } = await transmit(
		base("handshake", {
			method: "POST",
			headers: { "content-type": "application/soap+xml; charset=utf-8" },
			bodyB64: Buffer.from("envelope").toString("base64"),
		}),
	);
	assert.equal(status, 200);
	assert.equal(json.status, 200);
	assert.equal(body(json), `<ok cn="${CN_CLIENTE}" eco="envelope"/>`);
	assert.equal(json.tls.protocol, "TLSv1.2");
});

test("atende servidor que pede o certificado por renegociação (TLS 1.2)", async () => {
	const { status, json } = await transmit(base("renegocia", { method: "GET" }));
	assert.equal(status, 200);
	assert.equal(json.status, 200);
	assert.equal(body(json), `<ok cn="${CN_CLIENTE}"/>`);
});

test("recusa servidor cujo certificado não é confiável", async () => {
	const { status, json } = await transmit(base("naoConfiavel", { method: "GET" }));
	assert.equal(status, 502);
	assert.equal(json.error.code, "certificado_do_servidor_nao_confiavel");
});

test("falha de forma identificável quando o servidor rejeita o certificado do cliente", async () => {
	const { status, json } = await transmit(
		base("handshake", { method: "GET", certPem: servidor.cert, keyPem: servidor.key }),
	);
	assert.equal(status, 502);
	assert.equal(json.error.code, "tls_falhou");
});

test("bloqueia host, porta e protocolo fora da lista permitida", async () => {
	const fora = await transmit(base("handshake", { url: "https://example.com/" }));
	assert.equal(fora.status, 403);
	assert.equal(fora.json.error.code, "host_nao_permitido");

	const porta = await transmit(base("handshake", { url: "https://localhost:1/" }));
	assert.equal(porta.status, 403);

	const http = await transmit(base("handshake", { url: "http://localhost/" }));
	assert.equal(http.status, 400);
});

test("a regra de sufixo não aceita domínios parecidos", async () => {
	const { isHostAllowed } = await import("../server.mjs");
	assert.equal(isHostAllowed("nfe.svrs.rs.gov.br", [".gov.br"]), true);
	assert.equal(isHostAllowed("gov.br", [".gov.br"]), false);
	assert.equal(isHostAllowed("gov.br.evil.com", [".gov.br"]), false);
	assert.equal(isHostAllowed("evilgov.br", [".gov.br"]), false);
});
