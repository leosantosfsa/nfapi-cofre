import { applyD1Migrations, env } from "cloudflare:test";

// Cria as tabelas do cofre no D1 local antes de cada arquivo de teste.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
