-- Distribuição de DF-e (NT 2014.002): as notas que outras empresas emitiram
-- contra o CNPJ do titular, baixadas do Ambiente Nacional, e a manifestação do
-- destinatário (NT 2020.001).

-- Onde a consulta parou, por CNPJ e ambiente. O Ambiente Nacional bloqueia quem
-- consulta fora da sequência ou antes da hora: o cofre é o único dono do NSU.
CREATE TABLE dfe_cursores (
	doc_id TEXT NOT NULL,
	environment TEXT NOT NULL,
	-- UF do interessado (sigla), informada na consulta.
	uf TEXT NOT NULL,
	-- 1: o agendador consulta sozinho.
	auto INTEGER NOT NULL DEFAULT 0,
	-- 1: o agendador registra a ciência da operação das notas novas.
	auto_ciencia INTEGER NOT NULL DEFAULT 0,
	ult_nsu INTEGER NOT NULL DEFAULT 0,
	max_nsu INTEGER NOT NULL DEFAULT 0,
	-- Nenhuma consulta sai antes deste instante.
	next_at INTEGER NOT NULL DEFAULT 0,
	last_at INTEGER,
	last_code TEXT,
	last_message TEXT,
	-- Instantes das consultas pontuais (por chave) da última hora: o limite é de 20.
	pontuais TEXT NOT NULL DEFAULT '[]',
	PRIMARY KEY (doc_id, environment)
);

-- Tudo o que o Ambiente Nacional entregou, na ordem em que chegou.
CREATE TABLE dfe_documentos (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	doc_id TEXT NOT NULL,
	environment TEXT NOT NULL,
	nsu INTEGER,
	-- Nome do schema informado pelo Ambiente Nacional (ex.: resNFe_v1.01.xsd).
	schema TEXT NOT NULL,
	-- resumo_nfe | nfe | resumo_evento | evento | outro
	kind TEXT NOT NULL,
	access_key TEXT,
	event_type TEXT,
	event_seq INTEGER,
	-- Descrição, data e protocolo do evento; vazio nos demais documentos.
	detail TEXT NOT NULL DEFAULT '{}',
	document_key TEXT NOT NULL,
	received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX dfe_documentos_nsu ON dfe_documentos (doc_id, environment, nsu) WHERE nsu IS NOT NULL;
CREATE INDEX dfe_documentos_chave ON dfe_documentos (environment, access_key);

-- NF-e recebidas: uma linha por chave de acesso, montada a partir dos documentos.
CREATE TABLE recebidas (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL,
	environment TEXT NOT NULL,
	access_key TEXT NOT NULL,
	-- Cresce a cada mudança da nota: é o cursor de leitura dos sistemas clientes.
	seq INTEGER NOT NULL,
	-- destinatario | terceiro (transportador ou autorizado a baixar o XML)
	role TEXT NOT NULL DEFAULT 'destinatario',
	emit_doc TEXT,
	emit_name TEXT,
	emit_ie TEXT,
	issued_at TEXT,
	-- entrada | saida
	operation TEXT,
	value REAL,
	-- autorizada | cancelada | denegada; vazio enquanto o cofre só conhece a chave.
	situation TEXT,
	protocol TEXT,
	authorized_at TEXT,
	summary_key TEXT,
	xml_key TEXT,
	-- Manifestações registradas (lista) e outros dados da nota.
	extra TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX recebidas_chave ON recebidas (environment, access_key);
CREATE INDEX recebidas_seq ON recebidas (seq);
