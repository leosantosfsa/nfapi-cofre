// Comportamento do painel do emitente. Texto vindo do servidor entra sempre por
// textContent. Este arquivo vive dentro de String.raw: não usar crase nem
// cifrão seguido de chave no código abaixo.

export const SETUP_JS = String.raw`(function () {
	"use strict";
	var secret = "";
	var state = null;
	var atualizacao = null;
	var distribuicoes = [];
	var $ = function (id) { return document.getElementById(id); };

	// ---------- Utilidades ----------

	function el(tag, props, children) {
		var node = document.createElement(tag);
		Object.keys(props || {}).forEach(function (k) {
			if (k === "text") node.textContent = props[k];
			else if (k === "onclick") node.addEventListener("click", props[k]);
			else node.setAttribute(k, props[k]);
		});
		(children || []).forEach(function (c) { if (c) node.appendChild(c); });
		return node;
	}
	function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
	function date(iso) { return iso ? new Date(iso).toLocaleString("pt-BR") : "—"; }
	function dia(iso) { return iso ? new Date(iso).toLocaleDateString("pt-BR") : "—"; }
	function hora(iso) { return iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""; }
	function dinheiro(v) { return v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
	function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }
	function dois(n) { return String(n).padStart(2, "0"); }
	function isoDia(d) { return d.getFullYear() + "-" + dois(d.getMonth() + 1) + "-" + dois(d.getDate()); }
	function documento(doc) {
		if (!doc) return "";
		if (/^\d{14}$/.test(doc)) return doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
		if (/^\d{11}$/.test(doc)) return doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
		return doc;
	}
	function selo(texto, tom) { return el("span", { class: "badge", "data-tone": tom || "neutral", text: texto }); }

	async function api(method, path, body) {
		var init = { method: method, headers: { authorization: "Bearer " + secret } };
		if (body instanceof FormData) init.body = body;
		else if (body instanceof Blob) {
			// Arquivo enviado como está (o logotipo).
			init.headers["content-type"] = body.type || "application/octet-stream";
			init.body = body;
		} else if (body !== undefined) {
			init.headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		var res = await fetch(path, init);
		var json = await res.json().catch(function () { return null; });
		if (!res.ok) {
			var detalhe = json && ((json.error && json.error.message) || (json.erro && json.erro.mensagem));
			throw new Error(detalhe || ("Erro HTTP " + res.status));
		}
		return json;
	}

	async function busy(button, task) {
		// Formulário enviado pelo teclado pode não informar o botão.
		if (button) button.disabled = true;
		try { return await task(); } finally { if (button) button.disabled = false; }
	}

	// Mensagem de resultado de uma ação (some quando o texto é vazio).
	function message(id, text, kind) {
		var node = $(id);
		node.textContent = text;
		node.className = kind || "";
	}
	// Erro de carregamento de uma tela.
	function erro(id, text) {
		$(id).textContent = text || "";
		$(id).hidden = !text;
	}

	async function copiar(campo, botao, feito) {
		campo.select();
		try {
			await navigator.clipboard.writeText(campo.value);
			botao.textContent = feito;
		} catch (e) {
			document.execCommand("copy");
		}
	}

	async function baixarDe(caminho, nome) {
		var res = await fetch(caminho, { headers: { authorization: "Bearer " + secret } });
		if (!res.ok) throw new Error("Não foi possível baixar o arquivo (HTTP " + res.status + ").");
		var url = URL.createObjectURL(await res.blob());
		var link = el("a", { href: url, download: nome });
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}

	// Período escolhido num seletor: devolve os dias inicial e final (AAAA-MM-DD), ou nada para "todo o histórico".
	function periodo(prefixo) {
		var valor = $(prefixo + "-periodo").value;
		var hoje = new Date();
		if (valor === "tudo") return {};
		if (valor === "datas") return { de: $(prefixo + "-de").value || undefined, ate: $(prefixo + "-ate").value || undefined };
		if (valor === "mes") return { de: isoDia(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), ate: isoDia(hoje) };
		if (valor === "mes-passado") return { de: isoDia(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)), ate: isoDia(new Date(hoje.getFullYear(), hoje.getMonth(), 0)) };
		if (valor === "ano") return { de: isoDia(new Date(hoje.getFullYear(), 0, 1)), ate: isoDia(hoje) };
		var inicio = new Date(hoje);
		inicio.setDate(hoje.getDate() - (Number(valor) - 1));
		return { de: isoDia(inicio), ate: isoDia(hoje) };
	}
	function consulta(campos) {
		var partes = [];
		Object.keys(campos).forEach(function (k) {
			if (campos[k] !== undefined && campos[k] !== null && campos[k] !== "") partes.push(k + "=" + encodeURIComponent(campos[k]));
		});
		return partes.length ? "?" + partes.join("&") : "";
	}
	// Mostra os campos de data só quando o período é "Escolher datas".
	function ligarDatas(prefixo) {
		var ajustar = function () {
			var escolher = $(prefixo + "-periodo").value === "datas";
			$(prefixo + "-filtros").querySelectorAll("[data-datas]").forEach(function (campo) { campo.hidden = !escolher; });
		};
		$(prefixo + "-periodo").addEventListener("change", ajustar);
		ajustar();
	}
	function paginas(id, r, ir) {
		var box = $(id);
		clear(box);
		var total = Math.max(Math.ceil(r.total / r.porPagina), 1);
		if (r.total <= r.porPagina) return;
		var anterior = el("button", { type: "button", class: "secondary small-button", text: "Anterior" });
		var proxima = el("button", { type: "button", class: "secondary small-button", text: "Próxima" });
		anterior.disabled = r.pagina <= 1;
		proxima.disabled = r.pagina >= total;
		anterior.addEventListener("click", function () { ir(r.pagina - 1); });
		proxima.addEventListener("click", function () { ir(r.pagina + 1); });
		box.appendChild(el("span", { text: "Página " + r.pagina + " de " + total }));
		box.appendChild(el("div", { class: "row" }, [anterior, proxima]));
	}
	// Linha de tabela que abre o detalhe com o clique ou com Enter.
	function linha(celulas, abrir) {
		var tr = el("tr", { tabindex: "0" }, celulas);
		tr.addEventListener("click", function () { abrir(tr); });
		tr.addEventListener("keydown", function (ev) { if (ev.key === "Enter") abrir(tr); });
		return tr;
	}
	function celula(principal, secundario, classe) {
		var td = el("td", classe ? { class: classe } : {});
		td.appendChild(document.createTextNode(principal));
		if (secundario) td.appendChild(el("span", { class: "sub", text: secundario }));
		return td;
	}

	// ---------- Detalhe (painel lateral) ----------

	var linhaAberta = null;
	function abrirDetalhe(rotulo, titulo, tr) {
		if (linhaAberta) linhaAberta.removeAttribute("aria-selected");
		linhaAberta = tr || null;
		if (linhaAberta) linhaAberta.setAttribute("aria-selected", "true");
		$("drawer-kicker").textContent = rotulo;
		$("drawer-title").textContent = titulo;
		clear($("drawer-body"));
		$("drawer-body").appendChild(el("p", { class: "muted", text: "Carregando…" }));
		$("drawer").hidden = false;
		$("backdrop").hidden = false;
		$("backdrop").classList.add("over");
		$("drawer-close").focus();
		return $("drawer-body");
	}
	function fecharDetalhe() {
		if (linhaAberta) { linhaAberta.removeAttribute("aria-selected"); linhaAberta.focus(); }
		linhaAberta = null;
		$("drawer").hidden = true;
		$("backdrop").classList.remove("over");
		$("backdrop").hidden = !$("sidebar").classList.contains("open");
	}
	function dados(pares) {
		var dl = el("dl");
		pares.forEach(function (p) {
			if (p[1] === null || p[1] === undefined || p[1] === "") return;
			dl.appendChild(el("dt", { text: p[0] }));
			dl.appendChild(el("dd", p[2] ? { class: p[2], text: String(p[1]) } : { text: String(p[1]) }));
		});
		return dl;
	}
	function aviso(corpo, id) {
		var p = el("p", { id: id, role: "status" });
		corpo.appendChild(p);
		return p;
	}

	// ---------- Visão geral ----------

	var MODELOS = { nfse: "NFS-e", nfe: "NF-e", nfce: "NFC-e" };

	function indicador(rotulo, valor, detalhe, destaque) {
		return el("div", { class: "metric" + (destaque ? " featured" : "") }, [
			el("span", { text: rotulo }), el("strong", { text: valor }), el("small", { text: detalhe })
		]);
	}

	function grafico(r) {
		var box = $("vg-chart");
		clear(box);
		var antigo = box.parentNode.querySelector(".chart-axis");
		if (antigo) antigo.remove();
		var porDia = {};
		r.emitidas.porDia.forEach(function (d) { porDia[d.dia] = d; });
		var inicio = new Date(r.periodo.de + "T12:00:00");
		var fim = new Date(r.periodo.ate + "T12:00:00");
		var dias = Math.round((fim - inicio) / 86400000) + 1;
		// Períodos longos são somados por mês.
		var porMes = dias > 92;
		var pontos = [];
		var cursor = new Date(inicio);
		while (cursor <= fim) {
			var chave = isoDia(cursor);
			var d = porDia[chave] || { quantidade: 0, valor: 0 };
			var rotulo = porMes ? cursor.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }) : dois(cursor.getDate()) + "/" + dois(cursor.getMonth() + 1);
			var ultimo = pontos[pontos.length - 1];
			if (porMes && ultimo && ultimo.rotulo === rotulo) { ultimo.quantidade += d.quantidade; ultimo.valor += d.valor; }
			else pontos.push({ rotulo: rotulo, quantidade: d.quantidade, valor: d.valor });
			cursor.setDate(cursor.getDate() + 1);
		}
		var maior = pontos.reduce(function (m, p) { return Math.max(m, p.valor); }, 0);
		var vazio = r.emitidas.autorizadas.quantidade === 0;
		$("vg-chart-empty").hidden = !vazio;
		box.hidden = vazio;
		$("vg-chart-total").textContent = vazio ? "" : plural(r.emitidas.autorizadas.quantidade, "nota", "notas") + " · " + dinheiro(r.emitidas.autorizadas.valor);
		if (vazio) return;
		pontos.forEach(function (p) {
			var barra = el("span");
			// A altura entra pela propriedade (a CSP do cofre não aceita atributo style).
			barra.style.height = (maior > 0 ? Math.max((p.valor / maior) * 100, p.valor > 0 ? 2 : 0) : 0) + "%";
			box.appendChild(el("div", { class: "bar" + (p.valor > 0 ? "" : " zero"), title: p.rotulo + ": " + dinheiro(p.valor) + " em " + plural(p.quantidade, "nota", "notas") }, [barra]));
		});
		box.parentNode.insertBefore(el("div", { class: "chart-axis" }, [
			el("span", { text: pontos[0].rotulo }), el("span", { text: pontos[pontos.length - 1].rotulo })
		]), box.nextSibling);
	}

	function atencao(r) {
		var lista = $("vg-atencao");
		clear(lista);
		var item = function (tom, titulo, texto, destino, rotulo) {
			var li = el("li", { "data-tone": tom }, [el("strong", { text: titulo })]);
			if (texto) li.appendChild(document.createTextNode(texto + " "));
			if (destino) li.appendChild(el("a", { href: destino, text: rotulo }));
			lista.appendChild(li);
		};
		var cert = r.certificado;
		if (!cert) item("danger", "Sem certificado digital", "O cofre não emite nem consulta nada sem ele.", "#configuracao", "Instalar");
		else {
			var faltam = Math.floor((new Date(cert.notAfter) - Date.now()) / 86400000);
			if (faltam < 0) item("danger", "Certificado vencido", "Venceu em " + dia(cert.notAfter) + ".", "#configuracao", "Trocar");
			else if (faltam < 30) item("warning", "Certificado vence em " + plural(faltam, "dia", "dias"), "Instale o novo antes de " + dia(cert.notAfter) + ".", "#configuracao", "Trocar");
		}
		if (!r.producaoLiberada) item("info", "Produção bloqueada", "O cofre só emite documentos de homologação.", "#configuracao", "Liberar");
		if (r.contingenciaPendente > 0) item("warning", plural(r.contingenciaPendente, "NFC-e em contingência", "NFC-e em contingência"), "Aguardando a transmissão à SEFAZ; o cofre tenta sozinho a cada 5 minutos.");
		if (r.emitidas.pendentes.quantidade > 0) item("warning", plural(r.emitidas.pendentes.quantidade, "nota sem resposta conclusiva", "notas sem resposta conclusiva"), "No período escolhido.", "#emitidas", "Ver notas");
		r.distribuicoes.forEach(function (d) {
			var onde = d.ambiente === "producao" ? "produção" : "homologação";
			if (d.bloqueada) item("warning", "Consulta de notas recebidas bloqueada", "O Ambiente Nacional só aceita nova consulta em " + onde + " a partir de " + date(d.proximaConsulta) + ".", "#recebidas", "Ver");
			if (d.documentosARecuperar > 0) item("info", plural(d.documentosARecuperar, "documento a recuperar", "documentos a recuperar"), "Outro sistema consultou este CNPJ na frente; o cofre busca um a um o que ficou para trás.", "#recebidas", "Ver");
		});
		if (r.recebidas.semXml > 0) item("info", plural(r.recebidas.semXml, "nota recebida só com o resumo", "notas recebidas só com o resumo"), "O XML completo chega depois da manifestação.", "#recebidas", "Ver notas");
		if (atualizacao && atualizacao.haAtualizacao) item("info", "Versão " + atualizacao.publicada + " disponível", "Este cofre está na " + atualizacao.instalada + ".", "#atualizacao", "Atualizar");
		if (atualizacao && !atualizacao.gatilhoConfigurado) item("warning", "Falta um passo da instalação", "Configure a atualização por um clique.", "#atualizacao", "Configurar");
		if (r.resumosPendentes > 0) item("neutral", "Organizando o histórico", plural(r.resumosPendentes, "nota antiga ainda aparece", "notas antigas ainda aparecem") + " sem o destinatário na listagem.");
		$("vg-atencao-vazio").hidden = lista.children.length > 0;
	}

	async function renderVisao() {
		erro("vg-erro", "");
		var p = periodo("vg");
		var r;
		try {
			r = await api("GET", "/admin/painel/resumo" + consulta({ ambiente: $("vg-ambiente").value, de: p.de, ate: p.ate }));
		} catch (err) {
			return erro("vg-erro", err.message);
		}
		var e = r.emitidas;
		var kpis = $("vg-kpis");
		clear(kpis);
		kpis.appendChild(indicador("Autorizadas no período", dinheiro(e.autorizadas.valor), plural(e.autorizadas.quantidade, "nota", "notas"), true));
		kpis.appendChild(indicador("Canceladas", String(e.canceladas.quantidade), dinheiro(e.canceladas.valor)));
		kpis.appendChild(indicador("Não autorizadas", String(e.naoAutorizadas.quantidade), "Rejeitadas, denegadas ou não enviadas"));
		kpis.appendChild(indicador("Recebidas no período", String(r.recebidas.quantidade), dinheiro(r.recebidas.valor)));
		grafico(r);

		var corpo = $("vg-modelos");
		clear(corpo);
		Object.keys(MODELOS).forEach(function (modelo) {
			var soma = function (situacoes) {
				return e.porModelo.filter(function (t) { return t.modelo === modelo && situacoes.indexOf(t.situacao) >= 0; })
					.reduce(function (s, t) { return { quantidade: s.quantidade + t.quantidade, valor: s.valor + t.valor }; }, { quantidade: 0, valor: 0 });
			};
			var autorizadas = soma(["autorizada"]);
			corpo.appendChild(el("tr", {}, [
				el("td", { text: MODELOS[modelo] }),
				el("td", { class: "num", text: String(autorizadas.quantidade) }),
				el("td", { class: "num", text: dinheiro(autorizadas.valor) }),
				el("td", { class: "num", text: String(soma(["cancelada"]).quantidade) }),
				el("td", { class: "num", text: String(soma(["rejeitada", "denegada", "erro"]).quantidade) })
			]));
		});
		$("vg-periodo-texto").textContent = dia(r.periodo.de + "T12:00:00") + " a " + dia(r.periodo.ate + "T12:00:00") + " · " + (r.ambiente === "producao" ? "produção" : "homologação");
		atencao(r);
	}

	// ---------- Notas emitidas ----------

	var SITUACOES = {
		autorizada: ["Autorizada", "success"], cancelada: ["Cancelada", "danger"], rejeitada: ["Rejeitada", "danger"],
		denegada: ["Denegada", "danger"], contingencia: ["Em contingência", "warning"], indefinida: ["Sem resposta", "warning"],
		processando: ["Em andamento", "info"], erro: ["Não enviada", "neutral"]
	};
	var ARQUIVOS = {
		nfse: "XML da NFS-e", nfe: "XML da NF-e", nfce: "XML da NFC-e", dps: "XML da DPS",
		carta_correcao: "Carta de correção", cancelamento: "Evento de cancelamento"
	};
	var emPagina = 1;

	function tituloDaEmitida(n) {
		return (MODELOS[n.modelo] || "Nota") + (n.numero ? " nº " + n.numero : (n.numeroDps ? " (DPS " + n.numeroDps + ")" : ""));
	}

	async function renderEmitidas() {
		erro("em-erro", "");
		var p = periodo("em");
		var r;
		try {
			r = await api("GET", "/admin/painel/emitidas" + consulta({
				de: p.de, ate: p.ate, modelo: $("em-modelo").value, situacao: $("em-situacao").value,
				ambiente: $("em-ambiente").value, busca: $("em-busca").value.trim(), pagina: emPagina
			}));
		} catch (err) {
			return erro("em-erro", err.message);
		}
		var corpo = $("em-linhas");
		clear(corpo);
		$("em-vazio").hidden = r.itens.length > 0;
		$("em-resumo").textContent = plural(r.total, "nota", "notas") + " · " + dinheiro(r.valor) +
			(r.resumosPendentes > 0 ? " · organizando o histórico: " + plural(r.resumosPendentes, "nota antiga", "notas antigas") + " ainda sem destinatário" : "");
		r.itens.forEach(function (n) {
			var s = SITUACOES[n.situacao] || [n.situacao, "neutral"];
			var quem = n.destinatario ? (n.destinatario.nome || documento(n.destinatario.documento)) : "Não identificado";
			corpo.appendChild(linha([
				celula(dia(n.emitidaEm), hora(n.emitidaEm), "nowrap"),
				celula(tituloDaEmitida(n), "série " + n.serie + " · " + (n.ambiente === "producao" ? "produção" : "homologação")),
				celula(quem, n.destinatario && n.destinatario.nome ? documento(n.destinatario.documento) : ""),
				el("td", { class: "num", text: dinheiro(n.valor) }),
				el("td", {}, [selo(s[0], s[1])])
			], function (tr) { abrirEmitida(n, tr); }));
		});
		paginas("em-paginas", r, function (numero) { emPagina = numero; renderEmitidas(); });
	}

	function formCancelar(nota, corpo, recarregar) {
		var motivo = el("select", {}, [
			el("option", { value: "erro_emissao", text: "Erro na emissão" }),
			el("option", { value: "servico_nao_prestado", text: "Serviço não prestado" }),
			el("option", { value: "outros", text: "Outros" })
		]);
		var justificativa = el("textarea", { rows: "2", maxlength: "255", placeholder: "Explique o motivo (mínimo de 15 caracteres)" });
		var confirmar = el("button", { type: "button", class: "danger", text: "Confirmar cancelamento" });
		var desistir = el("button", { type: "button", class: "secondary", text: "Voltar" });
		// Só a NFS-e pede o motivo; NF-e e NFC-e pedem apenas a justificativa.
		var comMotivo = nota.modelo === "nfse";
		var form = el("div", { class: "inline-form" }, (comMotivo ? [el("div", { class: "field" }, [el("label", { text: "Motivo" }), motivo])] : []).concat([
			el("div", { class: "field" }, [el("label", { text: "Justificativa" }), justificativa]),
			el("div", { class: "row" }, [confirmar, desistir])
		]));
		desistir.addEventListener("click", function () { form.remove(); });
		confirmar.addEventListener("click", async function () {
			if (justificativa.value.trim().length < 15) return message("drawer-message", "A justificativa precisa ter ao menos 15 caracteres.", "error");
			if (!confirm("Cancelar esta nota? O cancelamento é registrado no governo e não pode ser desfeito.")) return;
			message("drawer-message", "Registrando o cancelamento…");
			try {
				await busy(confirmar, function () {
					var pedido = { chaveAcesso: nota.chaveAcesso, justificativa: justificativa.value.trim() };
					if (comMotivo) pedido.motivo = motivo.value;
					return api("POST", "/admin/notas/cancelar", pedido);
				});
				await recarregar("Nota cancelada.");
			} catch (err) {
				message("drawer-message", err.message, "error");
			}
		});
		corpo.appendChild(form);
		justificativa.focus();
	}

	async function abrirEmitida(resumo, tr, feito) {
		var corpo = abrirDetalhe((MODELOS[resumo.modelo] || "Nota") + " · " + (resumo.ambiente === "producao" ? "produção" : "homologação"), tituloDaEmitida(resumo) + " · série " + resumo.serie, tr);
		var d;
		try {
			d = await api("GET", "/admin/painel/emitidas/" + encodeURIComponent(resumo.id));
		} catch (err) {
			clear(corpo);
			corpo.appendChild(el("p", { class: "alert", text: err.message }));
			return;
		}
		var n = d.nota;
		var s = SITUACOES[n.situacao] || [n.situacao, "neutral"];
		clear(corpo);
		corpo.appendChild(el("p", {}, [selo(s[0], s[1])]));
		corpo.appendChild(dados([
			["Emissão", date(n.emitidaEm)],
			["Autorização", n.autorizadaEm ? date(n.autorizadaEm) : null],
			["Valor", dinheiro(n.valor)],
			[n.modelo === "nfse" ? "Tomador" : "Destinatário", n.destinatario ? [n.destinatario.nome, documento(n.destinatario.documento)].filter(Boolean).join(" · ") : "Não identificado"],
			["Chave de acesso", n.chaveAcesso, "mono"],
			["Protocolo", n.protocolo, "mono"],
			["DPS", n.numeroDps],
			["Referência", n.referencia, "mono"],
			["Cartas de correção", n.cartasCorrecao > 0 ? n.cartasCorrecao : null]
		]));
		if (n.contingencia) {
			corpo.appendChild(el("h3", { text: "Contingência" }));
			corpo.appendChild(dados([
				["Desde", n.contingencia.desde ? date(n.contingencia.desde) : null],
				["Motivo", n.contingencia.motivo],
				["Tentativas", n.contingencia.tentativasDeTransmissao],
				["Falha na conferência", n.contingencia.falhaNaConferencia]
			]));
		}
		if (n.mensagens.length > 0) {
			corpo.appendChild(el("h3", { text: n.situacao === "autorizada" || n.situacao === "cancelada" ? "Avisos do governo" : "Motivo" }));
			corpo.appendChild(el("ul", { class: "timeline" }, n.mensagens.map(function (m) {
				return el("li", {}, [el("strong", { text: m.codigo }), document.createTextNode(" " + m.descricao)]);
			})));
		}
		var cancelada = n.situacao === "cancelada";
		if (d.arquivos.length > 0) {
			corpo.appendChild(el("h3", { text: "Arquivos" }));
			var acts = el("div", { class: "row" });
			d.arquivos.forEach(function (a) {
				var botao = el("button", { type: "button", class: "secondary small-button", text: ARQUIVOS[a.tipo] || a.nome });
				botao.addEventListener("click", function () {
					busy(botao, function () { return baixarDe("/admin/notas/arquivo?key=" + encodeURIComponent(a.key), a.nome); })
						.catch(function (err) { message("drawer-message", err.message, "error"); });
				});
				acts.appendChild(botao);
				if (a.tipo === "nfe" || a.tipo === "nfce") {
					var pdf = el("button", { type: "button", class: "secondary small-button", text: a.tipo === "nfe" ? "DANFE (PDF)" : "DANFE NFC-e (PDF)" });
					pdf.addEventListener("click", function () {
						busy(pdf, function () { return baixarDe("/admin/notas/pdf?key=" + encodeURIComponent(a.key) + (cancelada ? "&cancelada=1" : ""), a.nome.replace(/\.xml$/, ".pdf")); })
							.catch(function (err) { message("drawer-message", err.message, "error"); });
					});
					acts.appendChild(pdf);
				}
			});
			corpo.appendChild(acts);
		}
		aviso(corpo, "drawer-message");
		if (feito) message("drawer-message", feito, "ok");
		if (n.situacao === "autorizada" && n.chaveAcesso) {
			corpo.appendChild(el("h3", { text: "Cancelamento" }));
			var cancelar = el("button", { type: "button", class: "danger small-button", text: "Cancelar nota" });
			cancelar.addEventListener("click", function () {
				if (!corpo.querySelector(".inline-form")) formCancelar(n, corpo, async function (texto) {
					await renderEmitidas();
					await abrirEmitida(resumo, null, texto);
				});
			});
			corpo.appendChild(cancelar);
		}
	}

	// ---------- Notas recebidas (distribuição de DF-e e manifestação do destinatário) ----------

	var UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"];
	var MANIFESTACOES = {
		ciencia: "Ciência da operação", confirmacao: "Confirmação da operação",
		desconhecimento: "Desconhecimento da operação", nao_realizada: "Operação não realizada"
	};
	var rcPagina = 1;
	UFS.forEach(function (uf) { $("dfe-uf").appendChild(el("option", { value: uf, text: uf })); });

	// Mostra no formulário a configuração do ambiente escolhido.
	function preencherDistribuicao() {
		var atual = distribuicoes.filter(function (d) { return d.ambiente === $("dfe-ambiente").value; })[0];
		if (atual) $("dfe-uf").value = atual.uf;
		$("dfe-auto").checked = !!(atual && atual.consultaAutomatica);
		$("dfe-ciencia").checked = !!(atual && atual.cienciaAutomatica);
		$("dfe-ciencia").disabled = !$("dfe-auto").checked;
		$("dfe-sync").hidden = !atual;
	}

	async function sincronizar(ambiente, botao, destino) {
		message(destino, "Consultando o Ambiente Nacional… a primeira conexão pode levar alguns segundos.");
		try {
			var r = await busy(botao, function () { return api("POST", "/admin/distribuicao/sincronizar", { ambiente: ambiente }); });
			var d = r.distribuicao;
			var texto = !r.consultou
				? "Nada foi consultado: " + (d.proximaConsulta ? "o Ambiente Nacional só aceita nova consulta a partir de " + date(d.proximaConsulta) + "." : "já há uma consulta em andamento.")
				: (r.documentos > 0
					? plural(r.documentos, "documento recebido", "documentos recebidos") + ", " + plural(r.notasNovas, "nota nova", "notas novas") + "."
					: "Nenhum documento novo" + (d.mensagem ? " (" + d.mensagem.codigo + ": " + d.mensagem.descricao + ")" : "") + ".");
			if (d.documentosARecuperar > 0) texto += " Faltam " + plural(d.documentosARecuperar, "documento", "documentos") + " a recuperar; o cofre continua sozinho.";
			await renderDistribuicao();
			message(destino, texto, r.consultou && !d.bloqueada ? "ok" : "warn");
			if ($("rc-linhas").isConnected && !document.querySelector('[data-view="recebidas"]').hidden) await renderRecebidas();
		} catch (err) {
			message(destino, err.message, "error");
		}
	}

	async function renderDistribuicao() {
		var data = await api("GET", "/admin/distribuicao");
		distribuicoes = data.distribuicoes;
		var estado = $("dfe-status");
		clear(estado);
		$("dfe-vazio").hidden = distribuicoes.length > 0;
		distribuicoes.forEach(function (d) {
			var partes = [d.consultaAutomatica ? "consulta automática ligada" + (d.cienciaAutomatica ? ", com ciência automática" : "") : "consulta só quando pedida"];
			if (d.ultimaConsulta) partes.push("última consulta em " + date(d.ultimaConsulta) + (d.mensagem ? " (" + d.mensagem.codigo + ": " + d.mensagem.descricao + ")" : ""));
			if (d.proximaConsulta) partes.push((d.bloqueada ? "bloqueada pelo Ambiente Nacional até " : "próxima consulta a partir de ") + date(d.proximaConsulta));
			if (d.documentosARecuperar > 0) partes.push(plural(d.documentosARecuperar, "documento", "documentos") + " a recuperar: outro sistema consultou este CNPJ na frente, e o cofre busca um a um o que ficou para trás");
			var consultar = el("button", { type: "button", class: "secondary small-button", text: "Consultar agora" });
			consultar.addEventListener("click", function () { sincronizar(d.ambiente, consultar, "dfe-message"); });
			estado.appendChild(el("li", {}, [
				el("span", {}, [
					el("strong", { text: (d.ambiente === "producao" ? "Produção" : "Homologação") + " · CNPJ " + documento(d.cnpj) + " · " + d.uf }),
					el("span", { class: "detail", text: partes.join(" · ") })
				]),
				el("span", { class: "acts" }, [
					selo(d.bloqueada ? "Bloqueada" : (d.consultaAutomatica ? "Automática" : "Manual"), d.bloqueada ? "danger" : (d.consultaAutomatica ? "success" : "neutral")),
					consultar
				])
			]));
		});
		preencherDistribuicao();
	}

	function situacaoDaRecebida(n) {
		if (n.situacao === "cancelada") return ["Cancelada", "danger"];
		if (n.situacao === "denegada") return ["Denegada", "danger"];
		return n.xmlDisponivel ? ["XML completo", "success"] : ["Só o resumo", "warning"];
	}

	async function renderRecebidas() {
		erro("rc-erro", "");
		try {
			await renderDistribuicao();
			var p = periodo("rc");
			var r = await api("GET", "/admin/painel/recebidas" + consulta({
				de: p.de, ate: p.ate, situacao: $("rc-situacao").value, xml: $("rc-xml").value,
				ambiente: $("rc-ambiente").value, busca: $("rc-busca").value.trim(), pagina: rcPagina
			}));
		} catch (err) {
			return erro("rc-erro", err.message);
		}
		var corpo = $("rc-linhas");
		clear(corpo);
		$("rc-vazio").hidden = r.itens.length > 0;
		$("rc-resumo").textContent = plural(r.total, "nota", "notas") + " · " + dinheiro(r.valor) + (r.semXml > 0 ? " · " + r.semXml + " só com o resumo" : "");
		r.itens.forEach(function (n) {
			var s = situacaoDaRecebida(n);
			corpo.appendChild(linha([
				celula(dia(n.emitidaEm), hora(n.emitidaEm), "nowrap"),
				celula("NF-e nº " + n.numero, "série " + n.serie + " · " + (n.ambiente === "producao" ? "produção" : "homologação")),
				celula(n.emitente.nome || "Emitente", documento(n.emitente.documento)),
				el("td", { class: "num", text: dinheiro(n.valor) }),
				el("td", {}, [selo(s[0], s[1])]),
				celula(n.manifestacao ? MANIFESTACOES[n.manifestacao.tipo] : (n.papel === "terceiro" ? "Não se aplica" : "Sem manifestação"), n.manifestacao ? dia(n.manifestacao.registradaEm) : "")
			], function (tr) { abrirRecebida(n, tr); }));
		});
		paginas("rc-paginas", r, function (numero) { rcPagina = numero; renderRecebidas(); });
	}

	function formManifestar(nota, corpo, recarregar) {
		var tipo = el("select", {}, Object.keys(MANIFESTACOES).map(function (t) { return el("option", { value: t, text: MANIFESTACOES[t] }); }));
		var justificativa = el("textarea", { rows: "2", maxlength: "255", placeholder: "Por que a operação não se realizou (mínimo de 15 caracteres)" });
		var campoJustificativa = el("div", { class: "field" }, [el("label", { text: "Justificativa" }), justificativa]);
		var confirmar = el("button", { type: "button", class: "primary", text: "Registrar manifestação" });
		var desistir = el("button", { type: "button", class: "secondary", text: "Voltar" });
		var form = el("div", { class: "inline-form" }, [
			el("div", { class: "field" }, [el("label", { text: "Manifestação" }), tipo]), campoJustificativa, el("div", { class: "row" }, [confirmar, desistir])
		]);
		function ajustar() { campoJustificativa.hidden = tipo.value !== "nao_realizada"; }
		tipo.addEventListener("change", ajustar);
		ajustar();
		desistir.addEventListener("click", function () { form.remove(); });
		confirmar.addEventListener("click", async function () {
			var pedido = { id: nota.id, tipo: tipo.value };
			if (tipo.value === "nao_realizada") {
				if (justificativa.value.trim().length < 15) return message("drawer-message", "A justificativa precisa ter ao menos 15 caracteres.", "error");
				pedido.justificativa = justificativa.value.trim();
			}
			var pergunta = "Registrar \"" + MANIFESTACOES[tipo.value] + "\" para esta nota?" +
				(nota.ambiente === "producao" ? " É um evento fiscal em nome da empresa, registrado no Ambiente Nacional." : "");
			if (!confirm(pergunta)) return;
			message("drawer-message", "Registrando a manifestação…");
			try {
				var r = await busy(confirmar, function () { return api("POST", "/admin/recebidas/manifestar", pedido); });
				await recarregar(r.repetido ? "Esta manifestação já estava registrada." : "Manifestação registrada.");
			} catch (err) {
				message("drawer-message", err.message, "error");
			}
		});
		corpo.appendChild(form);
	}

	async function abrirRecebida(resumo, tr, feito) {
		var corpo = abrirDetalhe("NF-e recebida · " + (resumo.ambiente === "producao" ? "produção" : "homologação"), "NF-e nº " + resumo.numero + " · série " + resumo.serie, tr);
		var d;
		try {
			d = await api("GET", "/admin/painel/recebidas/" + encodeURIComponent(resumo.id));
		} catch (err) {
			clear(corpo);
			corpo.appendChild(el("p", { class: "alert", text: err.message }));
			return;
		}
		var n = d.nota;
		var s = situacaoDaRecebida(n);
		clear(corpo);
		corpo.appendChild(el("p", {}, [selo(s[0], s[1])]));
		corpo.appendChild(dados([
			["Emitente", [n.emitente.nome, documento(n.emitente.documento)].filter(Boolean).join(" · ")],
			["Inscrição estadual", n.emitente.ie],
			["Emissão", n.emitidaEm ? date(n.emitidaEm) : null],
			["Autorização", n.autorizadaEm ? date(n.autorizadaEm) : null],
			["Valor", dinheiro(n.valor)],
			["Operação", n.tipoOperacao === "entrada" ? "Entrada" : (n.tipoOperacao === "saida" ? "Saída" : null)],
			["Papel da empresa", n.papel === "terceiro" ? "Transportadora ou autorizada a baixar o XML" : "Destinatária"],
			["Chave de acesso", n.chaveAcesso, "mono"],
			["Protocolo", n.protocolo, "mono"],
			["Chegou ao cofre", date(n.recebidaEm)]
		]));
		if (n.cienciaAutomaticaRecusada) corpo.appendChild(el("p", { class: "notice warning", text: "Ciência automática recusada: " + n.cienciaAutomaticaRecusada.descricao }));

		corpo.appendChild(el("h3", { text: "Arquivos" }));
		var acts = el("div", { class: "row" });
		var arquivo = el("button", { type: "button", class: "secondary small-button", text: n.xmlDisponivel ? "XML da NF-e" : "Resumo (XML)" });
		arquivo.addEventListener("click", function () {
			busy(arquivo, function () { return baixarDe("/admin/recebidas/arquivo?id=" + encodeURIComponent(n.id), n.chaveAcesso + (n.xmlDisponivel ? "-nfe.xml" : "-resumo.xml")); })
				.catch(function (err) { message("drawer-message", err.message, "error"); });
		});
		if (n.xmlDisponivel || n.situacao) acts.appendChild(arquivo);
		if (n.xmlDisponivel) {
			var pdf = el("button", { type: "button", class: "secondary small-button", text: "DANFE (PDF)" });
			pdf.addEventListener("click", function () {
				busy(pdf, function () { return baixarDe("/admin/recebidas/arquivo?id=" + encodeURIComponent(n.id) + "&tipo=danfe", n.chaveAcesso + "-danfe.pdf"); })
					.catch(function (err) { message("drawer-message", err.message, "error"); });
			});
			acts.appendChild(pdf);
		}
		corpo.appendChild(acts);
		if (!n.xmlDisponivel && n.papel === "destinatario") corpo.appendChild(el("p", { class: "hint", text: "O XML completo é liberado depois da ciência, da confirmação ou da operação não realizada." }));

		if (n.manifestacoes.length > 0) {
			corpo.appendChild(el("h3", { text: "Manifestações" }));
			corpo.appendChild(el("ul", { class: "timeline" }, n.manifestacoes.map(function (m) {
				return el("li", {}, [
					el("strong", { text: MANIFESTACOES[m.tipo] || m.tipo }),
					el("span", { class: "sub", text: date(m.registradaEm) + (m.protocolo ? " · protocolo " + m.protocolo : " · já estava registrada fora do cofre") + (m.justificativa ? " · " + m.justificativa : "") })
				]);
			})));
		}
		if (d.eventos.length > 0) {
			corpo.appendChild(el("h3", { text: "Eventos da nota" }));
			corpo.appendChild(el("ul", { class: "timeline" }, d.eventos.map(function (e) {
				return el("li", {}, [
					el("strong", { text: e.descricao || ("Evento " + e.codigo) }),
					el("span", { class: "sub", text: (e.registradoEm ? date(e.registradoEm) : "") + (e.protocolo ? " · protocolo " + e.protocolo : "") })
				]);
			})));
		}
		aviso(corpo, "drawer-message");
		if (feito) message("drawer-message", feito, "ok");
		if (n.papel === "destinatario") {
			corpo.appendChild(el("h3", { text: "Manifestação do destinatário" }));
			var manifestar = el("button", { type: "button", class: "secondary small-button", text: "Manifestar" });
			manifestar.addEventListener("click", function () {
				if (!corpo.querySelector(".inline-form")) formManifestar(n, corpo, async function (texto) {
					await renderRecebidas();
					await abrirRecebida(resumo, null, texto);
				});
			});
			corpo.appendChild(manifestar);
		}
	}

	// ---------- Relatórios e exportação ----------

	var TOTAIS = [
		["produtos", "Produtos"], ["servicos", "Serviços"], ["desconto", "Descontos"], ["frete", "Frete"],
		["icms", "ICMS"], ["icmsSt", "ICMS ST"], ["fcp", "FCP"], ["ipi", "IPI"], ["pis", "PIS"], ["cofins", "COFINS"],
		["ii", "Imposto de importação"], ["iss", "ISS"], ["ibs", "IBS"], ["cbs", "CBS"], ["is", "Imposto Seletivo"]
	];
	var relendo = null;

	// Preenche uma tabela; sem linhas, mostra uma só dizendo que não há nada.
	function tabela(id, linhas, colunas) {
		var corpo = $(id);
		clear(corpo);
		if (linhas.length === 0) corpo.appendChild(el("tr", {}, [el("td", { class: "vazio", colspan: String(colunas), text: "Nada no período." })]));
		linhas.forEach(function (celulas) {
			corpo.appendChild(el("tr", {}, celulas.map(function (c) {
				return Array.isArray(c) ? el("td", { class: "num", text: c[0] }) : el("td", { text: c });
			})));
		});
	}

	// Período do relatório; null (com o aviso na tela) quando as datas escolhidas estão incompletas.
	function periodoDoRelatorio() {
		var p = periodo("rl");
		if (!p.de || !p.ate) {
			erro("rl-erro", "Escolha a data inicial e a data final.");
			return null;
		}
		return { ambiente: $("rl-ambiente").value, de: p.de, ate: p.ate };
	}

	async function renderRelatorio() {
		erro("rl-erro", "");
		if (relendo) clearTimeout(relendo);
		var p = periodoDoRelatorio();
		if (!p) return;
		var r;
		try {
			r = await api("GET", "/admin/painel/relatorio" + consulta(p));
		} catch (err) {
			return erro("rl-erro", err.message);
		}
		var e = r.emitidas;
		var rc = r.recebidas;
		$("rl-periodo-texto").textContent = dia(r.periodo.de + "T12:00:00") + " a " + dia(r.periodo.ate + "T12:00:00") + " · " + (r.ambiente === "producao" ? "produção" : "homologação");
		// Enquanto houver XML por ler, os totais de impostos estão incompletos: o cofre continua e a tela se atualiza.
		$("rl-lendo").hidden = r.notasPorLer === 0;
		$("rl-lendo").textContent = "Lendo os XML do período para somar os impostos: " + plural(r.notasPorLer, "nota ainda por ler", "notas ainda por ler") + ". Os totais abaixo se completam sozinhos.";
		if (r.notasPorLer > 0) relendo = setTimeout(function () { if (telaAtual() === "relatorios") renderRelatorio(); }, 1500);

		var kpis = $("rl-kpis");
		clear(kpis);
		var im = e.autorizadas.impostos;
		kpis.appendChild(indicador("Valor autorizado", dinheiro(e.autorizadas.valor), plural(e.autorizadas.quantidade, "nota emitida", "notas emitidas"), true));
		kpis.appendChild(indicador("ICMS e ICMS ST", dinheiro(im.icms + im.icmsSt), "Notas emitidas autorizadas"));
		kpis.appendChild(indicador("IBS, CBS e Imposto Seletivo", dinheiro(im.ibs + im.cbs + im.is), "Notas emitidas autorizadas"));
		kpis.appendChild(indicador("Recebidas", dinheiro(rc.autorizadas.valor), plural(rc.autorizadas.quantidade, "nota", "notas") + ", " + rc.autorizadas.comXml + " com o XML completo"));

		tabela("rl-impostos", [["Valor total das notas", [dinheiro(e.autorizadas.valor)], [dinheiro(rc.autorizadas.valor)]]].concat(TOTAIS.map(function (t) {
			return [t[1], [dinheiro(im[t[0]])], [dinheiro(rc.autorizadas.impostos[t[0]])]];
		})), 3);
		tabela("rl-situacoes", e.porSituacao.map(function (s) {
			return [MODELOS[s.modelo] || s.modelo, (SITUACOES[s.situacao] || [s.situacao])[0], [String(s.quantidade)], [dinheiro(s.valor)]];
		}), 4);
		tabela("rl-cfops", e.porCfop.map(function (c) { return [c.cfop, [String(c.quantidade)], [dinheiro(c.valor)]]; }), 3);
		tabela("rl-naturezas", e.porNatureza.map(function (n) { return [n.natureza, [String(n.quantidade)], [dinheiro(n.valor)]]; }), 3);
		var pessoa = function (x) { return [(x.nome || "Não identificado") + (x.documento ? " · " + documento(x.documento) : ""), [String(x.quantidade)], [dinheiro(x.valor)]]; };
		tabela("rl-destinatarios", e.porDestinatario.map(pessoa), 3);
		tabela("rl-emitentes", rc.porEmitente.map(pessoa), 3);
	}

	var exportando = null;
	function mostrarExportacao(x) {
		$("ex-resultado").hidden = x.situacao !== "pronta";
		if (x.situacao !== "pronta") {
			message("ex-message", "Preparando: lendo os XML para a planilha (" + plural(x.notasPorLer, "nota por ler", "notas por ler") + ")…");
			exportando = setTimeout(async function () {
				try {
					mostrarExportacao(await api("GET", "/admin/painel/exportacoes/" + encodeURIComponent(x.id)));
				} catch (err) {
					message("ex-message", err.message, "error");
				}
			}, 1500);
			return;
		}
		message("ex-message", "");
		var c = x.conteudo;
		var partes = [];
		var emitidas = (c.nfse || 0) + (c.nfe || 0) + (c.nfce || 0);
		if (emitidas) partes.push(plural(emitidas, "nota emitida", "notas emitidas"));
		if (c.eventos) partes.push(plural(c.eventos, "evento", "eventos"));
		if (c.inutilizacoes) partes.push(plural(c.inutilizacoes, "inutilização", "inutilizações"));
		if (c.recebidas) partes.push(plural(c.recebidas, "nota recebida", "notas recebidas"));
		if (c.manifestacoes) partes.push(plural(c.manifestacoes, "manifestação", "manifestações"));
		if (c.eventosRecebidos) partes.push(plural(c.eventosRecebidos, "evento de nota recebida", "eventos de notas recebidas"));
		$("ex-resumo").textContent = x.arquivos === 0
			? "Não há XML neste período com o que foi marcado. A planilha sai só com o cabeçalho."
			: plural(x.arquivos, "arquivo", "arquivos") + ": " + partes.join(", ") + ".";
		var links = $("ex-links");
		clear(links);
		x.partes.forEach(function (p) {
			links.appendChild(el("a", { class: "primary", href: p.url, download: p.nome, text: x.partes.length > 1 ? "Baixar ZIP, parte " + p.parte + " de " + x.partes.length : "Baixar ZIP" }));
		});
		links.appendChild(el("a", { class: "secondary", href: x.planilha.url, download: x.planilha.nome, text: "Baixar só a planilha" }));
		$("ex-validade").textContent = "Os links valem até " + hora(x.linksValemAte) + ". Depois disso, gere de novo." +
			(x.partes.length > 1 ? " O ZIP sai em partes de até 400 arquivos; a planilha vai dentro da primeira." : "");
	}

	// ---------- Configuração ----------

	function renderCertificate() {
		var box = $("cert-status");
		clear(box);
		var cert = state.certificate;
		$("cert-remove").hidden = !cert;
		if (!cert) {
			box.appendChild(el("p", { text: "Nenhum certificado instalado.", class: "tone-warn" }));
			return;
		}
		var days = Math.floor((new Date(cert.notAfter) - Date.now()) / 86400000);
		var validity = date(cert.notAfter) + (days < 0 ? " — VENCIDO" : " — faltam " + days + " dias");
		box.appendChild(dados([
			["Titular", cert.commonName],
			[cert.holder.kind.toUpperCase(), documento(cert.holder.id)],
			["Emissor", cert.issuer],
			["Validade", validity, days < 30 ? "tone-warn" : ""],
			["Instalado em", date(cert.installedAt)]
		]));
	}

	function renderEnvironment() {
		var on = state.allowProduction;
		$("env-status").textContent = on
			? "Produção liberada: este cofre emite documentos com valor fiscal."
			: "Produção bloqueada: este cofre só emite documentos de homologação.";
		$("env-status").className = on ? "tone-ok" : "tone-warn";
		$("env-toggle").textContent = on ? "Bloquear produção" : "Liberar produção";
	}

	// Cabeçalho: ambiente e validade do certificado, sempre à vista.
	function renderTopo() {
		var cert = state.certificate;
		$("brand-holder").textContent = cert ? cert.commonName : "Sem certificado";
		$("version").textContent = "v" + state.version;
		$("top-env").textContent = state.allowProduction ? "Produção liberada" : "Somente homologação";
		$("top-env").setAttribute("data-tone", state.allowProduction ? "info" : "neutral");
		var faltam = cert ? Math.floor((new Date(cert.notAfter) - Date.now()) / 86400000) : null;
		$("top-cert").textContent = !cert ? "Sem certificado" : (faltam < 0 ? "Certificado vencido" : (faltam < 30 ? "Certificado vence em " + plural(faltam, "dia", "dias") : "Certificado válido até " + dia(cert.notAfter)));
		$("top-cert").setAttribute("data-tone", !cert || faltam < 0 ? "danger" : (faltam < 30 ? "warning" : "success"));
		$("nav-update").hidden = !(atualizacao && (atualizacao.haAtualizacao || !atualizacao.gatilhoConfigurado || paginaVelha()));
	}

	async function renderSeries() {
		var data = await api("GET", "/admin/series");
		var list = $("series");
		clear(list);
		$("series-empty").hidden = data.series.length > 0;
		data.series.forEach(function (s) {
			var titulo = (MODELOS[s.modelo] || s.modelo) + " · série " + s.serie + (s.descricao ? " · " + s.descricao : "");
			var detalhe = (s.ambiente === "producao" ? "produção" : "homologação") + " · próxima nota: " + s.proximoNumero;
			list.appendChild(el("li", {}, [el("span", {}, [el("strong", { text: titulo }), el("span", { class: "detail", text: detalhe })])]));
		});
	}

	var logoUrl = null;
	async function renderLogo() {
		var res = await fetch("/admin/logotipo", { headers: { authorization: "Bearer " + secret } });
		if (logoUrl) URL.revokeObjectURL(logoUrl);
		logoUrl = res.ok ? URL.createObjectURL(await res.blob()) : null;
		if (logoUrl) $("logo-preview").src = logoUrl;
		$("logo-preview").hidden = !logoUrl;
		$("logo-empty").hidden = !!logoUrl;
		$("logo-remove").hidden = !logoUrl;
	}

	async function renderConfiguracao() {
		renderCertificate();
		renderEnvironment();
		await renderSeries();
		await renderLogo();
		await renderDistribuicao();
		// O formulário abre no ambiente que já está configurado.
		var ha = function (ambiente) { return distribuicoes.some(function (d) { return d.ambiente === ambiente; }); };
		if (!ha($("dfe-ambiente").value) && distribuicoes[0]) {
			$("dfe-ambiente").value = distribuicoes[0].ambiente;
			preencherDistribuicao();
		}
	}

	// ---------- Chaves de API ----------

	async function renderKeys() {
		$("api-base").textContent = location.origin + "/v1";
		var data = await api("GET", "/admin/chaves");
		var list = $("apikeys");
		clear(list);
		if (data.chaves.length === 0) list.appendChild(el("li", { class: "muted", text: "Nenhuma chave criada ainda." }));
		data.chaves.forEach(function (k) {
			var detalhe = k.prefixo + "… · " + (k.escopo === "homologacao" ? "somente homologação" : "homologação e produção") +
				" · criada em " + date(k.criadaEm) +
				(k.revogadaEm ? " · revogada em " + date(k.revogadaEm) : (k.ultimoUso ? " · último uso " + date(k.ultimoUso) : " · nunca usada"));
			var item = el("li", {}, [el("span", {}, [el("strong", { text: k.nome }), el("span", { class: "detail", text: detalhe })])]);
			if (!k.revogadaEm) {
				item.appendChild(el("button", {
					type: "button", class: "danger small-button", text: "Revogar",
					onclick: async function (ev) {
						if (!confirm("Revogar a chave \"" + k.nome + "\"? O sistema que a usa deixa de conseguir emitir.")) return;
						await busy(ev.currentTarget, function () { return api("DELETE", "/admin/chaves/" + k.id); });
						await renderKeys();
					}
				}));
			} else item.appendChild(selo("Revogada", "neutral"));
			list.appendChild(item);
		});
	}

	// ---------- Atualização ----------

	// O que esta página carregou. Quando o cofre passa a responder por outra
	// versão (ou por outro build da mesma versão), a página aberta ficou velha.
	var paginaVersao = $("panel").getAttribute("data-versao");
	var paginaImplantacao = null;
	var vigia = null;
	var batidas = 0;
	var consultando = false;

	function paginaVelha() {
		if (!atualizacao) return false;
		return atualizacao.instalada !== paginaVersao ||
			Boolean(paginaImplantacao && atualizacao.implantacao && atualizacao.implantacao !== paginaImplantacao);
	}
	function decorrido(desde) {
		var s = Math.max(Math.floor((Date.now() - new Date(desde)) / 1000), 0);
		return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + dois(s % 60) + " s";
	}
	function passo(estado, titulo, detalhe) {
		return el("li", { "data-state": estado }, [el("strong", { text: titulo }), detalhe ? el("small", { text: detalhe }) : null]);
	}

	// Faixa no alto de qualquer tela e o passo a passo na tela de atualização.
	function pintarAndamento() {
		var a = atualizacao && atualizacao.andamento;
		var velha = paginaVelha();
		var correndo = Boolean(a && a.situacao === "em_andamento") && !velha;
		var demorando = Boolean(a && a.situacao === "demorando") && !velha;
		var alvo = a && a.para ? "a versão " + a.para : "a versão nova";

		var faixa = $("update-banner");
		// Na tela de atualização o passo a passo já diz tudo.
		faixa.hidden = telaAtual() === "atualizacao" || !(velha || correndo || demorando);
		faixa.setAttribute("data-tone", velha ? "success" : (demorando ? "warning" : "info"));
		if (velha) $("update-banner-text").textContent = "A versão " + atualizacao.instalada + " do cofre já está no ar. Recarregue a página para usar o painel novo.";
		else if (demorando) $("update-banner-text").textContent = "A atualização do cofre está demorando mais que o normal (" + decorrido(a.iniciadaEm) + ").";
		else if (correndo) $("update-banner-text").textContent = "Atualizando o cofre para " + alvo + "… " + decorrido(a.iniciadaEm) + ".";
		$("update-banner-link").hidden = velha;
		$("update-banner-reload").hidden = !velha;

		var caixa = $("update-progress");
		var concluida = velha || Boolean(a && a.situacao === "concluida");
		caixa.hidden = !(a || velha);
		if (caixa.hidden) return;
		var passos = $("update-steps");
		clear(passos);
		$("update-progress-bar").setAttribute("data-state", concluida ? "done" : (demorando ? "late" : "running"));
		$("update-reload").hidden = !velha;
		if (a) passos.appendChild(passo("done", "Pedido enviado ao Cloudflare", "Às " + hora(a.iniciadaEm) + "."));
		if (concluida) {
			$("update-progress-title").textContent = "Atualização concluída";
			if (a) passos.appendChild(passo("done", "O Cloudflare compilou e publicou a versão nova"));
			passos.appendChild(passo("done", "Versão " + atualizacao.instalada + " no ar", a && a.concluidaEm ? "Desde as " + hora(a.concluidaEm) + "." : ""));
			$("update-progress-note").textContent = velha
				? "Esta página ainda é a da versão anterior. Recarregue para usar o painel novo; o cofre vai pedir o segredo de novo."
				: "Esta página já é a da versão nova.";
		} else if (demorando) {
			$("update-progress-title").textContent = "A atualização está demorando";
			passos.appendChild(passo("late", "O build ainda não terminou", "Começou há " + decorrido(a.iniciadaEm) + ". O normal é levar de 1 a 3 minutos."));
			passos.appendChild(passo("pending", "Versão nova no ar"));
			$("update-progress-note").textContent = "Veja o registro do build no painel do Cloudflare, na página deste Worker, em Implantações. Se o build falhou, o cofre continua funcionando na versão " + a.de + ". Esta tela avisa se a versão nova entrar no ar.";
		} else {
			$("update-progress-title").textContent = "Atualizando o cofre para " + alvo;
			passos.appendChild(passo("active", "O Cloudflare está compilando e publicando", "Há " + decorrido(a.iniciadaEm) + ". Costuma levar de 1 a 3 minutos."));
			passos.appendChild(passo("pending", "Versão nova no ar"));
			$("update-progress-note").textContent = "O cofre continua funcionando enquanto isso. Pode usar as outras telas: o painel avisa quando terminar.";
		}
	}

	// Acompanha a atualização pedida: o relógio anda a cada segundo e o cofre é
	// consultado a cada 5 segundos (a cada 30 quando o build demora).
	function vigiar() {
		if (vigia) return;
		batidas = 0;
		vigia = setInterval(async function () {
			var a = atualizacao && atualizacao.andamento;
			var ativo = a && (a.situacao === "em_andamento" || a.situacao === "demorando") && !paginaVelha();
			if (!secret || !ativo) {
				clearInterval(vigia);
				vigia = null;
				return;
			}
			batidas++;
			if (!consultando && batidas % (a.situacao === "demorando" ? 30 : 5) === 0) {
				consultando = true;
				try {
					pintarUpdate(await api("GET", "/admin/atualizacao"));
				} catch (err) {
					// Na troca de versão o cofre pode falhar por um instante: tenta de novo na próxima volta.
				}
				consultando = false;
			} else pintarAndamento();
		}, 1000);
	}

	function pintarUpdate(u) {
		atualizacao = u;
		var emCurso = Boolean(u.andamento && u.andamento.situacao === "em_andamento") && !paginaVelha();
		var texto = "Versão instalada: " + u.instalada + ". ";
		if (!u.publicada) texto += "Não foi possível consultar a versão publicada agora.";
		else if (u.haAtualizacao) texto += "Há uma versão nova disponível: " + u.publicada + ".";
		else texto += "Este cofre está atualizado.";
		$("update-status").textContent = texto;
		$("update-status").className = u.haAtualizacao ? "tone-warn" : "";
		// Sem conseguir consultar a versão publicada, o botão continua disponível.
		$("update-run").hidden = emCurso || !(u.gatilhoConfigurado && (u.haAtualizacao || !u.publicada));
		$("update-run").textContent = u.haAtualizacao ? "Atualizar para " + u.publicada : "Atualizar agora";
		$("update-setup").open = !u.gatilhoConfigurado;
		$("update-setup").querySelector("summary").textContent = u.gatilhoConfigurado
			? "Trocar o gatilho de atualização"
			: "Configurar o gatilho de atualização";
		renderTopo();
		pintarAndamento();
		if (u.andamento && u.andamento.situacao !== "concluida") vigiar();
	}

	async function renderUpdate(verificar) {
		pintarUpdate(await api("GET", "/admin/atualizacao" + (verificar ? "?verificar=1" : "")));
	}

	// ---------- Atividade ----------

	async function renderAudit() {
		var data = await api("GET", "/admin/audit?limit=100");
		var body = $("audit");
		clear(body);
		data.entries.forEach(function (e) {
			body.appendChild(el("tr", {}, [
				el("td", { class: "nowrap", text: date(e.at) }),
				el("td", { text: e.action }),
				el("td", { text: e.actor }),
				el("td", {}, [selo(e.outcome === "ok" ? "Certo" : e.outcome, e.outcome === "ok" ? "success" : "danger")])
			]));
		});
	}

	// ---------- Navegação ----------

	var TELAS = {
		"visao-geral": ["Visão geral", renderVisao],
		emitidas: ["Notas emitidas", renderEmitidas],
		recebidas: ["Notas recebidas", renderRecebidas],
		relatorios: ["Relatórios e exportação", renderRelatorio],
		configuracao: ["Configuração", renderConfiguracao],
		chaves: ["Chaves de API", renderKeys],
		atualizacao: ["Atualização", function () { return renderUpdate(false); }],
		atividade: ["Atividade", renderAudit]
	};

	function fecharMenu() {
		$("sidebar").classList.remove("open");
		$("backdrop").hidden = $("drawer").hidden;
	}

	function telaAtual() {
		var nome = location.hash.slice(1);
		return TELAS[nome] ? nome : "visao-geral";
	}

	async function mostrar() {
		if (!secret) return;
		var nome = telaAtual();
		document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.getAttribute("data-view") !== nome; });
		document.querySelectorAll(".nav-item").forEach(function (a) {
			if (a.getAttribute("data-nav") === nome) a.setAttribute("aria-current", "page");
			else a.removeAttribute("aria-current");
		});
		$("crumb").textContent = "Cofre NFapi / " + TELAS[nome][0];
		document.title = TELAS[nome][0] + " · Cofre NFapi";
		if (!$("drawer").hidden) fecharDetalhe();
		fecharMenu();
		pintarAndamento();
		window.scrollTo(0, 0);
		try {
			await TELAS[nome][1]();
		} catch (err) {
			// As telas de listagem mostram o próprio erro; as demais, um aviso simples.
			console.error(err);
		}
	}

	// Recarrega o estado do cofre (certificado, ambiente) e a tela aberta.
	async function refresh() {
		state = await api("GET", "/admin/status");
		renderTopo();
		await mostrar();
	}

	window.addEventListener("hashchange", mostrar);
	$("menu").addEventListener("click", function () {
		$("sidebar").classList.add("open");
		$("backdrop").hidden = false;
	});
	$("backdrop").addEventListener("click", function () {
		if (!$("drawer").hidden) fecharDetalhe();
		fecharMenu();
	});
	$("drawer-close").addEventListener("click", fecharDetalhe);
	document.addEventListener("keydown", function (ev) {
		if (ev.key !== "Escape") return;
		if (!$("drawer").hidden) fecharDetalhe();
		else fecharMenu();
	});

	// ---------- Entrada e saída ----------

	$("login-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		secret = $("secret").value.trim();
		erro("login-error", "");
		try {
			state = await busy(ev.submitter, function () { return api("GET", "/admin/status"); });
			atualizacao = await api("GET", "/admin/atualizacao").catch(function () { return null; });
			paginaImplantacao = atualizacao ? atualizacao.implantacao : null;
			if (atualizacao && atualizacao.andamento && atualizacao.andamento.situacao !== "concluida") vigiar();
			$("secret").value = "";
			$("vg-ambiente").value = state.allowProduction ? "producao" : "homologacao";
			$("rl-ambiente").value = $("vg-ambiente").value;
			$("login").hidden = true;
			$("panel").hidden = false;
			renderTopo();
			await mostrar();
		} catch (err) {
			secret = "";
			erro("login-error", err.message);
		}
	});

	$("logout").addEventListener("click", function () {
		secret = "";
		state = null;
		$("panel").hidden = true;
		$("login").hidden = false;
		document.title = "Cofre NFapi";
		$("secret").focus();
	});

	// ---------- Filtros ----------

	$("vg-ambiente").addEventListener("change", renderVisao);
	$("vg-periodo").addEventListener("change", renderVisao);

	ligarDatas("em");
	$("em-filtros").addEventListener("submit", function (ev) { ev.preventDefault(); emPagina = 1; renderEmitidas(); });
	$("em-limpar").addEventListener("click", function () {
		$("em-filtros").reset();
		$("em-filtros").querySelectorAll("[data-datas]").forEach(function (campo) { campo.hidden = true; });
		emPagina = 1;
		renderEmitidas();
	});

	ligarDatas("rc");
	$("rc-filtros").addEventListener("submit", function (ev) { ev.preventDefault(); rcPagina = 1; renderRecebidas(); });
	$("rc-limpar").addEventListener("click", function () {
		$("rc-filtros").reset();
		$("rc-filtros").querySelectorAll("[data-datas]").forEach(function (campo) { campo.hidden = true; });
		rcPagina = 1;
		renderRecebidas();
	});

	ligarDatas("rl");
	$("rl-ambiente").addEventListener("change", renderRelatorio);
	$("rl-periodo").addEventListener("change", function () { if ($("rl-periodo").value !== "datas") renderRelatorio(); });
	$("rl-filtros").addEventListener("submit", function (ev) { ev.preventDefault(); renderRelatorio(); });

	$("ex-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		if (exportando) clearTimeout(exportando);
		var p = periodoDoRelatorio();
		if (!p) return;
		var incluir = [];
		if ($("ex-emitidas").checked) incluir.push("nfse", "nfe", "nfce");
		if ($("ex-eventos").checked) incluir.push("eventos");
		if ($("ex-inutilizacoes").checked) incluir.push("inutilizacoes");
		if ($("ex-recebidas").checked) incluir.push("recebidas");
		if (incluir.length === 0) return message("ex-message", "Marque ao menos um tipo de arquivo.", "error");
		$("ex-resultado").hidden = true;
		message("ex-message", "Reunindo os arquivos do período…");
		try {
			var x = await busy(ev.submitter, function () { return api("POST", "/admin/painel/exportacoes", { ambiente: p.ambiente, de: p.de, ate: p.ate, incluir: incluir }); });
			mostrarExportacao(x);
		} catch (err) {
			message("ex-message", err.message, "error");
		}
	});

	// ---------- Ações da configuração ----------

	$("cert-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var form = new FormData();
		form.append("pfx", $("pfx").files[0]);
		form.append("password", $("pfx-password").value);
		message("cert-message", "Lendo o certificado…");
		try {
			await busy(ev.submitter, function () { return api("POST", "/admin/certificate", form); });
			$("pfx").value = "";
			$("pfx-password").value = "";
			await refresh();
			message("cert-message", "Certificado instalado.", "ok");
		} catch (err) {
			message("cert-message", err.message, "error");
		}
	});

	$("cert-remove").addEventListener("click", async function (ev) {
		if (!confirm("Remover o certificado do cofre? As emissões param até você instalar outro.")) return;
		await busy(ev.currentTarget, function () { return api("DELETE", "/admin/certificate"); });
		await refresh();
		message("cert-message", "Certificado removido.", "warn");
	});

	$("selftest").addEventListener("click", async function (ev) {
		var list = $("selftest-results");
		clear(list);
		list.appendChild(el("li", { text: "Testando… a primeira conexão pode levar alguns segundos." }));
		try {
			var data = await busy(ev.currentTarget, function () { return api("POST", "/admin/selftest"); });
			clear(list);
			data.results.forEach(function (r) {
				list.appendChild(el("li", {}, [
					el("span", {}, [el("strong", { text: r.name }), el("span", { class: "detail", text: r.detail })]),
					selo(r.ok ? "Funcionou" : "Falhou", r.ok ? "success" : "danger")
				]));
			});
		} catch (err) {
			clear(list);
			list.appendChild(el("li", { class: "tone-bad", text: err.message }));
		}
	});

	$("env-toggle").addEventListener("click", async function (ev) {
		var next = !state.allowProduction;
		if (next && !confirm("Liberar a produção? A partir de agora o cofre emite notas com valor fiscal.")) return;
		await busy(ev.currentTarget, function () { return api("PUT", "/admin/settings", { allowProduction: next }); });
		await refresh();
	});

	$("serie-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var pedido = {
			modelo: $("serie-modelo").value,
			ambiente: $("serie-ambiente").value,
			serie: Number($("serie-numero").value),
			descricao: $("serie-descricao").value.trim()
		};
		if ($("serie-proximo").value.trim()) pedido.proximoNumero = Number($("serie-proximo").value);
		try {
			await busy(ev.submitter, function () { return api("PUT", "/admin/series", pedido); });
			$("serie-proximo").value = "";
			$("serie-descricao").value = "";
			message("series-message", "Série salva.", "ok");
			await renderSeries();
		} catch (err) {
			message("series-message", err.message, "error");
		}
	});

	$("logo-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var arquivo = $("logo-file").files[0];
		if (!arquivo) return;
		try {
			await busy(ev.submitter, function () { return api("PUT", "/admin/logotipo", arquivo); });
			$("logo-file").value = "";
			message("logo-message", "Logotipo salvo.", "ok");
			await renderLogo();
		} catch (err) {
			message("logo-message", err.message, "error");
		}
	});

	$("logo-remove").addEventListener("click", async function (ev) {
		if (!confirm("Remover o logotipo? Os documentos passam a sair sem imagem.")) return;
		try {
			await busy(ev.currentTarget, function () { return api("DELETE", "/admin/logotipo"); });
			message("logo-message", "Logotipo removido.", "ok");
			await renderLogo();
		} catch (err) {
			message("logo-message", err.message, "error");
		}
	});

	$("dfe-ambiente").addEventListener("change", preencherDistribuicao);
	$("dfe-auto").addEventListener("change", function () {
		$("dfe-ciencia").disabled = !$("dfe-auto").checked;
		if (!$("dfe-auto").checked) $("dfe-ciencia").checked = false;
	});

	$("dfe-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var pedido = {
			ambiente: $("dfe-ambiente").value,
			uf: $("dfe-uf").value,
			consultaAutomatica: $("dfe-auto").checked,
			cienciaAutomatica: $("dfe-auto").checked && $("dfe-ciencia").checked
		};
		if (pedido.cienciaAutomatica && pedido.ambiente === "producao" &&
			!confirm("Ligar a ciência automática em produção? O cofre passa a registrar, em nome da empresa, a ciência de cada nota nova emitida contra o CNPJ.")) return;
		try {
			await busy(ev.submitter, function () { return api("PUT", "/admin/distribuicao", pedido); });
			await renderDistribuicao();
			message("dfe-config-message", "Configuração salva.", "ok");
		} catch (err) {
			message("dfe-config-message", err.message, "error");
		}
	});

	$("dfe-sync").addEventListener("click", function (ev) {
		sincronizar($("dfe-ambiente").value, ev.currentTarget, "dfe-config-message");
	});

	// ---------- Chaves e atualização ----------

	$("apikey-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var data = await busy(ev.submitter, function () {
			return api("POST", "/admin/chaves", { nome: $("apikey-name").value || undefined, escopo: $("apikey-scope").value });
		});
		$("apikey-value").value = data.chave.valor;
		$("apikey-box").hidden = false;
		$("apikey-copy").textContent = "Copiar chave";
		$("apikey-name").value = "";
		await renderKeys();
	});

	$("apikey-copy").addEventListener("click", function () {
		copiar($("apikey-value"), $("apikey-copy"), "Copiada");
	});

	$("update-check").addEventListener("click", async function (ev) {
		message("update-message", "");
		await busy(ev.currentTarget, function () { return renderUpdate(true); });
	});

	$("update-run").addEventListener("click", async function (ev) {
		if (!confirm("Atualizar o cofre agora? Ele continua funcionando enquanto o Cloudflare prepara a versão nova. Leva de um a três minutos e esta tela mostra o andamento.")) return;
		try {
			var data = await busy(ev.currentTarget, function () { return api("POST", "/admin/atualizacao"); });
			message("update-message", "");
			if (atualizacao) {
				atualizacao.andamento = data.andamento;
				pintarUpdate(atualizacao);
			}
		} catch (err) {
			message("update-message", err.message, "error");
		}
	});

	// A página recarregada volta para a entrada: o segredo do cofre não fica guardado no navegador.
	[$("update-reload"), $("update-banner-reload")].forEach(function (botao) {
		botao.addEventListener("click", function () { location.reload(); });
	});

	$("hook-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		try {
			await busy(ev.submitter, function () { return api("PUT", "/admin/atualizacao/gatilho", { url: $("hook-url").value.trim() }); });
			$("hook-url").value = "";
			message("update-message", "Gatilho salvo.", "ok");
			await renderUpdate(false);
		} catch (err) {
			message("update-message", err.message, "error");
		}
	});
})();`;
