-- O cofre passa a ser a API de emissão: os sistemas do emitente (ERP, loja,
-- Wabotia etc.) chamam o cofre direto, com uma chave de API criada na tela /setup.

-- Chaves de API. Só o hash SHA-256 é gravado; a chave aparece uma única vez.
CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	prefix TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	-- completo | homologacao (chave de teste: nunca emite em produção)
	scope TEXT NOT NULL DEFAULT 'completo',
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
);

-- Emissões de documentos fiscais: metadados, numeração e idempotência.
CREATE TABLE emissions (
	id TEXT PRIMARY KEY,
	-- CNPJ/CPF do titular do certificado no momento da emissão.
	doc_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	environment TEXT NOT NULL,
	reference TEXT,
	serie TEXT NOT NULL,
	number INTEGER NOT NULL,
	document_id TEXT NOT NULL,
	-- processando | autorizada | rejeitada | erro | indefinida | cancelada
	status TEXT NOT NULL,
	access_key TEXT,
	fiscal_number TEXT,
	messages TEXT NOT NULL DEFAULT '[]',
	document_key TEXT,
	journal_key TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX emissions_reference
	ON emissions (doc_id, kind, environment, reference)
	WHERE reference IS NOT NULL;
CREATE UNIQUE INDEX emissions_number ON emissions (doc_id, kind, environment, serie, number);
CREATE INDEX emissions_created ON emissions (created_at DESC);
CREATE INDEX emissions_access_key ON emissions (access_key);

-- Último número usado em cada série.
CREATE TABLE series (
	doc_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	environment TEXT NOT NULL,
	serie TEXT NOT NULL,
	last_number INTEGER NOT NULL,
	PRIMARY KEY (doc_id, kind, environment, serie)
);
