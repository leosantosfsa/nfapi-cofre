// Estilo do painel do emitente. Segue a linguagem visual do ERP do Wabotia
// (acento roxo, cantos de 8 e 12 px, tabelas com cabeçalho discreto), com as
// fontes do sistema: a CSP do cofre não carrega fontes de fora.

export const SETUP_CSS = String.raw`:root {
	--bg: #f5f5f8; --surface: #ffffff; --surface-alt: #f2f2f6; --surface-hover: #f6f4fd;
	--border: #e6e5ec; --border-strong: #cdcbd7; --input-bg: #ffffff;
	--text: #2b2834; --heading: #18161f; --muted: #5f5a6b; --subtle: #6e697c;
	--accent: #5b3dc8; --accent-hover: #4b30ad; --accent-text: #ffffff; --accent-soft: #efebfc; --accent-strong: #4a2fae;
	--focus-ring: 0 0 0 3px rgb(91 61 200 / 22%);
	--success: #1c6b40; --success-bg: #e7f4ec; --warning: #835000; --warning-bg: #fff2d6;
	--danger: #a3261e; --danger-bg: #fdecea; --neutral: #4b4957; --neutral-bg: #efeff3; --info: #1b5a8c; --info-bg: #e8f1fa;
	--nav: #f9f9fb; --nav-hover: #efeef4; --nav-text: #3a3746; --nav-muted: #6a6578; --nav-active: #ebe7fb; --nav-active-text: #4a2fae;
	--series: #6a4fd6;
	--shadow: 0 1px 2px rgb(24 22 31 / 4%), 0 1px 3px rgb(24 22 31 / 4%);
	--shadow-raised: 0 4px 16px rgb(24 22 31 / 8%);
	--shadow-modal: 0 24px 64px rgb(24 22 31 / 18%), 0 2px 8px rgb(24 22 31 / 8%);
	--radius: 8px; --radius-card: 12px; --control: 38px; --sidebar: 248px; --topbar: 60px; --gutter: 28px;
	--font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131218; --surface: #1b1a22; --surface-alt: #22212a; --surface-hover: #26232f;
		--border: #2d2b36; --border-strong: #45424f; --input-bg: #17161d;
		--text: #e7e4ef; --heading: #f7f5fc; --muted: #aaa5b8; --subtle: #8f8a9e;
		--accent: #a993f6; --accent-hover: #bba9fa; --accent-text: #1a1330; --accent-soft: #2b2445; --accent-strong: #cbbefb;
		--focus-ring: 0 0 0 3px rgb(169 147 246 / 30%);
		--success: #bfeccf; --success-bg: #173d28; --warning: #fbe3b0; --warning-bg: #4a3410;
		--danger: #ffd2cd; --danger-bg: #4d1d1a; --neutral: #e2e0ea; --neutral-bg: #2e2c37; --info: #cfe5fb; --info-bg: #14324d;
		--nav: #16151c; --nav-hover: #22212a; --nav-text: #d9d5e4; --nav-muted: #9d98ab; --nav-active: #2b2445; --nav-active-text: #d4c9fc;
		--series: #a993f6;
		--shadow: 0 1px 2px rgb(0 0 0 / 30%); --shadow-raised: 0 4px 16px rgb(0 0 0 / 40%); --shadow-modal: 0 24px 64px rgb(0 0 0 / 55%);
	}
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); }
h1, h2, h3 { color: var(--heading); margin: 0; }
h1 { font-size: 24px; font-weight: 700; letter-spacing: -.02em; line-height: 1.25; }
h2 { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
h2.spaced { margin-top: 24px; }
h3 { font-size: 16px; font-weight: 700; }
p { margin: 0 0 12px; }
ol { margin: 0 0 12px; padding-left: 20px; }
a { color: var(--accent-strong); }
code { font-family: var(--mono); font-size: .92em; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.hint { color: var(--muted); font-size: 12.5px; margin: 8px 0 0; }
.eyebrow { margin: 0 0 4px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mono { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }

/* ---------- Controles ---------- */
button { font: inherit; cursor: pointer; }
.primary, .secondary, .danger {
	display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: var(--control); padding: 7px 14px;
	border: 1px solid var(--border-strong); border-radius: var(--radius); font-size: 14px; font-weight: 600;
	background: var(--surface); color: var(--text); transition: background 120ms, box-shadow 120ms;
}
.primary { color: var(--accent-text); background: var(--accent); border-color: var(--accent); box-shadow: 0 1px 2px rgb(24 22 31 / 12%); }
.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.secondary:hover { background: var(--surface-alt); }
.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, var(--border-strong)); }
.danger:hover { background: var(--danger-bg); }
.wide { width: 100%; }
.small-button { min-height: 32px; padding: 4px 11px; font-size: 13px; }
button:active { transform: translateY(1px); }
button:disabled { opacity: .55; cursor: progress; }
.icon-button {
	display: inline-flex; align-items: center; justify-content: center; width: var(--control); height: var(--control); padding: 6px;
	color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
}
.icon-button:hover { background: var(--surface-alt); }
.link { padding: 0; border: 0; background: none; color: var(--accent-strong); font-weight: 600; text-decoration: underline; }
.field { display: grid; gap: 6px; margin-top: 12px; align-content: start; }
.field > label { font-size: 13px; font-weight: 600; }
.field.compact { margin-top: 0; }
input[type="text"], input[type="password"], input[type="search"], input[type="date"], input[type="file"], textarea, select {
	width: 100%; min-height: var(--control); padding: 7px 11px; background: var(--input-bg); color: var(--text);
	border: 1px solid var(--border-strong); border-radius: var(--radius); font: inherit;
}
textarea { font-family: var(--mono); font-size: 12.5px; word-break: break-all; resize: vertical; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }
button:focus-visible, a:focus-visible, summary:focus-visible, tr:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--radius); }
label.check { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; }
label.check input { margin-top: 3px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0 14px; }
form > .primary, form > .secondary { margin-top: 14px; }

/* ---------- Mensagens e selos ---------- */
.alert, .notice, [role="status"].error, [role="status"].ok, [role="status"].warn {
	margin: 12px 0 0; padding: 10px 14px; border: 1px solid transparent; border-radius: var(--radius); font-size: 13px;
}
.alert, [role="status"].error { color: var(--danger); background: var(--danger-bg); border-color: color-mix(in srgb, var(--danger) 22%, transparent); }
[role="status"].ok { color: var(--success); background: var(--success-bg); border-color: color-mix(in srgb, var(--success) 22%, transparent); }
.notice.warning, [role="status"].warn { color: var(--warning); background: var(--warning-bg); border-color: color-mix(in srgb, var(--warning) 22%, transparent); }
[role="status"]:empty { display: none; }
.badge {
	display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 2px 9px; border-radius: 999px;
	font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--neutral); background: var(--neutral-bg);
}
.badge[data-tone="success"] { color: var(--success); background: var(--success-bg); }
.badge[data-tone="warning"] { color: var(--warning); background: var(--warning-bg); }
.badge[data-tone="danger"] { color: var(--danger); background: var(--danger-bg); }
.badge[data-tone="info"] { color: var(--info); background: var(--info-bg); }
.badge:empty { display: none; }
.tone-ok { color: var(--success); font-weight: 600; }
.tone-bad { color: var(--danger); font-weight: 600; }
.tone-warn { color: var(--warning); font-weight: 600; }

/* ---------- Andamento da atualização ---------- */
.banner {
	display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin: 0 0 16px; padding: 10px 14px;
	color: var(--info); background: var(--info-bg); border: 1px solid color-mix(in srgb, var(--info) 22%, transparent); border-radius: var(--radius); font-size: 13px;
}
.banner[hidden] { display: none; }
.banner[data-tone="success"] { color: var(--success); background: var(--success-bg); border-color: color-mix(in srgb, var(--success) 22%, transparent); }
.banner[data-tone="warning"] { color: var(--warning); background: var(--warning-bg); border-color: color-mix(in srgb, var(--warning) 22%, transparent); }
.banner span { flex: 1 1 240px; font-weight: 600; }
.banner a { color: inherit; font-weight: 600; }
.progress-box { margin-top: 16px; padding: 16px 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-alt); }
.progress-box h3 { margin: 0; font-size: 15px; }
.progress-box button { margin-top: 14px; }
.progress-box p { margin: 14px 0 0; }
.progress { height: 4px; margin-top: 12px; overflow: hidden; border-radius: 2px; background: var(--border); }
.progress::after { content: ""; display: block; width: 35%; height: 100%; border-radius: 2px; background: var(--accent); animation: progresso 1.6s ease-in-out infinite; }
.progress[data-state="done"]::after { width: 100%; background: var(--success); animation: none; }
.progress[data-state="late"]::after { width: 100%; background: var(--warning); animation: none; }
@keyframes progresso { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.steps { display: grid; gap: 10px; margin: 14px 0 0; padding: 0; list-style: none; }
.steps li { display: grid; grid-template-columns: 18px 1fr; gap: 0 10px; align-items: start; }
.steps li::before { content: ""; width: 12px; height: 12px; margin-top: 4px; border: 2px solid var(--border-strong, var(--border)); border-radius: 50%; }
.steps li[data-state="done"]::before { border-color: var(--success); background: var(--success); }
.steps li[data-state="active"]::before { border-color: var(--accent); border-top-color: transparent; animation: girar 0.9s linear infinite; }
.steps li[data-state="late"]::before { border-color: var(--warning); }
.steps li[data-state="pending"] { color: var(--muted); }
.steps li strong { grid-column: 2; font-weight: 600; }
.steps li small { grid-column: 2; color: var(--muted); font-size: 12px; }
@keyframes girar { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
	.progress::after { width: 100%; opacity: 0.5; animation: none; }
	.steps li[data-state="active"]::before { border-top-color: var(--accent); animation: none; }
}

/* ---------- Entrada ---------- */
.login { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
.login-card { width: min(420px, 100%); padding: 28px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow-raised); }
.login-card h1 { margin-bottom: 6px; }
.login-card .primary { margin-top: 18px; }

/* ---------- Casca ---------- */
.shell { min-height: 100vh; }
.sidebar {
	position: fixed; inset: 0 auto 0 0; z-index: 30; width: var(--sidebar); padding: 18px 12px 14px; overflow-y: auto;
	display: flex; flex-direction: column; gap: 2px; background: var(--nav); border-right: 1px solid var(--border);
}
.brand { display: grid; gap: 2px; padding: 4px 10px 16px; }
.brand strong { color: var(--heading); font-size: 19px; font-weight: 800; letter-spacing: -.02em; }
.brand-holder { color: var(--nav-muted); font-size: 12px; overflow-wrap: anywhere; }
.nav-group { margin: 16px 10px 6px; color: var(--nav-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.nav-item {
	display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 6px 10px; border-radius: var(--radius);
	color: var(--nav-text); font-weight: 500; text-decoration: none;
}
.nav-item:hover { background: var(--nav-hover); }
.nav-item[aria-current="page"] { background: var(--nav-active); color: var(--nav-active-text); font-weight: 600; }
.nav-item .ico { flex: none; }
.dot { width: 8px; height: 8px; margin-left: auto; border-radius: 50%; background: var(--accent); }
.sidebar-foot { margin-top: auto; padding: 14px 10px 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; border-top: 1px solid var(--border); }
.workspace { margin-left: var(--sidebar); min-width: 0; }
.topbar {
	position: sticky; top: 0; z-index: 20; height: var(--topbar); padding: 0 var(--gutter); display: flex; align-items: center; gap: 10px;
	background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border);
}
.topbar #menu { display: none; }
.topbar-space { flex: 1; }
.crumb { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.content { max-width: 1520px; padding: 22px var(--gutter) 56px; }
.backdrop { position: fixed; inset: 0; z-index: 25; background: rgb(19 18 24 / 40%); }
/* Com o detalhe aberto, o fundo cobre também o menu lateral. */
.backdrop.over { z-index: 35; }
.heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.heading p { margin: 4px 0 0; }
.heading-controls { display: flex; gap: 12px; flex-wrap: wrap; }
.heading-controls .field { min-width: 170px; }

/* ---------- Cartões ---------- */
.card { padding: 20px; margin-bottom: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow); }
.card.flush { padding: 0; overflow: hidden; }
.card.narrow { max-width: 720px; }
.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.card-head h2 { margin: 0; }
.card-head.pad { padding: 18px 20px 0; }
.hint.pad { margin: 0; padding: 12px 20px 16px; }
.checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0 18px; margin-bottom: 4px; }
.vazio { color: var(--muted); }
a.secondary, a.primary { text-decoration: none; }
.settings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.settings .card { margin: 0; }
.settings .card.wide { grid-column: 1 / -1; }
.logo { display: block; max-width: 220px; max-height: 120px; margin: 12px 0; padding: 8px; background: #fff; border: 1px solid var(--border); border-radius: 6px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0 0 12px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
details { margin-top: 16px; }
summary { cursor: pointer; color: var(--accent-strong); font-weight: 600; }
.results { list-style: none; margin: 4px 0 0; padding: 0; }
.results li { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 11px 0; border-top: 1px solid var(--border); }
.results li:first-child { border-top: 0; }
.results .detail { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.results .acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ---------- Visão geral ---------- */
.overview { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
.overview-side { position: sticky; top: calc(var(--topbar) + 16px); }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.metric { display: flex; flex-direction: column; gap: 10px; padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow); }
.metric.featured { background: linear-gradient(180deg, var(--accent-soft), var(--surface)); }
.metric > span { color: var(--muted); font-size: 13px; }
.metric strong { color: var(--heading); font-size: 26px; font-weight: 700; letter-spacing: -.03em; line-height: 1.15; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.metric small { color: var(--muted); font-size: 12px; }
.chart { display: flex; align-items: flex-end; gap: 3px; height: 180px; padding-top: 8px; }
.bar { flex: 1 1 0; min-width: 2px; height: 100%; display: flex; align-items: flex-end; border-radius: 4px 4px 0 0; }
.bar:hover { background: var(--surface-alt); }
.bar > span { display: block; width: 100%; min-height: 0; background: var(--series); border-radius: 4px 4px 0 0; }
.bar.zero > span { min-height: 2px; background: var(--border); }
.chart-axis { display: flex; justify-content: space-between; margin-top: 6px; color: var(--muted); font-size: 12px; }
.empty-inline { margin: 0; padding: 28px 0; text-align: center; color: var(--muted); }
.attention { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.attention li { padding: 10px 12px; border-radius: var(--radius); background: var(--neutral-bg); font-size: 13px; }
.attention li[data-tone="danger"] { color: var(--danger); background: var(--danger-bg); }
.attention li[data-tone="warning"] { color: var(--warning); background: var(--warning-bg); }
.attention li[data-tone="info"] { color: var(--info); background: var(--info-bg); }
.attention li strong { display: block; }
.attention a { color: inherit; font-weight: 600; }

/* ---------- Listagens ---------- */
.list-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow); overflow: hidden; margin-bottom: 16px; }
.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 14px; padding: 16px 18px; background: var(--surface-alt); border-bottom: 1px solid var(--border); }
.filters .field { margin-top: 0; min-width: 150px; flex: 0 1 170px; }
.filters .field.grow { flex: 1 1 260px; }
.filter-actions { display: flex; gap: 8px; }
.list-summary { margin: 0; padding: 12px 18px; font-size: 13px; border-bottom: 1px solid var(--border); }
.list-card > .alert { margin: 12px 18px; }
.table-wrap { overflow-x: auto; }
table.data { width: 100%; border-collapse: separate; border-spacing: 0; font-variant-numeric: tabular-nums; }
table.data th { padding: 10px 12px; text-align: left; white-space: nowrap; color: var(--muted); background: var(--surface-alt); border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; }
table.data td { height: 46px; padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.data th.num, table.data td.num { text-align: right; }
table.data th:first-child, table.data td:first-child { padding-left: 18px; }
table.data th:last-child, table.data td:last-child { padding-right: 18px; }
table.data tbody tr:last-child td { border-bottom: 0; }
table.data.clickable tbody tr { cursor: pointer; }
table.data.clickable tbody tr:hover td { background: var(--surface-hover); }
table.data tr[aria-selected="true"] td { background: var(--accent-soft); }
td .sub { display: block; color: var(--muted); font-size: 12.5px; }
td.nowrap { white-space: nowrap; }
.empty { padding: 44px 22px; text-align: center; color: var(--muted); }
.empty p { max-width: 460px; margin: 6px auto 0; }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.pager:empty { display: none; }
.pager .row { margin: 0; }

/* ---------- Detalhe ---------- */
.drawer {
	position: fixed; inset: 0 0 0 auto; z-index: 40; width: min(560px, 100%); display: flex; flex-direction: column;
	background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-modal);
}
.drawer-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
.drawer-head h2 { margin: 0; font-size: 18px; }
.drawer-body { flex: 1; overflow-y: auto; padding: 18px 20px 28px; }
.drawer-body h3 { margin: 22px 0 8px; font-size: 14px; }
.drawer-body .row { margin-top: 10px; }
.drawer-body dl { grid-template-columns: 130px 1fr; }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { padding: 9px 0; border-top: 1px solid var(--border); }
.timeline li:first-child { border-top: 0; }
.timeline .sub { display: block; color: var(--muted); font-size: 12.5px; }
.inline-form { margin-top: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-alt); }
.inline-form .field:first-child { margin-top: 0; }

/* ---------- Telas menores ---------- */
@media (max-width: 1180px) {
	.overview { grid-template-columns: 1fr; }
	.overview-side { position: static; }
	.metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 1050px) {
	.sidebar { transform: translateX(-100%); transition: transform 160ms; box-shadow: var(--shadow-modal); }
	.sidebar.open { transform: none; }
	.workspace { margin-left: 0; }
	.topbar #menu { display: inline-flex; }
	.settings { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
	:root { --gutter: 14px; --control: 42px; }
	h1 { font-size: 21px; }
	input, select, textarea { font-size: 16px !important; }
	.metrics { grid-template-columns: 1fr; }
	.filters .field, .filters .field.grow { flex: 1 1 100%; }
	.filter-actions { width: 100%; }
	.filter-actions button { flex: 1; }
	.opt { display: none; }
	.topbar #top-cert { display: none; }
	.heading-controls { width: 100%; }
	.heading-controls .field { flex: 1 1 140px; min-width: 0; }
	/* As listagens rolam para o lado em vez de quebrar cada célula em várias linhas. */
	table.data.clickable { min-width: 620px; }
	.drawer-body dl { grid-template-columns: 1fr; gap: 0; }
	.drawer-body dd { margin-bottom: 8px; }
}`;
