// Ponto de entrada do cofre no Cloudflare Workers.

import { Container } from "@cloudflare/containers";
import { executarAgendado } from "./agendador";
import { type AppEnv, createApp } from "./app";
import { ContainerTransport } from "./transport";

/**
 * Durable Object que controla o Container do proxy mTLS (container/server.mjs).
 * O Container só é alcançável por este Worker; ele acorda sob demanda e dorme
 * depois de 10 minutos sem uso.
 */
export class MtlsProxy extends Container {
	override defaultPort = 8080;
	override sleepAfter = "10m";
}

interface Env extends AppEnv {
	MTLS: ConstructorParameters<typeof ContainerTransport>[0];
}

const app = createApp((env) => new ContainerTransport((env as Env).MTLS));

export default {
	fetch: app.fetch,
	// Cron Trigger: transmite as NFC-e em contingência quando a SEFAZ volta e baixa as notas recebidas.
	scheduled(_evento, env, ctx) {
		ctx.waitUntil(executarAgendado(env, new ContainerTransport(env.MTLS)));
	},
} satisfies ExportedHandler<Env>;
