-- NFS-e arquivadas no cofre sem registro de emissão. Antes de o cofre ser a API
-- de emissão (versão 0.2.0), a nota era emitida por fora e o cofre guardava só
-- os arquivos, com os dados da nota nos metadados. O painel lista as emissões,
-- então essas notas deixaram de aparecer. Aqui cada uma ganha o seu registro.

-- A chave de acesso da NFS-e (50 dígitos) traz o município (7), o ambiente
-- gerador (1), o tipo de inscrição (1: CPF, 2: CNPJ) e a inscrição (14), que
-- também formam o identificador da DPS. A nota com evento de cancelamento
-- arquivado entra como cancelada. O tomador é lido depois, do XML.
INSERT OR IGNORE INTO emissions (id, doc_id, kind, environment, serie, number, document_id, status, access_key, fiscal_number,
	messages, document_key, created_at, updated_at, extra, issued_at, issued_day, value, summarized)
SELECT
	'nfs_' || lower(hex(randomblob(10))),
	CASE WHEN substr(n.chave, 9, 1) = '1' THEN substr(n.chave, 13, 11) ELSE substr(n.chave, 10, 14) END,
	'nfse',
	n.ambiente,
	n.serie,
	n.numero,
	'DPS' || substr(n.chave, 1, 7) || substr(n.chave, 9, 15) || substr('00000' || n.serie, -5) || printf('%015d', n.numero),
	CASE WHEN EXISTS (
		SELECT 1 FROM documents c
		WHERE c.key LIKE 'nfse/%' AND json_extract(c.meta, '$.tipo') = 'cancelamento' AND json_extract(c.meta, '$.chaveAcesso') = n.chave
	) THEN 'cancelada' ELSE 'autorizada' END,
	n.chave,
	n.numero_nfse,
	'[]',
	n.key,
	n.created_at,
	n.created_at,
	'{}',
	n.emitida_em,
	CASE
		WHEN n.emitida_em IS NOT NULL THEN date(n.emitida_em, '-3 hours')
		ELSE date(n.created_at / 1000, 'unixepoch', '-3 hours')
	END,
	n.valor,
	0
FROM (
	SELECT d.key, d.created_at,
		json_extract(d.meta, '$.chaveAcesso') AS chave,
		COALESCE(json_extract(d.meta, '$.ambiente'), substr(d.key, 6, instr(substr(d.key, 6), '/') - 1)) AS ambiente,
		CAST(json_extract(d.meta, '$.serie') AS TEXT) AS serie,
		json_extract(d.meta, '$.numeroDps') AS numero,
		CAST(json_extract(d.meta, '$.numeroNfse') AS TEXT) AS numero_nfse,
		json_extract(d.meta, '$.emitidaEm') AS emitida_em,
		json_extract(d.meta, '$.valor') AS valor
	FROM documents d
	WHERE d.key LIKE 'nfse/%' AND json_extract(d.meta, '$.tipo') = 'nfse'
) n
WHERE length(n.chave) = 50 AND n.ambiente IN ('producao', 'homologacao') AND n.serie IS NOT NULL AND typeof(n.numero) = 'integer'
	AND NOT EXISTS (SELECT 1 FROM emissions e WHERE e.access_key = n.chave);

-- A série passa a conhecer os números já usados, para o cofre não repetir uma DPS.
INSERT INTO series (doc_id, kind, environment, serie, last_number)
SELECT doc_id, kind, environment, serie, MAX(number) FROM emissions WHERE kind = 'nfse' GROUP BY doc_id, kind, environment, serie
ON CONFLICT (doc_id, kind, environment, serie) DO UPDATE SET last_number = MAX(last_number, excluded.last_number);
