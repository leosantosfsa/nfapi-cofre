-- Relatórios e exportação por período.

-- Resumo fiscal de cada nota (natureza, CFOP e totais de impostos), lido do XML
-- arquivado na primeira vez em que um relatório ou uma exportação precisa dele.
-- Nulo: ainda não lido. '{}': o XML não está no cofre ou não pôde ser lido.
ALTER TABLE emissions ADD COLUMN fiscal TEXT;
ALTER TABLE recebidas ADD COLUMN fiscal TEXT;

-- Exportação de XML por período: a lista dos arquivos e as planilhas ficam no
-- R2; o ZIP é montado na hora do download, em partes.
CREATE TABLE exportacoes (
	id TEXT PRIMARY KEY,
	environment TEXT NOT NULL,
	-- Período, pelos dias de emissão (AAAA-MM-DD), inclusive.
	first_day TEXT NOT NULL,
	last_day TEXT NOT NULL,
	-- O que entra (lista JSON): nfse, nfe, nfce, eventos, inutilizacoes, recebidas.
	include TEXT NOT NULL,
	-- preparando | pronta
	status TEXT NOT NULL,
	files INTEGER NOT NULL DEFAULT 0,
	parts INTEGER NOT NULL DEFAULT 0,
	-- Contagem do que entrou, por tipo.
	summary TEXT NOT NULL DEFAULT '{}',
	actor TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX exportacoes_expires ON exportacoes (expires_at);
