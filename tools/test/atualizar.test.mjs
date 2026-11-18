import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { aplicar, compararVersoes, lerJsonc, mesclarWrangler } from "../atualizar.mjs";

test("lerJsonc aceita comentários e vírgulas sobrando sem tocar nos textos", () => {
	const lido = lerJsonc(`{
		// comentário de linha
		"name": "cofre", /* comentário
		de bloco */
		"url": "https://exemplo.test/a//b", // "//" dentro do texto não é comentário
		"texto": "vírgula, antes de } e aspas \\" escapadas /* nada */",
		"lista": [1, 2, ],
	}`);
	assert.deepEqual(lido, {
		name: "cofre",
		url: "https://exemplo.test/a//b",
		texto: 'vírgula, antes de } e aspas " escapadas /* nada */',
		lista: [1, 2],
	});
});

test("lerJsonc lê o wrangler.jsonc do próprio cofre", () => {
	const config = lerJsonc(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
	assert.equal(config.main, "src/index.ts");
	assert.equal(config.d1_databases[0].binding, "DB");
});

test("compararVersoes ordena por número, não por texto", () => {
	assert.ok(compararVersoes("0.10.0", "0.9.9") > 0);
	assert.ok(compararVersoes("1.0.0", "0.99.99") > 0);
	assert.ok(compararVersoes("0.2.0", "0.2.1") < 0);
	assert.equal(compararVersoes("0.2.0", "0.2.0"), 0);
});

const NOVO = {
	name: "nfapi-cofre",
	main: "src/index.ts",
	compatibility_flags: ["nodejs_compat"],
	vars: { MODO: "padrao" },
	d1_databases: [{ binding: "DB", database_name: "nfapi-cofre", database_id: "", migrations_dir: "migrations" }],
	r2_buckets: [{ binding: "DOCS", bucket_name: "nfapi-cofre-docs" }, { binding: "NOVO", bucket_name: "nfapi-novo" }],
};
const LOCAL = {
	name: "cofre-da-empresa",
	main: "src/antigo.ts",
	compatibility_flags: ["nodejs_compat", "flag_antiga"],
	routes: [{ pattern: "notas.empresa.test", custom_domain: true }],
	vars: { MODO: "meu" },
	d1_databases: [{ binding: "DB", database_name: "cofre-db", database_id: "id-do-emitente" }],
	r2_buckets: [{ binding: "DOCS", bucket_name: "cofre-docs", preview_bucket_name: "cofre-docs-preview" }],
};

test("mesclarWrangler: estrutura da versão nova, identidade e recursos do emitente", () => {
	const saida = mesclarWrangler(NOVO, LOCAL);
	assert.equal(saida.name, "cofre-da-empresa");
	assert.deepEqual(saida.routes, LOCAL.routes);
	assert.deepEqual(saida.d1_databases, [
		{ binding: "DB", database_name: "cofre-db", database_id: "id-do-emitente", migrations_dir: "migrations" },
	]);
	assert.deepEqual(saida.r2_buckets, [
		{ binding: "DOCS", bucket_name: "cofre-docs", preview_bucket_name: "cofre-docs-preview" },
		{ binding: "NOVO", bucket_name: "nfapi-novo" },
	]);
	assert.deepEqual(saida.vars, { MODO: "meu" });
	// O que é da versão nova vence.
	assert.equal(saida.main, "src/index.ts");
	assert.deepEqual(saida.compatibility_flags, ["nodejs_compat"]);
	// A entrada não é alterada.
	assert.equal(NOVO.d1_databases[0].database_id, "");
});

test("aplicar copia a versão nova e preserva o que é do emitente", () => {
	const base = mkdtempSync(join(tmpdir(), "nfapi-teste-"));
	const escrever = (pasta, arquivo, texto) => {
		const caminho = join(base, pasta, arquivo);
		mkdirSync(dirname(caminho), { recursive: true });
		writeFileSync(caminho, texto);
	};
	const ler = (arquivo) => readFileSync(join(base, "destino", arquivo), "utf8");
	try {
		escrever("origem", "package.json", '{"version":"0.3.0"}');
		escrever("origem", "wrangler.jsonc", `// versão nova\n${JSON.stringify(NOVO)}`);
		escrever("origem", "src/index.ts", "novo");
		escrever("origem", "migrations/0002_nova.sql", "CREATE TABLE b (id);");
		escrever("origem", ".dev.vars", "VAULT_SECRET=do-pacote");

		escrever("destino", "package.json", '{"version":"0.2.0"}');
		escrever("destino", "wrangler.jsonc", JSON.stringify(LOCAL));
		escrever("destino", "src/index.ts", "antigo");
		escrever("destino", "migrations/0001_inicial.sql", "CREATE TABLE a (id);");
		escrever("destino", ".dev.vars", "VAULT_SECRET=do-emitente");
		escrever("destino", ".git/HEAD", "ref: refs/heads/main");

		aplicar(join(base, "origem"), join(base, "destino"));

		assert.equal(JSON.parse(ler("package.json")).version, "0.3.0");
		assert.equal(ler("src/index.ts"), "novo");
		assert.ok(existsSync(join(base, "destino", "migrations/0001_inicial.sql")));
		assert.ok(existsSync(join(base, "destino", "migrations/0002_nova.sql")));
		assert.equal(ler(".dev.vars"), "VAULT_SECRET=do-emitente");
		assert.equal(ler(".git/HEAD"), "ref: refs/heads/main");
		const config = JSON.parse(ler("wrangler.jsonc"));
		assert.equal(config.name, "cofre-da-empresa");
		assert.equal(config.d1_databases[0].database_id, "id-do-emitente");
		assert.equal(config.main, "src/index.ts");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
