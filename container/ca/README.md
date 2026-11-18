# Cadeia ICP-Brasil

Raízes adicionais em que o proxy mTLS confia, além das raízes públicas do Node.
As SEFAZ estaduais usam certificados de servidor emitidos sob a ICP-Brasil, que
não estão nos repositórios públicos (Mozilla/Node).

| Arquivo | Titular | Validade | SHA-256 |
|---|---|---|---|
| `icp-brasil-raiz-v10.pem` | Autoridade Certificadora Raiz Brasileira v10 | até 01/07/2032 | `6E:0B:FF:06:9A:26:99:4C:15:DE:2C:48:88:CC:54:AF:84:88:2E:54:95:B7:FB:F6:6B:E9:CC:FF:EC:74:89:F6` |

Origem: exportado do repositório de raízes confiáveis do Windows (programa de
raízes da Microsoft). Confira a impressão digital com a publicada pelo ITI no
repositório oficial da AC Raiz antes de confiar nela:

```bash
openssl x509 -in icp-brasil-raiz-v10.pem -noout -fingerprint -sha256
```

Só entram aqui certificados **raiz**. Os intermediários são enviados pelo
próprio servidor durante a conexão.
