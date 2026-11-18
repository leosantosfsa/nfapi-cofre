#!/usr/bin/env node
// Atualização do cofre, executada no começo de cada build do Cloudflare.
//
// O repositório do emitente é só o ponto de partida: a cada build este script
// busca a versão publicada pelo NFapi (canal estável) e, se ela for mais nova
// que a do repositório, instala os arquivos por cima antes do deploy. É assim
// que o botão "Atualizar" da tela /setup funciona: ele dispara um build.
//
// O que é do emitente nunca é trocado: o nome do Worker, os identificadores do
// banco D1 e do bucket R2 (wrangler.jsonc) e os dados guardados neles.
//
//   NFAPI_ATUALIZAR=0   desliga a atualização (para quem mantém um fork próprio)
//   NFAPI_ATUALIZAR=1   força a execução fora do build do Cloudflare
//   NFAPI_REPO / NFAPI_CANAL   outro repositório ou branch de origem

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Lê JSON com comentários e vírgulas sobrando, como o wrangler.jsonc. */
export function lerJsonc(texto) {
	let saida = "";
	let i = 0;
	while (i < texto.length) {
		const c = texto[i];
		if (c === '"') {
			// Textos entre aspas passam intactos: "//" dentro deles não é comentário.
			const inicio = i++;
			while (i < texto.length && texto[i] !== '"') i += texto[i] === "\\" ? 2 : 1;
			saida += texto.slice(inicio, ++i);
		} else if (c === "/" && texto[i + 1] === "/") {
			while (i < texto.length && texto[i] !== "\n") i++;
		} else if (c === "/" && texto[i + 1] === "*") {
			const fim = texto.indexOf("*/", i + 2);
			i = fim === -1 ? texto.length : fim + 2;
		} else if (c === "}" || c === "]") {
			saida = saida.replace(/,\s*$/, "") + c;
			i++;
		} else {
			saida += c;
			i++;
		}
	}
	return JSON.parse(saida);
}

/** Positivo quando a versão `a` ("x.y.z") é mais nova que `b`. */
export function compararVersoes(a, b) {
	const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

// O que identifica a instalação do emitente e precisa sobreviver à atualização.
const IDENTIDADE = ["name", "account_id", "routes", "route", "workers_dev", "preview_urls"];
const RECURSOS = {
	d1_databases: ["database_id", "database_name", "preview_database_id"],
	r2_buckets: ["bucket_name", "preview_bucket_name", "jurisdiction"],
	kv_namespaces: ["id", "preview_id"],
};

/**
 * Configuração do Worker depois da atualização: a estrutura vem da versão nova
 * (bindings, containers, flags), a identidade e os recursos vêm do emitente.
 */
export function mesclarWrangler(novo, local) {
	const saida = structuredClone(novo);
	for (const campo of IDENTIDADE) {
		if (campo in local) saida[campo] = local[campo];
	}
	for (const [lista, campos] of Object.entries(RECURSOS)) {
		for (const recurso of saida[lista] ?? []) {
			const meu = (local[lista] ?? []).find((r) => r.binding === recurso.binding);
			if (!meu) continue;
			for (const campo of campos) {
				if (campo in meu) recurso[campo] = meu[campo];
			}
		}
	}
	if (local.vars) saida.vars = { ...novo.vars, ...local.vars };
	return saida;
}

const PRESERVAR = new Set([".git", "node_modules", ".wrangler", ".dev.vars", "wrangler.jsonc"]);

/**
 * Copia a versão nova por cima da instalação. Nada é apagado: arquivos que
 * saíram da versão nova deixam de ser usados, e as migrações antigas continuam
 * no lugar.
 */
export function aplicar(origem, destino) {
	const novo = lerJsonc(readFileSync(join(origem, "wrangler.jsonc"), "utf8"));
	const caminhoLocal = join(destino, "wrangler.jsonc");
	const local = existsSync(caminhoLocal) ? lerJsonc(readFileSync(caminhoLocal, "utf8")) : {};
	for (const nome of readdirSync(origem)) {
		if (PRESERVAR.has(nome)) continue;
		cpSync(join(origem, nome), join(destino, nome), { recursive: true, force: true });
	}
	writeFileSync(caminhoLocal, `${JSON.stringify(mesclarWrangler(novo, local), null, "\t")}\n`);
}

const versaoDe = (pasta) => JSON.parse(readFileSync(join(pasta, "package.json"), "utf8")).version;
const log = (texto) => console.log(`[nfapi] ${texto}`);

/** Baixa o canal publicado e devolve a pasta com o cofre extraído. */
async function baixar(canal, pastaTemporaria) {
	const url = `https://codeload.github.com/${canal.repo}/tar.gz/refs/heads/${canal.ref}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!res.ok) throw new Error(`o GitHub respondeu HTTP ${res.status}`);
	writeFileSync(join(pastaTemporaria, "pacote.tgz"), Buffer.from(await res.arrayBuffer()));
	// Caminhos relativos: funciona igual com o tar do Linux e o do Windows.
	const tar = spawnSync("tar", ["-xzf", "pacote.tgz"], { cwd: pastaTemporaria, stdio: "inherit" });
	if (tar.status !== 0) throw new Error("não foi possível extrair o pacote");
	const topo = readdirSync(pastaTemporaria).find((n) => statSync(join(pastaTemporaria, n)).isDirectory());
	const pasta = join(pastaTemporaria, topo ?? "", canal.dir);
	if (!topo || !existsSync(join(pasta, "package.json")) || !existsSync(join(pasta, "wrangler.jsonc"))) {
		throw new Error("o pacote baixado não contém o cofre");
	}
	return pasta;
}

async function main() {
	const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const modo = process.env.NFAPI_ATUALIZAR;
	if (modo === "0") return log("Atualização desligada (NFAPI_ATUALIZAR=0).");
	if (modo !== "1" && !process.env.WORKERS_CI) return log("Fora do build do Cloudflare: nada a atualizar.");

	const canal = {
		repo: process.env.NFAPI_REPO ?? "Quevenapp/nfapi",
		ref: process.env.NFAPI_CANAL ?? "cofre-estavel",
		dir: "vault",
	};
	if (!/^[\w.-]+\/[\w.-]+$/.test(canal.repo) || !/^[\w./-]+$/.test(canal.ref) || canal.ref.includes("..")) {
		throw new Error("NFAPI_REPO ou NFAPI_CANAL inválido.");
	}

	const instalada = versaoDe(raiz);
	const temporaria = mkdtempSync(join(tmpdir(), "nfapi-"));
	try {
		let origem;
		try {
			origem = await baixar(canal, temporaria);
		} catch (err) {
			// Sem acesso ao canal, o build segue com a versão que já está no repositório.
			return log(`Não foi possível buscar a versão publicada (${err.message}). Mantida a versão ${instalada}.`);
		}
		const publicada = versaoDe(origem);
		if (compararVersoes(publicada, instalada) <= 0) {
			return log(`Versão ${instalada} em dia (publicada: ${publicada}).`);
		}
		log(`Atualizando de ${instalada} para ${publicada} (${canal.repo}@${canal.ref}).`);
		aplicar(origem, raiz);
		const instalar = spawnSync("pnpm install --frozen-lockfile", { cwd: raiz, stdio: "inherit", shell: true });
		if (instalar.status !== 0) throw new Error("Falha ao instalar as dependências da nova versão.");
		log(`Versão ${publicada} instalada.`);
	} finally {
		rmSync(temporaria, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(`[nfapi] ${err.message}`);
		process.exit(1);
	});
}
