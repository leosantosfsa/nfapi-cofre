// Contrato da API do cofre (OpenAPI 3.1), servido em GET /v1/openapi.json e
// copiado em docs/openapi.json a cada versão.
//
// Os formatos de pedido saem dos mesmos schemas que validam as requisições,
// então o contrato não tem como divergir do que o cofre aceita.

import { z } from "zod";
import { EXEMPLO_CHAVE_RECEBIDA, EXEMPLO_NFCE, EXEMPLO_NFE, EXEMPLO_NFSE } from "./contrato-exemplos";
import { CancelamentoNfe, CartaCorrecao, InutilizacaoInput, NfceInput, NfeInput } from "./nfe/schema";
import { CancelamentoInput, NfseInput } from "./nfse";
import { VAULT_VERSION } from "./protocol";
import { ConsultarChaveInput, ManifestacaoInput, ManifestacaoPorChaveInput, SincronizarInput } from "./recebidas/schema";
import { ExportacaoBase, TIPOS } from "./relatorios-schema";

type Json = Record<string, unknown>;

function esquema(schema: z.ZodType): Json {
	const { $schema: _descartado, ...resto } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
	return resto;
}

const ref = (nome: string) => ({ $ref: `#/components/schemas/${nome}` });
const corpo = (schema: Json, exemplo?: unknown) => ({
	required: true,
	content: { "application/json": { schema, ...(exemplo ? { example: exemplo } : {}) } },
});
const resposta = (descricao: string, schema?: Json) => ({
	description: descricao,
	...(schema ? { content: { "application/json": { schema } } } : {}),
});

const ERROS: Record<number, string> = {
	400: "Pedido inválido. `erro.mensagem` aponta o campo.",
	401: "Chave de API ausente, inválida ou revogada.",
	403: "A chave só opera em homologação.",
	404: "Emissão inexistente.",
	409: "Conflito: referência em andamento, referência reenviada com outro conteúdo, certificado ausente ou nota em situação que não permite a operação.",
	422: "Recusado pelo governo ou barrado pelo cofre antes de transmitir. Com rejeição, o corpo traz a emissão e as mensagens (cStat e xMotivo).",
	429: "Notas recebidas: o Ambiente Nacional bloqueou as consultas do CNPJ por uma hora, ou o limite de consultas por chave foi atingido. `erro.mensagem` diz a partir de quando tentar.",
	502: "Sem resposta conclusiva do governo. Repita o pedido com a mesma referência: o cofre consulta antes de reenviar.",
	500: "Falha inesperada do cofre (erro_interno). Pode ser repetido; com referência, a repetição é segura.",
	503: "O cofre não está pronto para atender (cofre_nao_configurado): a instalação não foi concluída.",
};
/** Toda operação pode devolver 500 e 503, além dos erros próprios dela. */
const erros = (...codigos: number[]) => Object.fromEntries([...codigos, 500, 503].map((c) => [String(c), resposta(ERROS[c] as string, ref("Erro"))]));

const texto = { type: "string" };
const textoOuNulo = { type: ["string", "null"] };
const dataHora = { type: "string", format: "date-time" };
const mensagens = {
	type: "array",
	description: "Código e descrição devolvidos pelo governo (na NF-e e NFC-e, cStat e xMotivo) ou pelo cofre.",
	items: { type: "object", properties: { codigo: texto, descricao: texto }, required: ["codigo", "descricao"] },
};
const AMBIENTE = { type: "string", enum: ["homologacao", "producao"] };

const Cabecalho = {
	type: "object",
	properties: {
		ambiente: { ...AMBIENTE, default: "homologacao" },
		referencia: {
			type: "string",
			pattern: "^[A-Za-z0-9._:-]{1,80}$",
			description:
				"Identificador do pedido no seu sistema. Repetir a referência com o mesmo conteúdo devolve a mesma emissão; com conteúdo diferente, o cofre recusa (409 referencia_com_conteudo_diferente). Só uma nota rejeitada pode ser reenviada corrigida com a mesma referência.",
		},
	},
};

const EmissaoNfe = {
	type: "object",
	properties: {
		id: texto,
		modelo: { type: "string", enum: ["nfe", "nfce"] },
		ambiente: AMBIENTE,
		referencia: textoOuNulo,
		serie: { type: "integer" },
		numero: { type: "integer" },
		situacao: {
			type: "string",
			enum: ["processando", "autorizada", "contingencia", "rejeitada", "denegada", "erro", "indefinida", "cancelada"],
			description:
				"`indefinida`: a resposta do governo se perdeu; use POST .../consultar ou repita o pedido com a mesma referência. `erro`: barrada pelo cofre antes de transmitir. `contingencia`: NFC-e emitida offline; vale para o consumidor, ainda sem protocolo, e o cofre a transmite quando a SEFAZ voltar.",
		},
		chaveAcesso: textoOuNulo,
		protocolo: textoOuNulo,
		emitidaEm: { ...textoOuNulo, description: "Data e hora de emissão que estão no XML (dhEmi), com o fuso da UF." },
		autorizadaEm: { ...textoOuNulo, description: "Data e hora em que a SEFAZ autorizou (dhRecbto). Com o protocolo, vai impressa no DANFE e no DANFCE." },
		valor: { type: ["number", "null"], description: "Valor total da nota (vNF), somado pelo cofre." },
		qrCode: { ...textoOuNulo, description: "Só na NFC-e: conteúdo do QR Code." },
		urlConsulta: { ...textoOuNulo, description: "Só na NFC-e: endereço de consulta pela chave." },
		cartasCorrecao: { type: "integer" },
		contingencia: {
			type: ["object", "null"],
			description: "Só na NFC-e emitida em contingência offline; null nas demais.",
			properties: {
				pendente: { type: "boolean", description: "A nota ainda aguarda a transmissão à SEFAZ." },
				desde: { ...textoOuNulo, description: "Quando o emitente entrou em contingência (dhCont)." },
				motivo: textoOuNulo,
				tentativasDeTransmissao: { type: "integer" },
				ultimaTentativa: textoOuNulo,
				notaNormalEmConferencia: { ...textoOuNulo, description: "Chave da NFC-e normal da mesma venda que ficou sem resposta: o cofre ainda vai conferi-la na SEFAZ." },
				falhaNaConferencia: { ...textoOuNulo, description: "A SEFAZ rejeitou o cancelamento da nota normal: precisa de ação do emitente." },
				notaNormalCancelada: { ...textoOuNulo, description: "Chave da NFC-e normal que acabou autorizada e foi cancelada por substituição (evento 110112)." },
			},
		},
		mensagens,
		xmlDisponivel: { type: "boolean", description: "Na contingência pendente, o XML é a nota assinada sem protocolo; depois de autorizada, o nfeProc." },
		criadaEm: dataHora,
		atualizadaEm: dataHora,
	},
	required: ["id", "modelo", "ambiente", "serie", "numero", "situacao", "mensagens", "xmlDisponivel"],
};

const negrito = { type: "boolean" };
const LinhaDoCupom = {
	description: "Uma linha do cupom. O campo `tipo` diz o formato.",
	oneOf: [
		{
			type: "object",
			description: "Texto livre: razão social, dizeres obrigatórios, informações adicionais.",
			properties: {
				tipo: { const: "texto" },
				texto,
				alinhamento: { type: "string", enum: ["esquerda", "centro", "direita"] },
				negrito,
				tamanho: { type: "string", enum: ["normal", "dobrado"], description: "`dobrado`: altura e largura dobradas, quando a impressora tiver." },
			},
			required: ["tipo", "texto", "alinhamento", "negrito", "tamanho"],
		},
		{ type: "object", description: "Linha separadora, do jeito que o caixa costuma imprimir.", properties: { tipo: { const: "separador" } }, required: ["tipo"] },
		{
			type: "object",
			description: "Item da venda, em campos: o caixa monta as colunas conforme a largura da bobina.",
			properties: {
				tipo: { const: "item" },
				numero: { type: "integer" },
				codigo: texto,
				descricao: texto,
				quantidade: { type: "number" },
				unidade: texto,
				valorUnitario: { type: "number" },
				valorTotal: { type: "number" },
				quantidadeTexto: { ...texto, description: "A quantidade já no formato de impressão (vírgula decimal)." },
				valorUnitarioTexto: texto,
				valorTotalTexto: texto,
			},
			required: ["tipo", "numero", "codigo", "descricao", "quantidade", "unidade", "valorUnitario", "valorTotal", "quantidadeTexto", "valorUnitarioTexto", "valorTotalTexto"],
		},
		{
			type: "object",
			description: "Rótulo à esquerda e valor à direita: totais, formas de pagamento, troco, tributos.",
			properties: { tipo: { const: "par" }, rotulo: texto, valor: texto, negrito },
			required: ["tipo", "rotulo", "valor", "negrito"],
		},
		{
			type: "object",
			description: "Chave de acesso: só os 44 caracteres. Imprima em 11 blocos de 4, separados por espaço.",
			properties: { tipo: { const: "chave" }, chave: texto },
			required: ["tipo", "chave"],
		},
		{
			type: "object",
			description: "QR Code: gere a imagem a partir do texto, sem alterar nem truncar, em preto e branco puro.",
			properties: { tipo: { const: "qrcode" }, texto, tamanhoMinimoMm: { type: "number", description: "Lado mínimo da imagem impressa, em milímetros." } },
			required: ["tipo", "texto", "tamanhoMinimoMm"],
		},
	],
};

const Cupom = {
	type: "object",
	description:
		"Conteúdo do DANFE NFC-e, na ordem e com os dizeres do manual oficial (versão 6.0), para o caixa imprimir na bobina. " +
		"Imprima as seções na ordem em que vêm e as linhas na ordem em que vêm. Não há largura, corte nem avanço de papel: isso é do caixa. " +
		"Os textos fixos usam só caracteres das páginas de código comuns de impressora; os que vêm da nota (nomes, descrições, informações adicionais) saem como estão no XML.",
	properties: {
		id: texto,
		situacao: { type: "string", description: "Situação da emissão no cofre. Uma nota `cancelada` ainda devolve o cupom: não o entregue ao consumidor." },
		modelo: { const: "nfce" },
		chaveAcesso: texto,
		ambiente: AMBIENTE,
		contingencia: { type: "boolean", description: "Nota emitida em contingência offline. Imprima também a via do estabelecimento (`?via=estabelecimento`)." },
		pendenteDeAutorizacao: { type: "boolean", description: "A nota em contingência ainda não foi autorizada: o cupom sai com os dizeres de contingência e sem protocolo." },
		via: { type: "string", enum: ["consumidor", "estabelecimento"] },
		numero: { type: "integer" },
		serie: { type: "integer" },
		emitidaEm: texto,
		protocolo: textoOuNulo,
		autorizadaEm: textoOuNulo,
		valorAPagar: { type: "number" },
		qrCode: { ...texto, description: "O mesmo texto da linha `qrcode`, para quem monta o cupom por conta própria." },
		urlConsulta: { ...texto, description: "Endereço de consulta pela chave de acesso." },
		secoes: {
			type: "array",
			description: "Divisões do DANFE NFC-e que têm conteúdo, na ordem de impressão.",
			items: {
				type: "object",
				properties: {
					divisao: { type: "string", enum: ["cabecalho", "itens", "totais", "consulta", "consumidor", "identificacao", "qrcode", "mensagem_fiscal", "mensagem_contribuinte"] },
					linhas: { type: "array", items: ref("LinhaDoCupom") },
				},
				required: ["divisao", "linhas"],
			},
		},
	},
	required: ["id", "situacao", "modelo", "chaveAcesso", "ambiente", "contingencia", "pendenteDeAutorizacao", "via", "numero", "serie", "emitidaEm", "valorAPagar", "qrCode", "urlConsulta", "secoes"],
};

const OpcoesNfce = {
	type: "object",
	properties: {
		contingencia: {
			type: "string",
			enum: ["nunca", "automatica", "forcada"],
			default: "nunca",
			description:
				"O que fazer quando a SEFAZ não responde. `automatica`: o cofre espera até 20 segundos e, sem resposta conclusiva, emite a nota em contingência offline (tipo de emissão 9), com número novo, e a devolve com `situacao: \"contingencia\"` para o caixa imprimir; enquanto a SEFAZ segue fora, as vendas seguintes saem direto em contingência. `forcada`: emite direto em contingência. `nunca`: devolve 502. O cofre transmite as notas pendentes sozinho quando a SEFAZ volta. Não entra na comparação de conteúdo da referência. O DANFCE da nota em contingência tem textos e vias próprios, e o prazo legal de transmissão é o fim do primeiro dia útil seguinte.",
		},
	},
};

const EmissaoNfse = {
	type: "object",
	properties: {
		id: texto,
		ambiente: AMBIENTE,
		referencia: textoOuNulo,
		serie: texto,
		numero: { type: "integer", description: "Número da DPS." },
		idDps: texto,
		situacao: { type: "string", enum: ["processando", "autorizada", "rejeitada", "erro", "indefinida", "cancelada"] },
		chaveAcesso: textoOuNulo,
		numeroNfse: textoOuNulo,
		mensagens,
		xmlDisponivel: { type: "boolean" },
		criadaEm: dataHora,
		atualizadaEm: dataHora,
	},
	required: ["id", "ambiente", "serie", "numero", "situacao", "mensagens", "xmlDisponivel"],
};

const id = { name: "id", in: "path", required: true, schema: texto, description: "Id da emissão no cofre." };
const filtros = [
	{ name: "referencia", in: "query", schema: texto, description: "Pesquisa pela referência do seu sistema. A referência é única por ambiente: combine com `ambiente`." },
	{ name: "ambiente", in: "query", schema: AMBIENTE, description: "Só as emissões deste ambiente. Sem o filtro, vêm as dos dois." },
	{ name: "limite", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
];
const xml = { description: "XML autorizado.", content: { "application/xml": { schema: texto } } };
const pdf = (descricao: string) => ({ description: descricao, content: { "application/pdf": { schema: { type: "string", format: "binary" } } } });
const xmlDoEvento = { description: "XML do evento com o retorno do governo, como deve ser guardado e entregue.", content: { "application/xml": { schema: texto } } };

/** Resposta de cancelamento e de carta de correção: a emissão e se o pedido era repetido. */
const comRepetido = (emissao: Json) => ({
	allOf: [
		emissao,
		{
			type: "object",
			properties: {
				repetido: {
					type: "boolean",
					description: "true quando o evento já estava registrado e nada novo foi enviado ao governo. Use para não lançar o efeito duas vezes.",
				},
			},
			required: ["repetido"],
		},
	],
});

/**
 * Códigos de `erro.codigo` da API. A lista cresce com as versões: trate um
 * código desconhecido pelo status HTTP. Um teste confere que todo código
 * usado no cofre está aqui.
 */
export const CODIGOS_DE_ERRO: Record<string, { status: number; quando: string }> = {
	requisicao_invalida: { status: 400, quando: "O corpo ou um parâmetro não passou na validação; `mensagem` (e `campo`, na NF-e e NFC-e) aponta onde." },
	nao_autenticado: { status: 401, quando: "Chave de API ausente, inválida ou revogada." },
	chave_somente_homologacao: { status: 403, quando: "A chave é de teste e o pedido é de produção." },
	nao_encontrado: { status: 404, quando: "Emissão, XML ou rota inexistente." },
	certificado_ausente: { status: 409, quando: "Não há certificado instalado no cofre." },
	certificado_vencido: { status: 409, quando: "O certificado instalado venceu." },
	emissao_em_andamento: { status: 409, quando: "Já há um pedido com a mesma referência em andamento. Aguarde e consulte." },
	referencia_com_conteudo_diferente: { status: 409, quando: "A referência já foi usada com outro conteúdo. Não repita: é um documento novo ou um erro do chamador." },
	numero_ja_utilizado: { status: 409, quando: "NFS-e: o número informado no pedido já foi usado na série." },
	nfe_nao_autorizada: { status: 409, quando: "Cancelamento ou carta de correção de NF-e/NFC-e que não está autorizada, ou pedido de cupom, DANFE ou DANFE NFC-e de nota sem XML arquivado." },
	nfse_nao_autorizada: { status: 409, quando: "Cancelamento de NFS-e que não está autorizada." },
	faixa_em_uso: { status: 409, quando: "Inutilização de faixa que contém nota autorizada ou em andamento." },
	serie_nao_cadastrada: { status: 422, quando: "A série do pedido não está cadastrada no cofre para o modelo e o ambiente." },
	serie_obrigatoria: { status: 422, quando: "Há mais de uma série cadastrada e o pedido não disse qual." },
	uf_nao_suportada: { status: 422, quando: "O cofre ainda não tem autorizador para a UF do emitente." },
	emitente_divergente: { status: 422, quando: "O emitente não é o titular do certificado nem uma filial de mesma raiz de CNPJ." },
	producao_bloqueada: { status: 422, quando: "O pedido é de produção e o emitente não liberou a produção no cofre." },
	nfe_rejeitada: { status: 422, quando: "A SEFAZ rejeitou a nota; `mensagens` traz cStat e xMotivo. Corrija e reenvie, com a mesma referência se quiser." },
	nfe_denegada: { status: 422, quando: "A SEFAZ denegou o uso da nota. O número fica consumido." },
	nfse_rejeitada: { status: 422, quando: "A SEFIN rejeitou a NFS-e; `mensagens` traz os códigos." },
	cancelamento_rejeitado: { status: 422, quando: "O governo rejeitou o cancelamento (por exemplo, fora do prazo)." },
	carta_rejeitada: { status: 422, quando: "A SEFAZ rejeitou a carta de correção." },
	carta_nao_se_aplica: { status: 422, quando: "Carta de correção pedida para documento que não é NF-e." },
	limite_de_cartas: { status: 422, quando: "A nota já tem 20 cartas de correção." },
	inutilizacao_rejeitada: { status: 422, quando: "A SEFAZ rejeitou a inutilização." },
	inutilizacao_extinta: { status: 422, quando: "A UF não tem mais inutilização de numeração (SP, AC e BA)." },
	host_nao_permitido: { status: 422, quando: "Falha interna: o cofre recusou transmitir para um endereço que não é do governo." },
	certificado_do_cliente_invalido: { status: 422, quando: "O governo recusou o certificado na conexão." },
	distribuicao_nao_configurada: { status: 409, quando: "Notas recebidas: o emitente ainda não informou a UF do estabelecimento na tela do cofre." },
	xml_indisponivel: { status: 409, quando: "Nota recebida de que o cofre só tem o resumo: o XML completo (e o DANFE) só existe depois da manifestação do destinatário." },
	manifestacao_ja_registrada: { status: 409, quando: "Ciência da operação pedida depois de outra manifestação da mesma nota." },
	chave_de_acesso_invalida: { status: 422, quando: "Notas recebidas: a chave de acesso não é de uma NF-e (modelo 55) ou o dígito verificador não confere." },
	justificativa_obrigatoria: { status: 422, quando: "Operação não realizada sem a justificativa de 15 a 255 caracteres." },
	limite_de_manifestacoes: { status: 422, quando: "A nota já tem duas manifestações conclusivas do mesmo tipo (o máximo, contando a retificação)." },
	manifestacao_rejeitada: { status: 422, quando: "O Ambiente Nacional rejeitou a manifestação (fora do prazo, nota cancelada...); `mensagens` traz cStat e xMotivo." },
	nota_nao_localizada: { status: 422, quando: "Consulta por chave: o Ambiente Nacional não tem a nota disponível para o CNPJ (mais de 90 dias, chave de outra empresa ou nota ainda não recebida por ele)." },
	consulta_rejeitada: { status: 422, quando: "O Ambiente Nacional rejeitou a consulta por chave; `mensagens` traz cStat e xMotivo." },
	consumo_indevido: { status: 429, quando: "O Ambiente Nacional bloqueou as consultas do CNPJ por uma hora (cStat 656). Nada sai do cofre até o horário em `mensagem`." },
	link_invalido: { status: 403, quando: "Download da exportação: o link venceu, foi alterado ou a exportação não existe mais. Consulte a exportação para receber links novos." },
	limite_de_consultas: { status: 429, quando: "Consulta por chave: o cofre atingiu 18 consultas em uma hora (o Ambiente Nacional bloqueia a partir de 20)." },
	sem_resposta_conclusiva: { status: 502, quando: "A resposta do governo se perdeu ou não foi conclusiva. Na NF-e e NFC-e, chame /consultar; em qualquer documento, repetir com a mesma referência consulta antes de reenviar. Na NFC-e, `contingencia: \"automatica\"` troca este erro por uma nota em contingência." },
	sem_conexao: { status: 200, quando: "Só em GET /v1/sefaz/status, dentro de `mensagem.codigo`: não foi possível falar com a SEFAZ." },
	erro_interno: { status: 500, quando: "Falha inesperada do cofre." },
	cofre_nao_configurado: { status: 503, quando: "O segredo do cofre está ausente ou é fraco demais: a instalação não foi concluída." },
};

// ---------- NF-e recebidas (distribuição de DF-e e manifestação do destinatário) ----------

const inteiro = { type: "integer" };
const ManifestacaoRegistrada = {
	type: "object",
	properties: {
		tipo: { type: "string", enum: ["ciencia", "confirmacao", "desconhecimento", "nao_realizada"] },
		sequencia: { ...inteiro, description: "1, ou 2 na retificação de uma manifestação conclusiva." },
		protocolo: { ...textoOuNulo, description: "Nulo quando o evento já estava no Ambiente Nacional, registrado fora do cofre." },
		registradaEm: dataHora,
		justificativa: textoOuNulo,
		origem: { type: "string", description: "`agendador` na ciência automática; senão, a chave de API (`chave:...`) ou o painel (`admin`)." },
		xmlDisponivel: { type: "boolean" },
	},
};
const NotaRecebida = {
	type: "object",
	description: "NF-e que outra empresa emitiu e que interessa ao titular do cofre. Nasce do resumo entregue pelo Ambiente Nacional e ganha o XML completo depois da manifestação do destinatário.",
	properties: {
		id: texto,
		ambiente: AMBIENTE,
		cnpj: { type: "string", description: "CNPJ do titular (ou da filial) a quem a nota interessa." },
		chaveAcesso: texto,
		sequencia: { ...inteiro, description: "Cresce a cada mudança da nota (XML que chegou, cancelamento, manifestação). É o cursor de leitura: guarde a maior que já viu e passe em `?depois=`." },
		papel: { type: "string", enum: ["destinatario", "terceiro"], description: "`terceiro`: o titular é transportador ou autorizado a baixar o XML, não o destinatário. Só confronte com pedido de compra as notas de papel `destinatario`." },
		emitente: { type: "object", properties: { documento: texto, nome: textoOuNulo, ie: textoOuNulo } },
		serie: inteiro,
		numero: inteiro,
		emitidaEm: textoOuNulo,
		autorizadaEm: textoOuNulo,
		protocolo: textoOuNulo,
		tipoOperacao: { type: ["string", "null"], enum: ["entrada", "saida", null], description: "Do ponto de vista do emitente da nota." },
		valor: { type: ["number", "null"], description: "Valor total da nota (vNF)." },
		situacao: { type: ["string", "null"], enum: ["autorizada", "cancelada", "denegada", null], description: "Nulo enquanto o cofre só conhece a chave (manifestação feita antes de o resumo chegar)." },
		xmlDisponivel: { type: "boolean", description: "O cofre já tem o XML completo (nfeProc)? Antes da manifestação só há o resumo." },
		manifestacao: { oneOf: [ref("ManifestacaoRegistrada"), { type: "null" }], description: "A última manifestação: é a que vale." },
		manifestacoes: { type: "array", items: ref("ManifestacaoRegistrada") },
		cienciaAutomaticaRecusada: { type: ["object", "null"], properties: { codigo: texto, descricao: texto }, description: "Motivo da recusa quando a ciência automática foi tentada e o Ambiente Nacional não aceitou." },
		eventos: { type: "array", items: ref("DocumentoDistribuido"), description: "Só na consulta de uma nota: os eventos recebidos (cancelamento, carta de correção...)." },
		recebidaEm: dataHora,
		atualizadaEm: dataHora,
		repetido: { type: "boolean", description: "Só na resposta da manifestação: ela já estava registrada e nada novo foi enviado." },
	},
	required: ["id", "ambiente", "cnpj", "chaveAcesso", "sequencia", "papel", "xmlDisponivel", "manifestacoes"],
};
const DocumentoDistribuido = {
	type: "object",
	description: "Um documento entregue pelo Ambiente Nacional, como chegou.",
	properties: {
		sequencia: { ...inteiro, description: "Ordem de chegada no cofre; cursor de leitura de GET /v1/distribuicao/documentos." },
		ambiente: AMBIENTE,
		cnpj: texto,
		nsu: { type: ["integer", "null"], description: "NSU do documento no Ambiente Nacional; nulo no que veio da consulta por chave." },
		tipo: { type: "string", enum: ["resumo_nfe", "nfe", "resumo_evento", "evento", "outro"] },
		schema: { type: "string", description: "Schema informado pelo Ambiente Nacional, como `resNFe_v1.01.xsd`." },
		chaveAcesso: textoOuNulo,
		evento: {
			type: ["object", "null"],
			properties: { codigo: { type: "string", description: "tpEvento: 110111 cancelamento, 110110 carta de correção, 2102xx manifestação do destinatário..." }, sequencia: inteiro, descricao: textoOuNulo, registradoEm: textoOuNulo, protocolo: textoOuNulo, autor: textoOuNulo },
		},
		recebidoEm: dataHora,
	},
};
const Distribuicao = {
	type: "object",
	description: "Estado da consulta das notas recebidas de um CNPJ em um ambiente. O último NSU e a espera entre consultas são controlados só pelo cofre.",
	properties: {
		cnpj: texto,
		ambiente: AMBIENTE,
		uf: texto,
		consultaAutomatica: { type: "boolean", description: "O cofre consulta sozinho (ligado pelo emitente na tela do cofre)." },
		cienciaAutomatica: { type: "boolean", description: "O cofre registra sozinho a ciência da operação das notas novas (ligado pelo emitente)." },
		ultimoNsu: inteiro,
		maiorNsu: inteiro,
		ultimaConsulta: { type: ["string", "null"], format: "date-time" },
		proximaConsulta: { type: ["string", "null"], format: "date-time", description: "Antes deste instante o cofre não consulta: depois de \"nenhum documento\" o Ambiente Nacional exige uma hora de espera. Nulo quando já pode consultar." },
		bloqueada: { type: "boolean", description: "O Ambiente Nacional bloqueou as consultas do CNPJ (consumo indevido) até `proximaConsulta`." },
		mensagem: { type: ["object", "null"], properties: { codigo: texto, descricao: texto }, description: "Última resposta: 138 documentos localizados, 137 nenhum documento, 656 consumo indevido." },
		consultasPorChave: { type: "object", properties: { naUltimaHora: inteiro, limite: inteiro }, description: "Consultas pontuais (por chave e por NSU) na última hora e o limite do cofre." },
		documentosARecuperar: {
			type: "integer",
			description:
				"Documentos que ficaram para trás e que o cofre ainda vai buscar um a um, sozinho, a cerca de 12 por hora. Acontece quando outro sistema (o do contador, por exemplo) consulta o mesmo CNPJ: o Ambiente Nacional recusa a consulta do cofre (656) e devolve o NSU em que o outro parou. Zero no uso normal.",
		},
	},
};
const Sincronizacao = {
	type: "object",
	properties: {
		consultou: { type: "boolean", description: "false: a espera ainda não venceu (ou outra consulta está em andamento) e nada foi enviado ao Ambiente Nacional." },
		lotes: inteiro,
		documentos: { type: "integer", description: "Documentos novos no cofre nesta consulta, contando os recuperados." },
		recuperados: { type: "integer", description: "Dos documentos, quantos tinham ficado para trás e foram buscados pelo NSU (ver `documentosARecuperar`)." },
		notasNovas: inteiro,
		distribuicao: ref("Distribuicao"),
	},
};
const idRecebida = { name: "id", in: "path", required: true, schema: texto, description: "Id da nota recebida no cofre (`rcb_...`)." };
const cursorDeLeitura = [
	{ name: "depois", in: "query", schema: { type: "integer", default: 0 }, description: "Só o que tem `sequencia` maior que esta. Passe a `ultimaSequencia` da leitura anterior." },
	{ name: "limite", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
	{ name: "ambiente", in: "query", schema: AMBIENTE },
	{ name: "chaveAcesso", in: "query", schema: texto },
];
const paginaDe = (campo: string, item: Json) => ({
	type: "object",
	properties: {
		[campo]: { type: "array", items: item },
		ultimaSequencia: { ...inteiro, description: "Maior sequência desta página; sem itens, repete o `depois` do pedido." },
		haMais: { type: "boolean" },
	},
});

// ---------- Relatórios e exportação por período ----------

const valor = { type: "number", description: "Em reais." };
const fatia = { quantidade: { type: "integer", description: "Quantidade de notas." }, valor };
const SITUACAO_DA_EMISSAO = { type: "string", enum: ["processando", "autorizada", "rejeitada", "denegada", "contingencia", "erro", "indefinida", "cancelada"] };
const NotaEmitida = {
	type: "object",
	description: "Uma nota emitida, de qualquer dos três documentos, como aparece nas listagens.",
	properties: {
		id: texto,
		modelo: { type: "string", enum: ["nfse", "nfe", "nfce"] },
		ambiente: AMBIENTE,
		referencia: textoOuNulo,
		serie: texto,
		numero: { ...textoOuNulo, description: "Número da nota. Na NFS-e, o número da nota autorizada (nulo antes disso); o da declaração está em `numeroDps`." },
		numeroDps: { type: ["integer", "null"] },
		situacao: SITUACAO_DA_EMISSAO,
		chaveAcesso: textoOuNulo,
		protocolo: textoOuNulo,
		emitidaEm: dataHora,
		valor: { type: ["number", "null"] },
		destinatario: {
			type: ["object", "null"],
			description: "Destinatário (NF-e, NFC-e) ou tomador (NFS-e); nulo quando a nota não identifica ninguém.",
			properties: { documento: textoOuNulo, nome: textoOuNulo },
		},
		xmlDisponivel: { type: "boolean" },
	},
};
const ValoresFiscais = {
	type: "object",
	description: "Totais lidos dos XML, em reais. `total` é o valor do documento (vNF; na NFS-e, o valor líquido).",
	properties: Object.fromEntries(
		["total", "produtos", "servicos", "desconto", "frete", "seguro", "outras", "icms", "icmsSt", "fcp", "ipi", "pis", "cofins", "ii", "iss", "ibs", "cbs", "is"].map((campo) => [campo, { type: "number" }]),
	),
};
const porCfop = { type: "array", description: "Valor dos itens por CFOP; `quantidade` conta as notas em que o CFOP aparece.", items: { type: "object", properties: { cfop: texto, ...fatia } } };
const porPessoa = { type: "array", description: "Os 50 de maior valor.", items: { type: "object", properties: { documento: textoOuNulo, nome: textoOuNulo, ...fatia } } };
const Relatorio = {
	type: "object",
	description: "Totais de um período, pelos dias de emissão. Só a nota autorizada entra nos totais fiscais: a cancelada e a recusada aparecem apenas em `porSituacao`.",
	properties: {
		ambiente: AMBIENTE,
		periodo: { type: "object", properties: { de: texto, ate: texto } },
		notasPorLer: {
			type: "integer",
			description:
				"Notas do período cujo XML o cofre ainda não leu. O cofre lê até 150 por pedido e guarda o resultado; enquanto não for zero, os impostos, o CFOP e a natureza estão incompletos. Peça de novo.",
		},
		emitidas: {
			type: "object",
			properties: {
				porSituacao: { type: "array", items: { type: "object", properties: { modelo: { type: "string", enum: ["nfse", "nfe", "nfce"] }, situacao: SITUACAO_DA_EMISSAO, ...fatia } } },
				autorizadas: { type: "object", properties: { ...fatia, impostos: ref("ValoresFiscais") } },
				porDia: { type: "array", items: { type: "object", properties: { dia: { type: "string", description: "AAAA-MM-DD." }, ...fatia } } },
				porCfop,
				porNatureza: { type: "array", items: { type: "object", properties: { natureza: { type: "string", description: "Natureza da operação; na NFS-e, o código de tributação nacional do serviço." }, ...fatia } } },
				porDestinatario: porPessoa,
			},
		},
		recebidas: {
			type: "object",
			properties: {
				porSituacao: { type: "array", items: { type: "object", properties: { situacao: texto, ...fatia } } },
				autorizadas: {
					type: "object",
					description: "As autorizadas em que o titular é o destinatário. `impostos` soma só as que já têm o XML completo (`comXml`).",
					properties: { ...fatia, comXml: { type: "integer" }, impostos: ref("ValoresFiscais") },
				},
				comoTerceiro: { type: "integer", description: "Notas em que o titular é só transportador ou autorizado a baixar o XML; ficam fora dos totais." },
				porCfop,
				porEmitente: porPessoa,
			},
		},
	},
};
const linkDeDownload = { type: "string", format: "uri", description: "Link assinado, com prazo curto: baixa direto do cofre, sem chave de API." };
const Exportacao = {
	type: "object",
	description: "Exportação dos XML de um período, com a planilha de resumo.",
	properties: {
		id: texto,
		ambiente: AMBIENTE,
		periodo: { type: "object", properties: { de: texto, ate: texto } },
		incluir: { type: "array", items: { type: "string", enum: [...TIPOS] } },
		situacao: { type: "string", enum: ["preparando", "pronta"], description: "`preparando`: o cofre ainda lê os XML para a planilha (até 200 por consulta); consulte de novo em alguns segundos. `pronta`: os links valem." },
		notasPorLer: { type: "integer" },
		arquivos: { type: "integer", description: "Quantidade de XML na exportação." },
		conteudo: {
			type: "object",
			description: "Quantos arquivos de cada tipo entraram: `nfse`, `nfe`, `nfce`, `eventos`, `inutilizacoes`, `recebidas`, `eventosRecebidos`, `manifestacoes`.",
			additionalProperties: { type: "integer" },
		},
		partes: {
			type: "array",
			description: "O ZIP sai em partes de até 400 arquivos, cada uma montada na hora do download. A planilha vai dentro da primeira.",
			items: { type: "object", properties: { parte: { type: "integer" }, nome: texto, url: linkDeDownload } },
		},
		planilha: { type: ["object", "null"], description: "Planilha de resumo (.xlsx), com uma aba para as emitidas e outra para as recebidas.", properties: { nome: texto, url: linkDeDownload } },
		linksValemAte: { type: ["string", "null"], format: "date-time", description: "Depois deste instante os links param de valer; consultar a exportação devolve links novos." },
		criadaEm: dataHora,
		expiraEm: { ...dataHora, description: "A exportação e os arquivos dela são apagados 24 horas depois de criada." },
	},
};
const periodoNaConsulta = [
	{ name: "ambiente", in: "query", required: true, schema: AMBIENTE },
	{ name: "de", in: "query", required: true, schema: texto, description: "Primeiro dia de emissão, inclusive (AAAA-MM-DD)." },
	{ name: "ate", in: "query", required: true, schema: texto, description: "Último dia de emissão, inclusive. O período vai até 366 dias." },
];

function rotasRelatorios(): Json {
	const tags = ["Relatórios e exportação"];
	const idDaExportacao = { name: "id", in: "path", required: true, schema: texto, description: "Id da exportação (`exp_...`)." };
	const exportacao = ref("Exportacao");
	return {
		"/v1/notas": {
			get: {
				tags,
				summary: "Lista as notas emitidas dos três documentos, com filtros",
				description: "Da emissão mais recente para a mais antiga. `total` e `valor` somam todas as notas do filtro, não só as desta página.",
				parameters: [
					{ name: "de", in: "query", schema: texto, description: "Primeiro dia de emissão (AAAA-MM-DD)." },
					{ name: "ate", in: "query", schema: texto, description: "Último dia de emissão (AAAA-MM-DD)." },
					{ name: "modelo", in: "query", schema: { type: "string", enum: ["nfse", "nfe", "nfce"] } },
					{ name: "situacao", in: "query", schema: SITUACAO_DA_EMISSAO },
					{ name: "ambiente", in: "query", schema: AMBIENTE },
					{ name: "busca", in: "query", schema: texto, description: "Número da nota, chave de acesso, referência, ou parte do nome ou do documento do destinatário (documento com cinco dígitos ou mais)." },
					{ name: "pagina", in: "query", schema: { type: "integer", default: 1, minimum: 1 } },
					{ name: "porPagina", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
				],
				responses: {
					"200": resposta("Notas.", { type: "object", properties: { notas: { type: "array", items: ref("NotaEmitida") }, total: { type: "integer" }, valor, pagina: { type: "integer" }, porPagina: { type: "integer" } } }),
					...erros(400, 401),
				},
			},
		},
		"/v1/relatorios/notas": {
			get: {
				tags,
				summary: "Totais do período: por situação, dia, CFOP, natureza e destinatário, com os impostos",
				description:
					"Os impostos (inclusive IBS, CBS e Imposto Seletivo), o CFOP e a natureza vêm dos XML arquivados. O cofre os lê na primeira vez e guarda; veja `notasPorLer`. " +
					"Das notas recebidas, só entram nos impostos as que já têm o XML completo. IBS e CBS da NFS-e ainda não são lidos.",
				parameters: periodoNaConsulta,
				responses: { "200": resposta("O relatório.", ref("Relatorio")), ...erros(400, 401, 403) },
			},
		},
		"/v1/exportacoes": {
			post: {
				tags,
				summary: "Cria a exportação dos XML de um período",
				description:
					"Reúne os XML das notas emitidas (e os eventos de cancelamento e carta de correção), das inutilizações e das notas recebidas (com eventos e manifestações) em pastas, mais a planilha de resumo. " +
					"O período é pelo dia de emissão da nota; os eventos acompanham a nota, seja qual for a data deles. " +
					"Notas rejeitadas não têm XML fiscal e aparecem só na planilha. " +
					"Na maioria dos casos a resposta já vem `pronta`; com muitas notas ainda não lidas, vem `preparando` e avança a cada `GET`. " +
					"Entregue os links ao navegador do usuário: o arquivo sai direto do cofre.",
				requestBody: corpo(esquema(ExportacaoBase), { ambiente: "producao", de: "2026-11-01", ate: "2026-11-30" }),
				responses: { "201": resposta("Criada.", exportacao), ...erros(400, 401, 403) },
			},
			get: {
				tags,
				summary: "Lista as exportações ainda válidas",
				responses: { "200": resposta("Exportações.", { type: "object", properties: { exportacoes: { type: "array", items: exportacao } } }), ...erros(401) },
			},
		},
		"/v1/exportacoes/{id}": {
			get: {
				tags,
				summary: "Consulta a exportação e devolve links novos",
				description: "Enquanto a situação for `preparando`, cada consulta leva o trabalho adiante. Depois de 24 horas a exportação some e a resposta é 404.",
				parameters: [idDaExportacao],
				responses: { "200": resposta("A exportação.", exportacao), ...erros(401, 404) },
			},
		},
		"/exportacoes/{id}/{arquivo}": {
			get: {
				tags,
				summary: "Baixa um arquivo da exportação pelo link assinado",
				description: "É o endereço que vem em `partes[].url` e em `planilha.url`; não monte este endereço à mão. Não leva chave de API: vale a assinatura, até `linksValemAte`.",
				security: [],
				parameters: [
					idDaExportacao,
					{ name: "arquivo", in: "path", required: true, schema: texto, description: "`parte-1`, `parte-2`... ou `planilha`." },
					{ name: "expira", in: "query", required: true, schema: { type: "integer" } },
					{ name: "assinatura", in: "query", required: true, schema: texto },
				],
				responses: {
					"200": { description: "O arquivo.", content: { "application/zip": {}, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {} } },
					"403": resposta("Link vencido, adulterado ou de exportação que não existe mais (link_invalido).", ref("Erro")),
				},
			},
		},
	};
}

function rotasRecebidas(): Json {
	const tags = ["NF-e recebidas"];
	const nota = ref("NotaRecebida");
	const manifestada = resposta("A nota, com a manifestação registrada agora ou antes (`repetido`).", nota);
	return {
		"/v1/nfe-recebidas": {
			get: {
				tags,
				summary: "Lista as NF-e recebidas, na ordem da sequência de leitura",
				description:
					"Notas que outras empresas emitiram contra o CNPJ do titular, baixadas pelo cofre do Ambiente Nacional. " +
					"Para acompanhar, guarde `ultimaSequencia` e passe em `?depois=`: a mesma nota volta a aparecer quando muda (o XML completo chegou, foi cancelada, foi manifestada). " +
					"Ler esta lista não consulta o governo; quem consulta é o cofre, no ritmo que o Ambiente Nacional permite.",
				parameters: cursorDeLeitura,
				responses: { "200": resposta("Notas.", paginaDe("recebidas", nota)), ...erros(400, 401) },
			},
		},
		"/v1/nfe-recebidas/manifestar": {
			post: {
				tags,
				summary: "Registra a manifestação do destinatário pela chave de acesso",
				description:
					"Serve também para nota que o cofre ainda não recebeu (a chave veio do DANFE em papel, por exemplo). " +
					"Ciência, confirmação e operação não realizada liberam o XML completo; o cofre tenta baixá-lo na mesma chamada. " +
					"A manifestação conclusiva pode ser trocada: vale a última, com até dois registros de cada tipo. Há prazo contado da autorização da nota (10 dias para a ciência; o das conclusivas é o da NT 2020.001 vigente): fora dele o Ambiente Nacional rejeita (cStat 596). " +
					"Em produção é um evento fiscal em nome do destinatário.",
				requestBody: corpo(esquema(ManifestacaoPorChaveInput), { ambiente: "homologacao", chaveAcesso: EXEMPLO_CHAVE_RECEBIDA, tipo: "ciencia" }),
				responses: { "200": manifestada, ...erros(400, 401, 403, 409, 422, 502) },
			},
		},
		"/v1/nfe-recebidas/{id}": {
			get: { tags, summary: "Consulta uma nota recebida, com os eventos", parameters: [idRecebida], responses: { "200": resposta("A nota.", nota), ...erros(401, 404) } },
		},
		"/v1/nfe-recebidas/{id}/xml": {
			get: {
				tags,
				summary: "Baixa o XML completo da nota recebida (nfeProc)",
				description: "Antes da manifestação do destinatário o cofre só tem o resumo e responde 409 xml_indisponivel.",
				parameters: [idRecebida],
				responses: { "200": xml, ...erros(401, 404, 409) },
			},
		},
		"/v1/nfe-recebidas/{id}/danfe": {
			get: {
				tags,
				summary: "DANFE da nota recebida, em PDF",
				description: "Gerado a partir do XML completo, sem logotipo (o do cofre é o do titular, não o do emitente da nota). Nota cancelada sai com a marca de cancelada.",
				parameters: [idRecebida],
				responses: { "200": pdf("O DANFE, em A4."), ...erros(401, 404, 409) },
			},
		},
		"/v1/nfe-recebidas/{id}/manifestar": {
			post: {
				tags,
				summary: "Registra a manifestação do destinatário de uma nota recebida",
				parameters: [idRecebida],
				requestBody: corpo(esquema(ManifestacaoInput), { tipo: "confirmacao" }),
				responses: { "200": manifestada, ...erros(400, 401, 403, 404, 409, 422, 502) },
			},
		},
		"/v1/nfe-recebidas/{id}/manifestacoes/{tipo}/{sequencia}/xml": {
			get: {
				tags,
				summary: "Baixa o XML de uma manifestação registrada pelo cofre (procEventoNFe)",
				parameters: [
					idRecebida,
					{ name: "tipo", in: "path", required: true, schema: { type: "string", enum: ["ciencia", "confirmacao", "desconhecimento", "nao_realizada"] } },
					{ name: "sequencia", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: 2 } },
				],
				responses: { "200": xmlDoEvento, ...erros(401, 404) },
			},
		},
		"/v1/distribuicao": {
			get: {
				tags,
				summary: "Estado da consulta das notas recebidas",
				description: "Uma entrada por CNPJ e ambiente configurados pelo emitente. Lista vazia: as notas recebidas não foram configuradas na tela do cofre.",
				responses: { "200": resposta("Estado.", { type: "object", properties: { distribuicoes: { type: "array", items: ref("Distribuicao") } } }), ...erros(401) },
			},
		},
		"/v1/distribuicao/sincronizar": {
			post: {
				tags,
				summary: "Consulta o Ambiente Nacional agora, se a espera já venceu",
				description:
					"Não é preciso chamar quando a consulta automática está ligada. Dentro da espera exigida pelo Ambiente Nacional a resposta é 200 com `consultou: false`: nada é enviado, e chamar de novo não adianta antes de `proximaConsulta`.",
				requestBody: corpo(esquema(SincronizarInput), { ambiente: "homologacao" }),
				responses: { "200": resposta("O que a consulta trouxe.", ref("Sincronizacao")), ...erros(400, 401, 403, 409, 422) },
			},
		},
		"/v1/distribuicao/consultar-chave": {
			post: {
				tags,
				summary: "Busca uma NF-e pela chave de acesso",
				description:
					"Traz a nota (não os eventos) recebida pelo Ambiente Nacional nos últimos 90 dias em que o CNPJ é destinatário, transportador ou autorizado. " +
					"O destinatário que ainda não se manifestou recebe só o resumo. Limite de 18 consultas por hora.",
				requestBody: corpo(esquema(ConsultarChaveInput), { ambiente: "homologacao", chaveAcesso: EXEMPLO_CHAVE_RECEBIDA }),
				responses: { "200": resposta("A nota.", nota), ...erros(400, 401, 403, 409, 422, 429, 502) },
			},
		},
		"/v1/distribuicao/documentos": {
			get: {
				tags,
				summary: "Tudo o que o Ambiente Nacional entregou, na ordem de chegada",
				description: "Inclui o que não é nota recebida: eventos das notas que o próprio titular emitiu (a manifestação de um cliente, por exemplo) e documentos que o cofre guarda sem interpretar.",
				parameters: cursorDeLeitura,
				responses: { "200": resposta("Documentos.", paginaDe("documentos", ref("DocumentoDistribuido"))), ...erros(400, 401) },
			},
		},
		"/v1/distribuicao/documentos/{sequencia}/xml": {
			get: {
				tags,
				summary: "Baixa o XML de um documento distribuído",
				parameters: [{ name: "sequencia", in: "path", required: true, schema: inteiro }],
				responses: { "200": { description: "O XML, como o Ambiente Nacional entregou.", content: { "application/xml": { schema: texto } } }, ...erros(401, 404) },
			},
		},
	};
}

/** Rotas de NF-e ou de NFC-e: os dois modelos têm o mesmo desenho. */
function rotasNfe(doc: "nfe" | "nfce", nome: string, pedido: string, exemplo: unknown): Json {
	const tags = [nome];
	const base = `/v1/${doc}`;
	const emissao = ref("EmissaoNfe");
	const rotas: Json = {
		[base]: {
			post: {
				tags,
				summary: `Emite uma ${nome}`,
				description: "O cofre reserva o número na série, monta e assina o XML, transmite e arquiva a nota autorizada. A série precisa estar cadastrada no cofre.",
				requestBody: corpo(ref(pedido), exemplo),
				responses: {
					"201": resposta(doc === "nfce" ? "Autorizada, ou emitida em contingência (`situacao`)." : "Autorizada.", emissao),
					"200": resposta("A referência já tinha uma nota: nada foi reenviado.", emissao),
					...erros(400, 401, 403, 409, 422, 502),
				},
			},
			get: {
				tags,
				summary: `Lista as emissões de ${nome}`,
				parameters: filtros,
				responses: { "200": resposta("Emissões, da mais nova para a mais antiga.", { type: "object", properties: { [doc]: { type: "array", items: emissao } } }), ...erros(401) },
			},
		},
		[`${base}/{id}`]: { get: { tags, summary: "Consulta o registro da emissão no cofre", parameters: [id], responses: { "200": resposta("A emissão.", emissao), ...erros(401, 404) } } },
		[`${base}/{id}/consultar`]: {
			post: {
				tags,
				summary: "Consulta a SEFAZ e fecha uma emissão sem resposta conclusiva",
				description: "Para emissões em situação `indefinida`. Numa NFC-e em `contingencia`, tenta transmiti-la agora, sem esperar o agendador do cofre. Nas demais situações devolve o registro como está.",
				parameters: [id],
				responses: { "200": resposta("A emissão, atualizada quando a SEFAZ respondeu.", emissao), ...erros(401, 404, 409) },
			},
		},
		[`${base}/{id}/xml`]: { get: { tags, summary: "Baixa o XML autorizado (nfeProc)", parameters: [id], responses: { "200": xml, ...erros(401, 404) } } },
		[`${base}/{id}/cancelar`]: {
			post: {
				tags,
				summary: `Cancela a ${nome}`,
				description: "Repetir o pedido de uma nota já cancelada devolve 200.",
				parameters: [id],
				requestBody: corpo(ref("CancelamentoNfe"), { justificativa: "Pedido cancelado pelo cliente antes da entrega" }),
				responses: { "200": resposta("Cancelada, agora ou antes (`repetido`).", comRepetido(emissao)), ...erros(400, 401, 403, 404, 409, 422, 502) },
			},
		},
	};
	rotas[`${base}/{id}/cancelamento/xml`] = {
		get: { tags, summary: "Baixa o XML do evento de cancelamento (procEventoNFe)", parameters: [id], responses: { "200": xmlDoEvento, ...erros(401, 404) } },
	};
	if (doc === "nfce") {
		rotas[`${base}/{id}/cupom`] = {
			get: {
				tags,
				summary: "Conteúdo do DANFE NFC-e (cupom) em JSON, para imprimir na bobina",
				description:
					"Montado a partir do XML arquivado, com as divisões e os dizeres obrigatórios do manual do DANFE NFC-e. " +
					"Serve para a nota autorizada e para a nota em contingência; nas demais situações (rejeitada sem XML, em processamento) responde 409 nfe_nao_autorizada.",
				parameters: [
					id,
					{ name: "via", in: "query", schema: { type: "string", enum: ["consumidor", "estabelecimento"], default: "consumidor" }, description: "A via do estabelecimento só existe na nota em contingência; nas demais o cupom sai sempre como via do consumidor." },
				],
				responses: { "200": resposta("O cupom.", ref("Cupom")), ...erros(400, 401, 404, 409) },
			},
		};
		rotas[`${base}/{id}/danfce`] = {
			get: {
				tags,
				summary: "DANFE NFC-e em PDF, na largura da bobina",
				description:
					"O mesmo conteúdo do cupom em JSON, já diagramado, para o caixa que não monta a impressão por conta própria. " +
					"A página tem um ponto do PDF por ponto da impressora térmica (8 por milímetro): 576 de largura na bobina de 80 mm e 384 na de 58 mm, com a altura que o conteúdo pedir. " +
					"Convertido em imagem nessa mesma largura, o QR Code sai com módulos inteiros, em preto puro. Para imprimir pelo driver da impressora, ajuste à largura do papel. " +
					"Leva o logotipo cadastrado no cofre, quando há. O PDF é gerado a cada pedido.",
				parameters: [
					id,
					{ name: "largura", in: "query", schema: { type: "string", enum: ["80", "58"], default: "80" }, description: "Largura da bobina, em milímetros." },
					{ name: "via", in: "query", schema: { type: "string", enum: ["consumidor", "estabelecimento"], default: "consumidor" }, description: "A via do estabelecimento só existe na nota em contingência." },
				],
				responses: { "200": pdf("O DANFE NFC-e."), ...erros(400, 401, 404, 409) },
			},
		};
	}
	if (doc === "nfe") {
		rotas[`${base}/{id}/danfe`] = {
			get: {
				tags,
				summary: "DANFE em PDF (A4)",
				description:
					"Montado a partir do XML arquivado, com os quadros do DANFE: canhoto, emitente, chave de acesso com código de barras, destinatário, fatura e duplicatas, cálculo do imposto, transportador, itens e dados adicionais. " +
					"Os itens que não cabem na primeira folha continuam nas seguintes. A nota cancelada sai com a marca CANCELADA, e a de homologação, com SEM VALOR FISCAL. " +
					"Os totais de IBS, CBS e Imposto Seletivo saem nas informações complementares, porque o leiaute do DANFE ainda não tem campos para eles. " +
					"Leva o logotipo cadastrado no cofre, quando há. O PDF é gerado a cada pedido.",
				parameters: [id],
				responses: { "200": pdf("O DANFE."), ...erros(401, 404, 409) },
			},
		};
	}
	if (doc === "nfe") {
		rotas[`${base}/{id}/carta-correcao/{sequencia}/xml`] = {
			get: {
				tags,
				summary: "Baixa o XML de uma carta de correção (procEventoNFe)",
				parameters: [id, { name: "sequencia", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: 20 }, description: "Número da carta, de 1 até `cartasCorrecao`." }],
				responses: { "200": xmlDoEvento, ...erros(401, 404) },
			},
		};
		rotas[`${base}/{id}/carta-correcao`] = {
			post: {
				tags,
				summary: "Registra uma carta de correção",
				description: "Até 20 por nota. A carta mais recente substitui as anteriores, então o texto deve trazer todas as correções.",
				parameters: [id],
				requestBody: corpo(ref("CartaCorrecao"), { correcao: "Endereço de entrega: Rua das Acácias, 45, sala 2" }),
				responses: { "200": resposta("Registrada.", comRepetido(emissao)), ...erros(400, 401, 403, 404, 409, 422, 502) },
			},
		};
	}
	return rotas;
}

export function contratoOpenApi(): Json {
	const nfse = ref("EmissaoNfse");
	return {
		openapi: "3.1.0",
		info: {
			title: "Cofre NFapi",
			version: VAULT_VERSION,
			description:
				"API de emissão de notas fiscais do cofre NFapi, que roda na conta Cloudflare do emitente. " +
				"Todas as chamadas levam uma chave de API criada na tela /setup do cofre. " +
				"O cofre não calcula imposto: o sistema que chama informa bases, alíquotas e valores; o cofre numera, monta o XML, soma os totais, assina, transmite e arquiva. " +
				"Erros vêm sempre como `{ \"erro\": { \"codigo\", \"mensagem\" } }`.",
			license: { name: "MIT" },
		},
		servers: [{ url: "https://{cofre}", variables: { cofre: { default: "nfapi-cofre.sua-conta.workers.dev", description: "Endereço do seu cofre." } } }],
		security: [{ chaveDeApi: [] }],
		tags: [{ name: "NF-e" }, { name: "NFC-e" }, { name: "NFS-e" }, { name: "NF-e recebidas" }, { name: "Relatórios e exportação" }, { name: "Numeração" }, { name: "Cofre" }],
		paths: {
			...rotasNfe("nfe", "NF-e", "PedidoNfe", EXEMPLO_NFE),
			...rotasNfe("nfce", "NFC-e", "PedidoNfce", EXEMPLO_NFCE),
			...rotasRecebidas(),
			...rotasRelatorios(),
			"/v1/nfse": {
				post: {
					tags: ["NFS-e"],
					summary: "Emite uma NFS-e (Sistema Nacional)",
					requestBody: corpo(ref("PedidoNfse"), EXEMPLO_NFSE),
					responses: { "201": resposta("Autorizada.", nfse), "200": resposta("A referência já tinha uma nota.", nfse), ...erros(400, 401, 403, 409, 422, 502) },
				},
				get: { tags: ["NFS-e"], summary: "Lista as emissões de NFS-e", parameters: filtros, responses: { "200": resposta("Emissões.", { type: "object", properties: { nfse: { type: "array", items: nfse } } }), ...erros(401) } },
			},
			"/v1/nfse/{id}": { get: { tags: ["NFS-e"], summary: "Consulta a emissão", parameters: [id], responses: { "200": resposta("A emissão.", nfse), ...erros(401, 404) } } },
			"/v1/nfse/{id}/xml": { get: { tags: ["NFS-e"], summary: "Baixa o XML da NFS-e", parameters: [id], responses: { "200": xml, ...erros(401, 404) } } },
			"/v1/nfse/{id}/cancelamento/xml": {
				get: { tags: ["NFS-e"], summary: "Baixa o XML do evento de cancelamento", parameters: [id], responses: { "200": xmlDoEvento, ...erros(401, 404) } },
			},
			"/v1/nfse/{id}/cancelar": {
				post: {
					tags: ["NFS-e"],
					summary: "Cancela a NFS-e",
					parameters: [id],
					requestBody: corpo(ref("CancelamentoNfse"), { motivo: "erro_emissao", justificativa: "Nota emitida com o valor incorreto" }),
					responses: { "200": resposta("Cancelada, agora ou antes (`repetido`).", comRepetido(nfse)), ...erros(400, 401, 403, 404, 409, 422, 502) },
				},
			},
			"/v1/inutilizacoes": {
				post: {
					tags: ["Numeração"],
					summary: "Inutiliza uma faixa de numeração de NF-e ou NFC-e",
					description: "Para números que não serão usados (lacunas). A faixa não pode conter nota autorizada ou em andamento neste cofre. Em SP, AC e BA a inutilização foi extinta: o cofre responde 422 inutilizacao_extinta.",
					requestBody: corpo(ref("Inutilizacao"), { modelo: "nfe", ambiente: "homologacao", uf: "RJ", serie: 1, numeroInicial: 15, numeroFinal: 15, justificativa: "Número pulado por falha no sistema anterior" }),
					responses: {
						"201": resposta("Homologada pela SEFAZ.", ref("InutilizacaoRegistrada")),
						"200": resposta("A faixa já estava inutilizada (`repetido`): repetir o pedido é seguro.", ref("InutilizacaoRegistrada")),
						...erros(400, 401, 403, 409, 422, 502),
					},
				},
				get: {
					tags: ["Numeração"],
					summary: "Lista as inutilizações registradas por este cofre",
					description: "Serve para conferir uma inutilização cuja resposta se perdeu. Se a faixa não estiver na lista, repita o POST: o cofre e a SEFAZ reconhecem a faixa já inutilizada.",
					parameters: [
						{ name: "modelo", in: "query", schema: { type: "string", enum: ["nfe", "nfce"] } },
						{ name: "ambiente", in: "query", schema: AMBIENTE },
						{ name: "serie", in: "query", schema: { type: "integer" } },
					],
					responses: { "200": resposta("Inutilizações, da mais nova para a mais antiga.", { type: "object", properties: { inutilizacoes: { type: "array", items: ref("InutilizacaoRegistrada") } } }), ...erros(400, 401) },
				},
			},
			"/v1/inutilizacoes/{id}": {
				get: { tags: ["Numeração"], summary: "Consulta uma inutilização", parameters: [{ ...id, description: "Id da inutilização no cofre." }], responses: { "200": resposta("A inutilização.", ref("InutilizacaoRegistrada")), ...erros(401, 404) } },
			},
			"/v1/inutilizacoes/{id}/xml": {
				get: { tags: ["Numeração"], summary: "Baixa o XML da inutilização (ProcInutNFe)", parameters: [{ ...id, description: "Id da inutilização no cofre." }], responses: { "200": xmlDoEvento, ...erros(401, 404) } },
			},
			"/v1/series": {
				get: {
					tags: ["Numeração"],
					summary: "Séries cadastradas e o próximo número de cada uma",
					description: "As séries são cadastradas pelo emitente na tela do cofre, com o número inicial. O pedido de emissão escolhe a série entre as cadastradas.",
					responses: { "200": resposta("Séries.", { type: "object", properties: { series: { type: "array", items: ref("Serie") } } }), ...erros(401) },
				},
			},
			"/v1/cofre": {
				get: {
					tags: ["Cofre"],
					summary: "Estado do cofre",
					description: "Versão instalada, atualização pendente, validade do certificado e ambientes liberados. Nunca inclui chaves nem segredos.",
					responses: { "200": resposta("Estado.", ref("Cofre")), ...erros(401) },
				},
			},
			"/v1/cofre/logotipo": {
				get: {
					tags: ["Cofre"],
					summary: "Logotipo do emitente",
					description: "A imagem que o emitente cadastrou na tela do cofre, para o sistema do caixa imprimir no cupom. Os PDFs do cofre já a incluem.",
					responses: {
						"200": { description: "A imagem, em PNG ou JPEG.", content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } } } },
						...erros(401, 404),
					},
				},
			},
			"/v1/sefaz/status": {
				get: {
					tags: ["Cofre"],
					summary: "Status do serviço de autorização da SEFAZ",
					parameters: [
						{ name: "uf", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 2 } },
						{ name: "modelo", in: "query", schema: { type: "string", enum: ["nfe", "nfce"], default: "nfe" } },
						{ name: "ambiente", in: "query", schema: { ...AMBIENTE, default: "homologacao" } },
					],
					responses: { "200": resposta("Status.", ref("StatusSefaz")), ...erros(400, 401, 403, 409, 422) },
				},
			},
			"/v1/openapi.json": { get: { tags: ["Cofre"], summary: "Este contrato", security: [], responses: { "200": resposta("OpenAPI 3.1.") } } },
		},
		components: {
			securitySchemes: { chaveDeApi: { type: "http", scheme: "bearer", description: "Chave de API do cofre: `Authorization: Bearer nfapi_...`." } },
			schemas: {
				Erro: {
					type: "object",
					properties: {
						erro: {
							type: "object",
							properties: {
								codigo: {
									type: "string",
									description: "Código estável do erro; a tabela está em `x-codigos`. Novos códigos podem surgir em versões novas: trate um código desconhecido pelo status HTTP.",
									"x-codigos": CODIGOS_DE_ERRO,
								},
								mensagem: texto,
							},
							required: ["codigo", "mensagem"],
						},
						campo: { ...textoOuNulo, description: "Em erros de validação da NF-e e NFC-e: o campo recusado." },
						nfe: ref("EmissaoNfe"),
						nfce: ref("EmissaoNfe"),
						nfse: ref("EmissaoNfse"),
						mensagens,
					},
					required: ["erro"],
				},
				Cabecalho,
				PedidoNfe: { allOf: [ref("Cabecalho"), esquema(NfeInput)] },
				OpcoesNfce,
				PedidoNfce: { allOf: [ref("Cabecalho"), ref("OpcoesNfce"), esquema(NfceInput)] },
				PedidoNfse: { allOf: [ref("Cabecalho"), esquema(NfseInput)] },
				CancelamentoNfe: esquema(CancelamentoNfe),
				CancelamentoNfse: esquema(CancelamentoInput),
				CartaCorrecao: esquema(CartaCorrecao),
				Inutilizacao: esquema(InutilizacaoInput),
				EmissaoNfe,
				EmissaoNfse,
				Cupom,
				LinhaDoCupom,
				NotaRecebida,
				ManifestacaoRegistrada,
				DocumentoDistribuido,
				Distribuicao,
				Sincronizacao,
				NotaEmitida,
				ValoresFiscais,
				Relatorio,
				Exportacao,
				InutilizacaoRegistrada: {
					type: "object",
					properties: {
						id: texto,
						modelo: texto,
						ambiente: AMBIENTE,
						serie: { type: "integer" },
						numeroInicial: { type: "integer" },
						numeroFinal: { type: "integer" },
						protocolo: { ...textoOuNulo, description: "Nulo quando a SEFAZ só confirmou que a faixa já estava inutilizada." },
						justificativa: texto,
						xmlDisponivel: { type: "boolean" },
						criadaEm: dataHora,
						repetido: { type: "boolean", description: "Só na resposta do POST: a faixa já estava inutilizada." },
					},
				},
				Serie: {
					type: "object",
					properties: {
						modelo: { type: "string", enum: ["nfe", "nfce"] },
						ambiente: AMBIENTE,
						serie: { type: "integer" },
						proximoNumero: { type: "integer", description: "Número que a próxima nota da série vai receber." },
						descricao: textoOuNulo,
						cnpj: texto,
					},
				},
				Cofre: {
					type: "object",
					properties: {
						versao: texto,
						atualizacao: { type: "object", properties: { versaoPublicada: textoOuNulo, pendente: { type: "boolean" } } },
						certificado: {
							type: ["object", "null"],
							properties: {
								titular: texto,
								documento: { type: "object", properties: { kind: { type: "string", enum: ["cnpj", "cpf"] }, id: texto } },
								validoAte: dataHora,
								diasRestantes: { type: "integer" },
							},
						},
						producaoLiberada: { type: "boolean" },
						contingencia: {
							type: "object",
							properties: { notasPendentes: { type: "integer", description: "NFC-e emitidas em contingência que ainda aguardam a transmissão à SEFAZ." } },
						},
						logotipo: { type: "boolean", description: "Há logotipo cadastrado no cofre. A imagem sai em GET /v1/cofre/logotipo." },
						chave: { type: "object", properties: { escopo: { type: "string", enum: ["completo", "homologacao"] }, ambientes: { type: "array", items: AMBIENTE } } },
						documentos: {
							type: "object",
							description: "O que este cofre emite e, para NF-e e NFC-e, em quais UFs.",
							properties: {
								nfse: { type: "boolean" },
								nfe: { type: "object", properties: { ufs: { type: "array", items: texto } } },
								nfce: { type: "object", properties: { ufs: { type: "array", items: texto } } },
							},
						},
					},
				},
				StatusSefaz: {
					type: "object",
					properties: {
						modelo: texto,
						uf: texto,
						ambiente: AMBIENTE,
						autorizador: texto,
						emOperacao: { type: "boolean" },
						mensagem: { type: "object", properties: { codigo: texto, descricao: texto } },
						tempoMedioSegundos: { type: ["number", "null"] },
					},
				},
			},
		},
	};
}
