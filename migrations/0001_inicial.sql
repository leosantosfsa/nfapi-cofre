-- Certificado A1 do emitente. O conteúdo (chave privada + certificado) fica
-- cifrado em AES-GCM com chave derivada do VAULT_SECRET; os demais campos são
-- só metadados para exibição.
CREATE TABLE certificate (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	ciphertext TEXT NOT NULL,
	iv TEXT NOT NULL,
	holder_kind TEXT NOT NULL,
	holder_id TEXT NOT NULL,
	common_name TEXT NOT NULL,
	issuer TEXT NOT NULL,
	serial_number TEXT NOT NULL,
	not_before INTEGER NOT NULL,
	not_after INTEGER NOT NULL,
	installed_at INTEGER NOT NULL
);

-- Pareamentos com a API central. A chave HMAC não é gravada: é derivada do
-- VAULT_SECRET + id, então apagar/revogar a linha invalida a chave.
CREATE TABLE pairing (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
);

-- Proteção contra repetição de requisições assinadas.
CREATE TABLE nonces (
	nonce TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
);
CREATE INDEX nonces_expires_at ON nonces (expires_at);

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- Trilha de auditoria: o que foi pedido ao cofre, por quem e com que resultado.
-- Nunca guarda conteúdo de documentos nem material de chave.
CREATE TABLE audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	action TEXT NOT NULL,
	actor TEXT NOT NULL,
	outcome TEXT NOT NULL,
	detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_at ON audit (at DESC);

-- Índice dos objetos gravados no R2.
CREATE TABLE documents (
	key TEXT PRIMARY KEY,
	content_type TEXT NOT NULL,
	size INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	meta TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL
);
CREATE INDEX documents_created_at ON documents (created_at DESC);
