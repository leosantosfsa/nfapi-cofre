// Teste de viabilidade com um certificado A1 real.
//
// Lê o .pfx, sobe o proxy mTLS localmente (o mesmo código que roda no Container)
// e consulta os serviços de HOMOLOGAÇÃO do governo. Nenhuma nota é emitida:
// são só consultas de status. O certificado e a senha ficam nesta máquina.
//
// Uso:  pnpm testar-certificado caminho/para/certificado.pfx
// A senha é pedida no terminal (ou lida da variável NFAPI_PFX_SENHA).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parsePfx } from "../src/pfx.ts";

const arquivo = process.argv[2];
if (!arquivo || !fs.existsSync(arquivo)) {
	console.error("Uso: pnpm testar-certificado caminho/para/certificado.pfx");
	process.exit(2);
}

function perguntarSenha() {
	if (process.env.NFAPI_PFX_SENHA) return Promise.resolve(process.env.NFAPI_PFX_SENHA);
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		let oculto = false;
		// Não ecoa a senha digitada.
		rl._writeToOutput = (texto) => {
			if (!oculto) process.stdout.write(texto);
		};
		rl.question("Senha do certificado: ", (resposta) => {
			rl.close();
			process.stdout.write("\n");
			resolve(resposta);
		});
		oculto = true;
	});
}

let cert;
try {
	cert = parsePfx(new Uint8Array(fs.readFileSync(arquivo)), await perguntarSenha());
} catch (err) {
	console.error(`\nNão foi possível ler o certificado: ${err.message}`);
	process.exit(1);
}

const hoje = new Date();
const dias = Math.floor((cert.notAfter - hoje) / 86_400_000);
console.log(`
Certificado lido
  Titular : ${cert.commonName}
  ${cert.holder.kind.toUpperCase().padEnd(8)}: ${cert.holder.id}
  Emissor : ${cert.issuer}
  Validade: ${cert.notAfter.toLocaleDateString("pt-BR")} (${dias >= 0 ? `faltam ${dias} dias` : "VENCIDO"})
  Cadeia  : ${cert.chainPem.length} certificado(s) intermediário(s) no arquivo
`);
if (dias < 0) {
	console.error("O certificado está vencido; os serviços vão recusá-lo.");
	process.exit(1);
}

const { server } = await import("../container/server.mjs");
const porta = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const soapStatus = (cUF) =>
	`<?xml version="1.0" encoding="utf-8"?>` +
	`<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
	`<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">` +
	`<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
	`<tpAmb>2</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>` +
	`</nfeDadosMsg></soap12:Body></soap12:Envelope>`;

const statusNFe = (nome, url, cUF) => ({
	nome,
	url,
	method: "POST",
	headers: {
		"content-type":
			'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF"',
	},
	body: soapStatus(cUF),
	// cStat 107 = "Serviço em Operação".
	avaliar: (r) => {
		const cStat = /<cStat>(\d+)<\/cStat>/.exec(r.texto)?.[1];
		const motivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(r.texto)?.[1];
		return cStat ? { ok: true, detalhe: `cStat ${cStat} — ${motivo}` } : undefined;
	},
});

const alvos = [
	statusNFe(
		"NF-e homologação — SVRS (maioria das UFs)",
		"https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
		// 33 = RJ, uma UF atendida pela SVRS. O RS (43) tem autorizador próprio e
		// a SVRS responde cStat 410 para ele.
		33,
	),
	statusNFe(
		"NF-e homologação — São Paulo",
		"https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx",
		35,
	),
	{
		nome: "NFS-e Nacional — produção restrita (SEFIN)",
		// Chave inexistente de propósito: qualquer resposta da aplicação (e não um
		// 403/496 do servidor web) prova que o mTLS foi aceito.
		url: `https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse/${"0".repeat(50)}`,
		method: "GET",
		headers: { accept: "application/json" },
	},
];

let falhas = 0;
for (const alvo of alvos) {
	const res = await fetch(`http://127.0.0.1:${porta}/transmit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			url: alvo.url,
			method: alvo.method,
			headers: alvo.headers,
			bodyB64: alvo.body ? Buffer.from(alvo.body).toString("base64") : undefined,
			certPem: cert.certificatePem,
			chainPem: cert.chainPem,
			keyPem: cert.privateKeyPem,
			timeoutMs: 30_000,
		}),
	});
	const json = await res.json();
	console.log(alvo.nome);
	if (json.error) {
		falhas++;
		console.log(`  FALHOU  ${json.error.code}: ${json.error.message}\n`);
		continue;
	}
	const texto = Buffer.from(json.bodyB64, "base64").toString("utf8");
	const avaliacao = alvo.avaliar?.({ ...json, texto });
	const recusado = [401, 403, 495, 496].includes(json.status);
	if (recusado && !avaliacao) falhas++;
	console.log(
		`  ${recusado && !avaliacao ? "RECUSADO" : "OK      "} HTTP ${json.status} | ${json.tls.protocol} | ${json.ms} ms`,
	);
	console.log(`  ${avaliacao?.detalhe ?? texto.replace(/\s+/g, " ").slice(0, 160)}\n`);
}

server.close();
console.log(
	falhas === 0
		? "Resultado: o certificado foi aceito em todos os serviços testados."
		: `Resultado: ${falhas} serviço(s) recusaram a conexão. Copie a saída acima para análise.`,
);
process.exit(falhas === 0 ? 0 : 1);
