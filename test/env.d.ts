declare module "*?raw" {
	const content: string;
	export default content;
}

declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		DOCS: R2Bucket;
		VAULT_SECRET: string;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
