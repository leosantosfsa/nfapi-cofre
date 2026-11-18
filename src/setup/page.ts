// Painel do emitente, servido em /setup: visão geral, notas emitidas e
// recebidas, e a configuração do cofre.
//
// HTML, CSS e JS são arquivos separados (rotas próprias) para permitir uma CSP
// sem 'unsafe-inline'. O JS não usa innerHTML: todo texto vindo do servidor
// entra por textContent. Por causa da CSP, não há atributo style no HTML.

import { VAULT_VERSION } from "../protocol";

export { SETUP_CSS } from "./estilo";
export { SETUP_JS } from "./script";

const icone = (caminhos: string) =>
	`<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${caminhos}</svg>`;

const ICONES = {
	visao: icone('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
	emitidas: icone('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6"/><path d="M9.5 13.5 12 11l2.5 2.5"/>'),
	recebidas: icone('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6"/><path d="M9.5 14.5 12 17l2.5-2.5"/>'),
	relatorios: icone('<path d="M4 20h16"/><rect x="6" y="11" width="3" height="6" rx="1"/><rect x="11" y="6" width="3" height="11" rx="1"/><rect x="16" y="9" width="3" height="8" rx="1"/>'),
	configuracao: icone('<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/>'),
	chaves: icone('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 7l3 3"/>'),
	atualizacao: icone('<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>'),
	atividade: icone('<path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>'),
	menu: icone('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'),
	fechar: icone('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
};

const PERIODOS = `<option value="mes">Este mês</option>
						<option value="mes-passado">Mês passado</option>
						<option value="7">Últimos 7 dias</option>
						<option value="30">Últimos 30 dias</option>
						<option value="ano">Este ano</option>`;

const AMBIENTES = `<option value="producao">Produção</option>
						<option value="homologacao">Homologação</option>`;

export const SETUP_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cofre NFapi</title>
<link rel="stylesheet" href="/setup/app.css">
</head>
<body>

<main id="login" class="login">
	<div class="login-card">
		<p class="eyebrow">Cofre NFapi</p>
		<h1>Entrar no painel</h1>
		<p class="muted">O certificado digital e as notas fiscais ficam aqui, na sua conta Cloudflare.</p>
		<form id="login-form">
			<div class="field">
				<label for="secret">Segredo do cofre</label>
				<input id="secret" type="password" autocomplete="off" required>
				<p class="hint">É o <code>VAULT_SECRET</code> definido na instalação.</p>
			</div>
			<button type="submit" class="primary wide">Entrar</button>
		</form>
		<p id="login-error" class="alert" role="alert" hidden></p>
	</div>
</main>

<div id="panel" class="shell" data-versao="${VAULT_VERSION}" hidden>
	<div id="backdrop" class="backdrop" hidden></div>

	<nav id="sidebar" class="sidebar" aria-label="Seções do painel">
		<div class="brand">
			<strong>Cofre NFapi</strong>
			<span id="brand-holder" class="brand-holder"></span>
		</div>
		<a class="nav-item" href="#visao-geral" data-nav="visao-geral">${ICONES.visao}<span>Visão geral</span></a>
		<p class="nav-group">Notas</p>
		<a class="nav-item" href="#emitidas" data-nav="emitidas">${ICONES.emitidas}<span>Emitidas</span></a>
		<a class="nav-item" href="#recebidas" data-nav="recebidas">${ICONES.recebidas}<span>Recebidas</span></a>
		<a class="nav-item" href="#relatorios" data-nav="relatorios">${ICONES.relatorios}<span>Relatórios e exportação</span></a>
		<p class="nav-group">Cofre</p>
		<a class="nav-item" href="#configuracao" data-nav="configuracao">${ICONES.configuracao}<span>Configuração</span></a>
		<a class="nav-item" href="#chaves" data-nav="chaves">${ICONES.chaves}<span>Chaves de API</span></a>
		<a class="nav-item" href="#atualizacao" data-nav="atualizacao">${ICONES.atualizacao}<span>Atualização</span><span id="nav-update" class="dot" hidden></span></a>
		<a class="nav-item" href="#atividade" data-nav="atividade">${ICONES.atividade}<span>Atividade</span></a>
		<div class="sidebar-foot">
			<span id="version" class="muted small"></span>
			<button type="button" id="logout" class="link">Sair</button>
		</div>
	</nav>

	<div class="workspace">
		<header class="topbar">
			<button type="button" id="menu" class="icon-button" aria-label="Abrir o menu">${ICONES.menu}</button>
			<span id="crumb" class="crumb"></span>
			<span class="topbar-space"></span>
			<span id="top-env" class="badge"></span>
			<span id="top-cert" class="badge"></span>
		</header>

		<main class="content">
			<!-- Andamento da atualização e aviso de que a página ficou velha, em qualquer tela. -->
			<div id="update-banner" class="banner" role="status" hidden>
				<span id="update-banner-text"></span>
				<a id="update-banner-link" href="#atualizacao">Acompanhar</a>
				<button type="button" id="update-banner-reload" class="primary small-button" hidden>Recarregar a página</button>
			</div>

			<!-- ---------- Visão geral ---------- -->
			<section class="view" data-view="visao-geral" hidden>
				<div class="heading">
					<div>
						<p class="eyebrow">Painel do emitente</p>
						<h1>Visão geral</h1>
						<p class="muted">As notas do período e o que precisa da sua atenção.</p>
					</div>
					<div class="heading-controls">
						<div class="field compact">
							<label for="vg-ambiente">Ambiente</label>
							<select id="vg-ambiente">${AMBIENTES}</select>
						</div>
						<div class="field compact">
							<label for="vg-periodo">Período</label>
							<select id="vg-periodo">${PERIODOS}</select>
						</div>
					</div>
				</div>
				<p id="vg-erro" class="alert" role="alert" hidden></p>
				<div class="overview">
					<div class="overview-main">
						<div id="vg-kpis" class="metrics"></div>
						<section class="card">
							<div class="card-head">
								<h2>Notas autorizadas por dia</h2>
								<span id="vg-chart-total" class="muted small"></span>
							</div>
							<div id="vg-chart" class="chart" role="img" aria-label="Valor das notas autorizadas em cada dia do período"></div>
							<p id="vg-chart-empty" class="empty-inline" hidden>Nenhuma nota autorizada neste período.</p>
						</section>
						<section class="card flush">
							<div class="card-head pad">
								<h2>Por documento</h2>
								<span id="vg-periodo-texto" class="muted small"></span>
							</div>
							<div class="table-wrap">
								<table class="data">
									<thead><tr><th>Documento</th><th class="num">Autorizadas</th><th class="num">Valor autorizado</th><th class="num">Canceladas</th><th class="num">Não autorizadas</th></tr></thead>
									<tbody id="vg-modelos"></tbody>
								</table>
							</div>
						</section>
					</div>
					<aside class="overview-side">
						<section class="card">
							<h2>Precisa de atenção</h2>
							<ul id="vg-atencao" class="attention"></ul>
							<p id="vg-atencao-vazio" class="muted small" hidden>Nada pendente. O cofre está em ordem.</p>
						</section>
					</aside>
				</div>
			</section>

			<!-- ---------- Notas emitidas ---------- -->
			<section class="view" data-view="emitidas" hidden>
				<div class="heading">
					<div>
						<h1>Notas emitidas</h1>
						<p class="muted">NFS-e, NF-e e NFC-e emitidas por este cofre. Os arquivos ficam guardados aqui.</p>
					</div>
				</div>
				<div class="list-card">
					<form id="em-filtros" class="filters">
						<div class="field"><label for="em-periodo">Período</label>
							<select id="em-periodo">${PERIODOS}<option value="tudo">Todo o histórico</option><option value="datas">Escolher datas</option></select></div>
						<div class="field" data-datas hidden><label for="em-de">De</label><input id="em-de" type="date"></div>
						<div class="field" data-datas hidden><label for="em-ate">Até</label><input id="em-ate" type="date"></div>
						<div class="field"><label for="em-modelo">Documento</label>
							<select id="em-modelo"><option value="">Todos</option><option value="nfse">NFS-e</option><option value="nfe">NF-e</option><option value="nfce">NFC-e</option></select></div>
						<div class="field"><label for="em-situacao">Situação</label>
							<select id="em-situacao"><option value="">Todas</option><option value="autorizada">Autorizada</option><option value="cancelada">Cancelada</option><option value="rejeitada">Rejeitada</option><option value="denegada">Denegada</option><option value="contingencia">Em contingência</option><option value="indefinida">Sem resposta</option><option value="processando">Em andamento</option><option value="erro">Não enviada</option></select></div>
						<div class="field"><label for="em-ambiente">Ambiente</label>
							<select id="em-ambiente"><option value="">Todos</option>${AMBIENTES}</select></div>
						<div class="field grow"><label for="em-busca">Buscar</label>
							<input id="em-busca" type="search" placeholder="Número, chave de acesso, nome ou documento do destinatário"></div>
						<div class="filter-actions">
							<button type="submit" class="primary">Filtrar</button>
							<button type="button" id="em-limpar" class="secondary">Limpar</button>
						</div>
					</form>
					<p id="em-resumo" class="list-summary muted"></p>
					<p id="em-erro" class="alert" role="alert" hidden></p>
					<div class="table-wrap">
						<table class="data clickable">
							<thead><tr><th>Emissão</th><th>Documento</th><th>Destinatário</th><th class="num">Valor</th><th>Situação</th></tr></thead>
							<tbody id="em-linhas"></tbody>
						</table>
					</div>
					<div id="em-vazio" class="empty" hidden>
						<h3>Nenhuma nota encontrada</h3>
						<p>Mude o período ou os filtros. As notas aparecem aqui assim que os seus sistemas emitem pela API.</p>
					</div>
					<div id="em-paginas" class="pager"></div>
				</div>
			</section>

			<!-- ---------- Notas recebidas ---------- -->
			<section class="view" data-view="recebidas" hidden>
				<div class="heading">
					<div>
						<h1>Notas recebidas</h1>
						<p class="muted">Notas que outras empresas emitiram contra o CNPJ deste certificado, baixadas do Ambiente Nacional da NF-e.</p>
					</div>
				</div>
				<section class="card">
					<div class="card-head">
						<h2>Consulta ao Ambiente Nacional</h2>
						<a class="small" href="#configuracao">Configurar</a>
					</div>
					<ul id="dfe-status" class="results"></ul>
					<p id="dfe-vazio" class="muted small" hidden>A consulta ainda não foi configurada. Informe a UF do estabelecimento em Configuração.</p>
					<p id="dfe-message" role="status"></p>
				</section>
				<div class="list-card">
					<form id="rc-filtros" class="filters">
						<div class="field"><label for="rc-periodo">Período</label>
							<select id="rc-periodo"><option value="tudo">Todo o histórico</option>${PERIODOS}<option value="datas">Escolher datas</option></select></div>
						<div class="field" data-datas hidden><label for="rc-de">De</label><input id="rc-de" type="date"></div>
						<div class="field" data-datas hidden><label for="rc-ate">Até</label><input id="rc-ate" type="date"></div>
						<div class="field"><label for="rc-situacao">Situação</label>
							<select id="rc-situacao"><option value="">Todas</option><option value="autorizada">Autorizada</option><option value="cancelada">Cancelada</option><option value="denegada">Denegada</option></select></div>
						<div class="field"><label for="rc-xml">Arquivo</label>
							<select id="rc-xml"><option value="">Todos</option><option value="completo">Com o XML completo</option><option value="resumo">Só o resumo</option></select></div>
						<div class="field"><label for="rc-ambiente">Ambiente</label>
							<select id="rc-ambiente"><option value="">Todos</option>${AMBIENTES}</select></div>
						<div class="field grow"><label for="rc-busca">Buscar</label>
							<input id="rc-busca" type="search" placeholder="Número, chave de acesso, nome ou CNPJ do emitente"></div>
						<div class="filter-actions">
							<button type="submit" class="primary">Filtrar</button>
							<button type="button" id="rc-limpar" class="secondary">Limpar</button>
						</div>
					</form>
					<p id="rc-resumo" class="list-summary muted"></p>
					<p id="rc-erro" class="alert" role="alert" hidden></p>
					<div class="table-wrap">
						<table class="data clickable">
							<thead><tr><th>Emissão</th><th>Nota</th><th>Emitente</th><th class="num">Valor</th><th>Situação</th><th>Manifestação</th></tr></thead>
							<tbody id="rc-linhas"></tbody>
						</table>
					</div>
					<div id="rc-vazio" class="empty" hidden>
						<h3>Nenhuma nota recebida</h3>
						<p>Mude os filtros ou consulte o Ambiente Nacional. As notas dos últimos 90 dias chegam na primeira consulta.</p>
					</div>
					<div id="rc-paginas" class="pager"></div>
				</div>
			</section>

			<!-- ---------- Relatórios e exportação ---------- -->
			<section class="view" data-view="relatorios" hidden>
				<div class="heading">
					<div>
						<h1>Relatórios e exportação</h1>
						<p class="muted">Os totais do período, com os impostos lidos dos XML, e os arquivos para mandar ao contador.</p>
					</div>
					<form id="rl-filtros" class="heading-controls">
						<div class="field compact"><label for="rl-ambiente">Ambiente</label>
							<select id="rl-ambiente">${AMBIENTES}</select></div>
						<div class="field compact"><label for="rl-periodo">Período</label>
							<select id="rl-periodo">${PERIODOS}<option value="datas">Escolher datas</option></select></div>
						<div class="field compact" data-datas hidden><label for="rl-de">De</label><input id="rl-de" type="date"></div>
						<div class="field compact" data-datas hidden><label for="rl-ate">Até</label><input id="rl-ate" type="date"></div>
						<div class="field compact" data-datas hidden><label>&nbsp;</label><button type="submit" class="secondary">Aplicar</button></div>
					</form>
				</div>
				<p id="rl-erro" class="alert" role="alert" hidden></p>
				<p id="rl-lendo" class="notice warning" hidden></p>

				<section class="card">
					<div class="card-head">
						<h2>Exportar os XML do período</h2>
						<span id="rl-periodo-texto" class="muted small"></span>
					</div>
					<p>Um arquivo ZIP com os XML organizados em pastas e uma planilha de resumo (número, chave, destinatário, situação, valor e impostos de cada nota).</p>
					<form id="ex-form">
						<div class="checks">
							<label class="check"><input type="checkbox" id="ex-emitidas" checked> Notas emitidas (NFS-e, NF-e e NFC-e)</label>
							<label class="check"><input type="checkbox" id="ex-eventos" checked> Eventos: cancelamento e carta de correção</label>
							<label class="check"><input type="checkbox" id="ex-inutilizacoes" checked> Inutilizações de numeração</label>
							<label class="check"><input type="checkbox" id="ex-recebidas" checked> Notas recebidas, com as manifestações</label>
						</div>
						<button type="submit" class="primary">Gerar arquivos</button>
					</form>
					<p id="ex-message" role="status"></p>
					<div id="ex-resultado" hidden>
						<p id="ex-resumo" class="small"></p>
						<div id="ex-links" class="row"></div>
						<p id="ex-validade" class="hint"></p>
					</div>
				</section>

				<div id="rl-kpis" class="metrics"></div>
				<div class="settings">
					<section class="card flush">
						<div class="card-head pad"><h2>Impostos e totais</h2><span class="muted small">Notas autorizadas</span></div>
						<div class="table-wrap">
							<table class="data">
								<thead><tr><th>Total</th><th class="num">Emitidas</th><th class="num">Recebidas</th></tr></thead>
								<tbody id="rl-impostos"></tbody>
							</table>
						</div>
						<p class="hint pad">Das notas recebidas, entram só as que já têm o XML completo. IBS e CBS da NFS-e ainda não são lidos.</p>
					</section>
					<section class="card flush">
						<div class="card-head pad"><h2>Por situação</h2><span class="muted small">Notas emitidas</span></div>
						<div class="table-wrap">
							<table class="data">
								<thead><tr><th>Documento</th><th>Situação</th><th class="num">Notas</th><th class="num">Valor</th></tr></thead>
								<tbody id="rl-situacoes"></tbody>
							</table>
						</div>
					</section>
					<section class="card flush">
						<div class="card-head pad"><h2>Por CFOP</h2><span class="muted small">Notas emitidas</span></div>
						<div class="table-wrap">
							<table class="data">
								<thead><tr><th>CFOP</th><th class="num">Notas</th><th class="num">Valor dos itens</th></tr></thead>
								<tbody id="rl-cfops"></tbody>
							</table>
						</div>
					</section>
					<section class="card flush">
						<div class="card-head pad"><h2>Por natureza da operação</h2><span class="muted small">Notas emitidas</span></div>
						<div class="table-wrap">
							<table class="data">
								<thead><tr><th>Natureza</th><th class="num">Notas</th><th class="num">Valor</th></tr></thead>
								<tbody id="rl-naturezas"></tbody>
							</table>
						</div>
					</section>
					<section class="card flush">
						<div class="card-head pad"><h2>Maiores destinatários</h2><span class="muted small">Notas emitidas</span></div>
						<div class="table-wrap">
							<table class="data">
								<thead><tr><th>Destinatário</th><th class="num">Notas</th><th class="num">Valor</th></tr></thead>
								<tbody id="rl-destinatarios"></tbody>
							</table>
						</div>
					</section>
					<section class="card flush">
						<div class="card-head pad"><h2>Maiores fornecedores</h2><span class="muted small">Notas recebidas</span></div>
						<div class="table-wrap">
							<table class="data">
								<thead><tr><th>Emitente</th><th class="num">Notas</th><th class="num">Valor</th></tr></thead>
								<tbody id="rl-emitentes"></tbody>
							</table>
						</div>
					</section>
				</div>
			</section>

			<!-- ---------- Configuração ---------- -->
			<section class="view" data-view="configuracao" hidden>
				<div class="heading">
					<div>
						<h1>Configuração</h1>
						<p class="muted">O certificado, o ambiente, as séries e a consulta das notas recebidas.</p>
					</div>
				</div>
				<div class="settings">
					<section class="card">
						<h2>Certificado digital A1</h2>
						<div id="cert-status"></div>
						<form id="cert-form">
							<div class="field"><label for="pfx">Arquivo do certificado (.pfx ou .p12)</label>
								<input id="pfx" type="file" accept=".pfx,.p12" required></div>
							<div class="field"><label for="pfx-password">Senha do certificado</label>
								<input id="pfx-password" type="password" autocomplete="off" required></div>
							<div class="row">
								<button type="submit" class="primary">Instalar certificado</button>
								<button type="button" id="cert-remove" class="danger" hidden>Remover</button>
							</div>
						</form>
						<p class="hint">O arquivo é lido por este cofre, cifrado e gravado no seu banco D1. A senha não é guardada.</p>
						<p id="cert-message" role="status"></p>
					</section>

					<section class="card">
						<h2>Ambiente</h2>
						<p id="env-status"></p>
						<button type="button" id="env-toggle" class="secondary"></button>
						<p class="hint">Enquanto a produção estiver bloqueada, o cofre recusa assinar qualquer documento com valor fiscal.</p>
						<h2 class="spaced">Teste de conexão</h2>
						<p>Consulta o status dos serviços de <strong>homologação</strong> com o certificado instalado. Nenhuma nota é emitida.</p>
						<button type="button" id="selftest" class="secondary">Testar conexão com o governo</button>
						<ul id="selftest-results" class="results"></ul>
					</section>

					<section class="card">
						<h2>Séries de NF-e e NFC-e</h2>
						<p>A NF-e e a NFC-e só são emitidas em séries cadastradas aqui. O cofre numera cada série em sequência; se a empresa já emitiu por outro sistema, informe o número da próxima nota.</p>
						<ul id="series" class="results"></ul>
						<p id="series-empty" class="muted small" hidden>Nenhuma série cadastrada. A NFS-e não precisa de cadastro.</p>
						<form id="serie-form">
							<div class="grid">
								<div class="field"><label for="serie-modelo">Documento</label>
									<select id="serie-modelo"><option value="nfe">NF-e (modelo 55)</option><option value="nfce">NFC-e (modelo 65)</option></select></div>
								<div class="field"><label for="serie-ambiente">Ambiente</label>
									<select id="serie-ambiente"><option value="homologacao">Homologação</option><option value="producao">Produção</option></select></div>
								<div class="field"><label for="serie-numero">Série (0 a 889)</label>
									<input id="serie-numero" type="text" inputmode="numeric" maxlength="3" value="1" required></div>
								<div class="field"><label for="serie-proximo">Próxima nota</label>
									<input id="serie-proximo" type="text" inputmode="numeric" maxlength="9" placeholder="1"></div>
							</div>
							<div class="field"><label for="serie-descricao">Descrição (ex.: Caixa 1)</label>
								<input id="serie-descricao" type="text" maxlength="60"></div>
							<button type="submit" class="primary">Salvar série</button>
						</form>
						<p id="series-message" role="status"></p>
					</section>

					<section class="card">
						<h2>Logotipo</h2>
						<p>Sai no DANFE da NF-e e no DANFE NFC-e que o cofre gera em PDF. Envie uma imagem PNG ou JPEG de até 300 KB.</p>
						<p id="logo-empty" class="muted small" hidden>Nenhum logotipo cadastrado: os documentos saem sem imagem.</p>
						<img id="logo-preview" class="logo" alt="Logotipo cadastrado" hidden>
						<form id="logo-form">
							<div class="field"><label for="logo-file">Imagem</label>
								<input id="logo-file" type="file" accept="image/png,image/jpeg" required></div>
							<div class="row">
								<button type="submit" class="primary">Enviar logotipo</button>
								<button type="button" id="logo-remove" class="danger" hidden>Remover logotipo</button>
							</div>
						</form>
						<p id="logo-message" role="status"></p>
					</section>

					<section class="card wide">
						<h2>Consulta das notas recebidas</h2>
						<p>O cofre baixa do Ambiente Nacional as notas emitidas contra o CNPJ do certificado e as entrega aos seus sistemas pela API.</p>
						<form id="dfe-form">
							<div class="grid">
								<div class="field"><label for="dfe-ambiente">Ambiente</label>
									<select id="dfe-ambiente"><option value="homologacao">Homologação</option><option value="producao">Produção</option></select></div>
								<div class="field"><label for="dfe-uf">UF do estabelecimento</label>
									<select id="dfe-uf"></select></div>
							</div>
							<label class="check"><input type="checkbox" id="dfe-auto"> Consultar sozinho, no ritmo que o Ambiente Nacional permite (uma vez por hora)</label>
							<label class="check"><input type="checkbox" id="dfe-ciencia"> Registrar sozinho a ciência da operação das notas novas</label>
							<p class="hint">A ciência libera o XML completo da nota. É um evento fiscal em nome da empresa: declara que ela sabe da nota, sem confirmar a operação. Desligada, a ciência é registrada nota a nota, aqui ou pela API.</p>
							<div class="row">
								<button type="submit" class="primary">Salvar</button>
								<button type="button" id="dfe-sync" class="secondary">Consultar agora</button>
							</div>
						</form>
						<p id="dfe-config-message" role="status"></p>
						<p class="hint">Se outro sistema também consultar as notas recebidas deste CNPJ (o do contador, um ERP antigo), o Ambiente Nacional pode bloquear as consultas por uma hora a cada desencontro. O cofre não perde documentos por isso: busca um a um os que ficarem para trás. Se o outro sistema já registra a ciência das notas, deixe a ciência automática desligada.</p>
					</section>
				</div>
			</section>

			<!-- ---------- Chaves de API ---------- -->
			<section class="view" data-view="chaves" hidden>
				<div class="heading">
					<div>
						<h1>Chaves de API</h1>
						<p class="muted">Os seus sistemas emitem notas chamando este cofre direto, com uma chave de API.</p>
					</div>
				</div>
				<div class="settings">
					<section class="card">
						<h2>Criar chave</h2>
						<p class="small">Endereço da API: <code id="api-base"></code></p>
						<form id="apikey-form">
							<div class="field"><label for="apikey-name">Nome da chave (ex.: o sistema que vai usá-la)</label>
								<input id="apikey-name" type="text" maxlength="80" placeholder="Meu sistema"></div>
							<div class="field"><label for="apikey-scope">O que a chave pode fazer</label>
								<select id="apikey-scope"><option value="completo">Homologação e produção</option><option value="homologacao">Somente homologação (testes)</option></select></div>
							<button type="submit" class="primary">Criar chave de API</button>
						</form>
						<div id="apikey-box" hidden>
							<p class="notice warning">Copie agora: a chave aparece uma única vez.</p>
							<textarea id="apikey-value" readonly rows="2"></textarea>
							<button type="button" id="apikey-copy" class="secondary">Copiar chave</button>
						</div>
					</section>
					<section class="card">
						<h2>Chaves criadas</h2>
						<ul id="apikeys" class="results"></ul>
					</section>
				</div>
			</section>

			<!-- ---------- Atualização ---------- -->
			<section class="view" data-view="atualizacao" hidden>
				<div class="heading">
					<div>
						<h1>Atualização</h1>
						<p class="muted">As versões novas do cofre entram por um clique.</p>
					</div>
				</div>
				<section class="card narrow" id="update-section">
					<p id="update-status"></p>
					<div class="row">
						<button type="button" id="update-run" class="primary" hidden>Atualizar agora</button>
						<button type="button" id="update-check" class="secondary">Verificar novamente</button>
					</div>
					<p id="update-message" role="status"></p>
					<div id="update-progress" class="progress-box" hidden>
						<h3 id="update-progress-title"></h3>
						<div id="update-progress-bar" class="progress" aria-hidden="true"></div>
						<ol id="update-steps" class="steps"></ol>
						<p id="update-progress-note" class="small muted"></p>
						<button type="button" id="update-reload" class="primary" hidden>Recarregar a página</button>
					</div>
					<details id="update-setup">
						<summary>Configurar o gatilho de atualização</summary>
						<p class="small">A atualização dispara um novo build deste cofre no Cloudflare. Crie o gatilho uma única vez:</p>
						<ol class="small">
							<li>No painel do Cloudflare, abra <strong>Workers &amp; Pages</strong> e selecione este Worker.</li>
							<li>Em <strong>Configurações &gt; Compilações &gt; Ganchos de implantação</strong> (em inglês, Settings &gt; Builds &gt; Deploy Hooks), clique em <strong>Adicionar</strong>, dê um nome ao gancho, escolha a branch <code>main</code> e salve.</li>
							<li>Copie a URL que aparece abaixo do gancho e cole aqui.</li>
						</ol>
						<form id="hook-form">
							<div class="field"><label for="hook-url">URL do gancho de implantação (Deploy Hook)</label>
								<input id="hook-url" type="password" autocomplete="off" placeholder="https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/..." required></div>
							<button type="submit" class="secondary">Salvar gatilho</button>
						</form>
						<p class="hint">Quem tem essa URL consegue disparar builds, então ela fica guardada cifrada neste cofre.</p>
					</details>
				</section>
			</section>

			<!-- ---------- Atividade ---------- -->
			<section class="view" data-view="atividade" hidden>
				<div class="heading">
					<div>
						<h1>Atividade</h1>
						<p class="muted">O que foi feito neste cofre, por quem e com que resultado.</p>
					</div>
				</div>
				<div class="list-card">
					<div class="table-wrap">
						<table class="data">
							<thead><tr><th>Quando</th><th>Ação</th><th>Quem</th><th>Resultado</th></tr></thead>
							<tbody id="audit"></tbody>
						</table>
					</div>
				</div>
			</section>
		</main>
	</div>

	<!-- ---------- Detalhe da nota ---------- -->
	<aside id="drawer" class="drawer" aria-labelledby="drawer-title" hidden>
		<header class="drawer-head">
			<div>
				<p id="drawer-kicker" class="eyebrow"></p>
				<h2 id="drawer-title"></h2>
			</div>
			<button type="button" id="drawer-close" class="icon-button" aria-label="Fechar">${ICONES.fechar}</button>
		</header>
		<div id="drawer-body" class="drawer-body"></div>
	</aside>
</div>

<script src="/setup/app.js"></script>
</body>
</html>`;
