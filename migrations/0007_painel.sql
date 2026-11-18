-- Painel do emitente: a listagem das notas emitidas passa a filtrar por
-- período, situação e destinatário direto na tabela de emissões.

-- Data e hora de emissão (ISO 8601) e o dia no horário de Brasília (AAAA-MM-DD),
-- que é por onde o painel e os relatórios filtram o período.
ALTER TABLE emissions ADD COLUMN issued_at TEXT;
ALTER TABLE emissions ADD COLUMN issued_day TEXT;
ALTER TABLE emissions ADD COLUMN value REAL;
-- Destinatário (NF-e, NFC-e) ou tomador (NFS-e).
ALTER TABLE emissions ADD COLUMN recipient_doc TEXT;
ALTER TABLE emissions ADD COLUMN recipient_name TEXT;
-- 0: os dados acima ainda não foram conferidos no XML arquivado. As emissões
-- anteriores a esta versão ficam assim, e o cofre as completa aos poucos.
ALTER TABLE emissions ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0;

-- NF-e e NFC-e já guardavam a data e o valor nos dados da emissão.
UPDATE emissions
	SET issued_at = json_extract(extra, '$.emitidaEm'), value = json_extract(extra, '$.valor')
	WHERE kind IN ('nfe', 'nfce');
-- A NFS-e guardava no registro do arquivo.
UPDATE emissions
	SET issued_at = (SELECT json_extract(d.meta, '$.emitidaEm') FROM documents d WHERE d.key = emissions.document_key),
	    value = (SELECT json_extract(d.meta, '$.valor') FROM documents d WHERE d.key = emissions.document_key)
	WHERE kind = 'nfse' AND document_key IS NOT NULL;
-- A data com fuso (NF-e, NFC-e) já está no horário local; as demais valem pelo horário de Brasília.
UPDATE emissions
	SET issued_day = CASE
		WHEN issued_at IS NOT NULL AND issued_at NOT LIKE '%Z' THEN substr(issued_at, 1, 10)
		WHEN issued_at IS NOT NULL THEN date(issued_at, '-3 hours')
		ELSE date(created_at / 1000, 'unixepoch', '-3 hours')
	END;

CREATE INDEX emissions_issued_day ON emissions (issued_day);
