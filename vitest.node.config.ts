import { defineConfig } from "vitest/config";

// Testes que rodam no Node, e não no workerd: validam os XML gerados contra os
// XSD oficiais (schemas/), com libxml2-wasm, que o runtime do Workers não carrega.
export default defineConfig({
	test: {
		include: ["test-node/**/*.test.ts"],
	},
});
