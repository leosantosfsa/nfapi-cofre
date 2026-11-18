# Schemas da NFS-e Nacional

Pacotes XSD oficiais do Sistema Nacional NFS-e, usados para validar no CI todo
XML que a API gera (DPS e pedidos de registro de evento).

Origem: <https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica>

| Pasta | Pacote oficial | Ambiente |
|---|---|---|
| `producao/` | `NFSe-ESQUEMAS_XSD-v1.01-20260209` | Produção |
| `producao-restrita/` | `NFSe-ESQUEMAS_XSD-PRODREST-v1.01-20261020` (leiaute da NT 009) | Produção restrita (testes) |

Os arquivos `.zip` originais ficam em `origem/`, sem alteração, para permitir
conferir de onde veio cada schema. O portal gov.br recusa downloads
automatizados (HTTP 403), então a atualização é manual: baixar o pacote novo,
salvar em `origem/` e extrair na pasta do ambiente.
