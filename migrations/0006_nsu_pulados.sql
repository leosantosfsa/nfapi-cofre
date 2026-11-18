-- Quando outro sistema consulta o mesmo CNPJ na frente do cofre, o Ambiente
-- Nacional recusa a consulta (656) e devolve o NSU em que esse sistema parou. O
-- cofre segue desse número e guarda aqui o intervalo que ficou para trás, para
-- buscar cada documento dele pelo NSU (consNSU).
-- Lista de intervalos [de, até], inclusivos, em ordem crescente.
ALTER TABLE dfe_cursores ADD COLUMN lacunas TEXT NOT NULL DEFAULT '[]';
