-- NF-e (modelo 55) e NFC-e (modelo 65): séries cadastradas com número inicial,
-- idempotência por conteúdo e os dados da autorização.

-- Hash do pedido: a mesma referência com conteúdo diferente é recusada.
ALTER TABLE emissions ADD COLUMN request_hash TEXT;
-- Protocolo de autorização (nProt).
ALTER TABLE emissions ADD COLUMN protocol TEXT;
-- Dados que variam por documento (valor, QR Code da NFC-e, sequência de eventos).
ALTER TABLE emissions ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';

-- Um número só fica preso enquanto a emissão não foi recusada: nota rejeitada
-- não existe para o governo, e o número pode ser usado de novo.
DROP INDEX emissions_number;
CREATE UNIQUE INDEX emissions_number
	ON emissions (doc_id, kind, environment, serie, number)
	WHERE status NOT IN ('rejeitada', 'erro');

-- Séries: NF-e e NFC-e só emitem em séries cadastradas pelo emitente.
ALTER TABLE series ADD COLUMN label TEXT;
ALTER TABLE series ADD COLUMN created_at INTEGER;

-- Faixas de numeração inutilizadas na SEFAZ.
CREATE TABLE inutilizacoes (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	environment TEXT NOT NULL,
	serie TEXT NOT NULL,
	first_number INTEGER NOT NULL,
	last_number INTEGER NOT NULL,
	protocol TEXT,
	justification TEXT NOT NULL,
	document_key TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX inutilizacoes_serie ON inutilizacoes (doc_id, kind, environment, serie);
