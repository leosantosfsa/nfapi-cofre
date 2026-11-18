-- O cofre deixou de depender de uma API central: o pareamento por HMAC e a
-- proteção contra repetição das requisições dela não são mais usados.
DROP TABLE IF EXISTS pairing;
DROP TABLE IF EXISTS nonces;
