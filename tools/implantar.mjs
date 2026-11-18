#!/usr/bin/env node
// Segunda etapa do deploy: aplica as migrações do banco e publica o Worker.
//
// Fica separado de atualizar.mjs de propósito: como roda depois da atualização,
// é sempre a versão nova deste arquivo que executa, e os passos do deploy podem
// mudar de uma versão para outra sem o emitente mexer em nada.

import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variavelPath = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
const env = {
	...process.env,
	[variavelPath]: `${join(raiz, "node_modules", ".bin")}${delimiter}${process.env[variavelPath] ?? ""}`,
};

const passos = ["wrangler d1 migrations apply DB --remote", "wrangler deploy"];

for (const passo of passos) {
	console.log(`[nfapi] ${passo}`);
	const r = spawnSync(passo, { cwd: raiz, env, stdio: "inherit", shell: true });
	if (r.status !== 0) process.exit(r.status ?? 1);
}
