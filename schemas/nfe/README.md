# Schemas da NF-e e NFC-e (leiaute 4.00)

XSD oficiais, baixados do [Portal Nacional da NF-e](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=) em 16/11/2026. Os testes em `test-node/nfe.test.ts` validam contra eles cada XML que o cofre gera.

O portal publica pacotes incrementais: nenhum zip tem o conjunto completo. Os arquivos aqui vêm de cinco pacotes, guardados como chegaram em `origem/`:

| Pacote | O que foi usado |
|---|---|
| `PL_010h_v1.03.zip` (13/11/2026) | `nfe/`: leiaute da NF-e, tipos básicos e assinatura. É o mais novo, já com IBS/CBS e CNPJ alfanumérico. |
| `PL_010d_v1.03.zip` (10/07/2026) | `evento/`: envelope de eventos. `nfe/`: consulta de protocolo e leiaute da inutilização. |
| `PL_009_V4_00_NT_2020_006_v1.20.zip` | `nfe/`: envelopes que os pacotes novos não repetem (enviNFe, inutNFe, consReciNFe, consStatServ, procNFe). |
| `Evento_Canc_PL_v1.01_NT_2018_004.zip` | `evento/`: conteúdo do evento de cancelamento (e110111). |
| `Evento_CCe_PL_v1.01.zip` | `evento/`: conteúdo da carta de correção (e110110). |

O `evento/e110112_v1.00.xsd` (cancelamento por substituição, NT 2018.004) não está em nenhum desses cinco pacotes: veio da cópia consolidada dos schemas oficiais mantida pelo projeto [sped-nfe](https://github.com/nfephp-org/sped-nfe/tree/master/schemes/PL_010g). Vale trocá-lo pelo arquivo do portal quando o pacote que o contém for localizado.

Do pacote da carta de correção ficou só o `e110110_v1.00.xsd`: os envelopes daquele pacote (`envCCe`, `leiauteCCe`) redefinem um tipo que os tipos básicos atuais já trazem e não carregam junto com eles. O envelope é validado pelo `envEvento_v1.00.xsd` genérico.

Ao atualizar, substitua os arquivos pelos do pacote novo e rode `pnpm test`: uma tag fora de ordem ou um campo novo obrigatório aparece como falha de validação.
