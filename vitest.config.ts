import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Os testes rodam dentro do workerd (o runtime real do Workers), com D1 e R2
// locais. O Container não participa: as rotas recebem um transporte simulado, e
// o proxy mTLS tem seus próprios testes em container/test (Node).
export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
	return {
		plugins: [
			cloudflareTest({
				miniflare: {
					compatibilityDate: "2026-11-01",
					compatibilityFlags: ["nodejs_compat"],
					d1Databases: ["DB"],
					r2Buckets: ["DOCS"],
					bindings: {
						TEST_MIGRATIONS: migrations,
						// Segredo fixo, usado somente nos testes.
						VAULT_SECRET: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
					},
				},
			}),
		],
		test: {
			include: ["test/**/*.test.ts"],
			setupFiles: ["./test/aplicar-migracoes.ts"],
		},
	};
});
