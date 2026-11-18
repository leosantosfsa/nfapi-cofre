# Cofre NFapi

O cofre é o emissor de notas fiscais do [NFapi](https://github.com/Quevenapp/nfapi). Ele roda na **sua** conta Cloudflare: guarda o certificado digital A1, expõe a API que os seus sistemas chamam para emitir, monta e assina os documentos, fala com o governo (SEFAZ e NFS-e Nacional) e arquiva os XML. Não há serviço intermediário.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/nfapi/tree/main/vault)

## O que é criado na sua conta

| Recurso | Para quê |
|---|---|
| Worker `nfapi-cofre` | A API de emissão (`/v1/...`) e o painel do emitente (`/setup`) |
| Container | Conexão mTLS com o governo (os servidores das SEFAZ usam certificados ICP-Brasil, que o Workers sozinho não aceita) |
| Banco D1 `nfapi-cofre` | Certificado cifrado, chaves de API, emissões, numeração, auditoria e índice dos documentos |
| Bucket R2 `nfapi-cofre-docs` | XML autorizados, eventos e o diário de transmissões |

O Container exige o plano **Workers Paid** (US$ 5/mês) na sua conta Cloudflare.

## Instalação

O passo a passo completo, com gerador do segredo, está em **<https://nfapi.queven.app/instalar>**. Em resumo:

1. Gere o segredo do cofre (`VAULT_SECRET`) na página acima, ou com o comando abaixo, e guarde-o em local seguro:

   ```bash
   openssl rand -hex 32
   ```

   Ele cifra o certificado e é a senha do painel. Se for perdido, será preciso reinstalar o certificado.
2. Clique em **Deploy to Cloudflare**. No campo `VAULT_SECRET`, apague o que o navegador tiver preenchido sozinho e cole o segredo. Deixe **Proteger com Cloudflare Access** desligado.
3. Abra `https://<seu-cofre>/setup`, entre com o segredo e:
   - em **Configuração**, envie o arquivo `.pfx` do certificado A1 e a senha dele, rode o **teste de conexão** (consulta os serviços de homologação) e, para NF-e e NFC-e, cadastre as **séries** (com o número da próxima nota);
   - em **Chaves de API**, crie uma chave para cada sistema que vai emitir;
   - em **Atualização**, configure o **gatilho de atualização** (veja abaixo); enquanto ele faltar, a Visão geral avisa.

A produção começa **bloqueada**: o cofre só emite em homologação até você liberar no painel.

## Painel

O painel (`/setup`) é a tela de trabalho do emitente, além de ser onde o cofre é configurado:

- **Visão geral.** As notas do período por documento e situação, o valor autorizado por dia, as notas recebidas e a lista do que precisa de atenção: certificado perto de vencer, notas sem resposta, NFC-e em contingência, consulta bloqueada, versão nova.
- **Notas emitidas.** Listagem com filtro por período, documento, situação e ambiente, e busca por número, chave de acesso, referência, nome ou documento do destinatário. Cada nota abre com os dados, as mensagens do governo, os arquivos (XML, eventos, DANFE em PDF) e o cancelamento.
- **Relatórios e exportação.** Os totais do período com os impostos, por CFOP, natureza, destinatário e fornecedor, e o botão que gera o ZIP dos XML com a planilha para o contador.
- **Notas recebidas.** O estado da consulta ao Ambiente Nacional, a listagem com os mesmos filtros e, em cada nota, os eventos, o histórico de manifestações, os arquivos e a manifestação do destinatário.
- **Configuração, Chaves de API, Atualização e Atividade.** O que antes ficava na tela única.

As notas emitidas antes da versão 0.10.0 não tinham o destinatário gravado para a busca; o cofre o lê dos XML arquivados, aos poucos, quando o painel é aberto.

## API

Todas as chamadas levam a chave de API em `Authorization: Bearer nfapi_...`.

O contrato completo (OpenAPI 3.1), com todos os campos e exemplos, está em [`docs/openapi.json`](docs/openapi.json) e é servido pelo próprio cofre em `GET /v1/openapi.json`, sempre na versão instalada.

Os três documentos têm o mesmo desenho; `{doc}` é `nfse`, `nfe` (modelo 55) ou `nfce` (modelo 65):

| Rota | O que faz |
|---|---|
| `POST /v1/{doc}` | Emite |
| `GET /v1/{doc}` | Lista as emissões (`?referencia=` pesquisa pela referência do seu sistema) |
| `GET /v1/{doc}/:id` | Consulta uma emissão |
| `GET /v1/{doc}/:id/xml` | Baixa o XML autorizado |
| `POST /v1/{doc}/:id/cancelar` | Cancela |
| `POST /v1/{doc}/:id/consultar` | NF-e e NFC-e: consulta a SEFAZ e fecha uma emissão que ficou sem resposta |
| `POST /v1/nfe/:id/carta-correcao` | NF-e: registra uma carta de correção |
| `GET /v1/nfe/:id/danfe` | NF-e: DANFE em PDF (A4) |
| `GET /v1/nfce/:id/cupom` | NFC-e: conteúdo do DANFE NFC-e em JSON, para imprimir na bobina |
| `GET /v1/nfce/:id/danfce` | NFC-e: DANFE NFC-e em PDF, na largura da bobina (`?largura=80` ou `58`) |
| `GET /v1/cofre/logotipo` | Logotipo cadastrado no cofre, para o sistema do caixa imprimir no cupom |
| `GET /v1/nfe-recebidas` | Notas que outras empresas emitiram contra o CNPJ do titular (`?depois=` lê só o que mudou) |
| `POST /v1/nfe-recebidas/:id/manifestar` | Manifestação do destinatário: ciência, confirmação, desconhecimento ou operação não realizada |
| `GET /v1/nfe-recebidas/:id/xml` e `/danfe` | XML completo e DANFE da nota recebida, depois da manifestação |
| `GET /v1/distribuicao` | Onde a consulta das notas recebidas parou e quando sai a próxima |
| `GET /v1/notas` | Notas emitidas dos três documentos, com filtro por período, documento, situação e busca |
| `GET /v1/relatorios/notas` | Totais de um período: por situação, dia, CFOP, natureza e destinatário, com os impostos |
| `POST /v1/exportacoes` | Exporta os XML de um período num ZIP, com planilha de resumo, por link que expira |
| `POST /v1/inutilizacoes` | NF-e e NFC-e: inutiliza uma faixa de numeração (extinta em SP, AC e BA) |
| `GET /v1/series` | Séries cadastradas e o próximo número de cada uma |
| `GET /v1/cofre` | Versão, atualização pendente, validade do certificado e ambientes liberados |
| `GET /v1/sefaz/status` | Status do serviço de autorização da UF |

### NF-e e NFC-e

- **O cofre não calcula imposto.** O seu sistema informa bases, alíquotas e valores de cada item; o cofre numera, monta o XML, soma os totais, assina, transmite e arquiva a nota com o protocolo.
- **Séries cadastradas.** A NF-e e a NFC-e só são emitidas em séries cadastradas no painel do cofre, onde se informa o número da próxima nota (para quem já emitia por outro sistema). O pedido escolhe a série; na NFC-e, o usual é uma série por caixa.
- **Sem lacunas por rejeição.** Nota rejeitada não existe para a SEFAZ: o número volta para a série.
- **UFs atendidas.** NF-e: SP e as UFs autorizadas pela SVRS (AC, AL, AP, CE, DF, ES, PA, PB, PI, RJ, RN, RO, RR, SC, SE, TO). NFC-e: SP. `GET /v1/cofre` devolve a lista da versão instalada.
- **Reforma tributária.** O grupo de IBS e CBS (`impostos.ibsCbs`) já é exigido do regime normal em homologação; o cofre o repassa como informado e soma os totais. Cobre alíquota reduzida, diferimento, devolução de tributo, tributação regular, compras governamentais, IBS e CBS do Simples Nacional, estorno de crédito e crédito presumido, além do Imposto Seletivo (`impostos.impostoSeletivo`). Ainda fora: regime monofásico (combustíveis), transferência de crédito, ajuste de competência e crédito presumido da Zona Franca de Manaus. O valor da nota (`vNF`) ainda não inclui IBS, CBS nem Imposto Seletivo.
- **Exportação e importação.** Na exportação, o destinatário vai com `idEstrangeiro` e endereço no exterior (`uf: "EX"`, `codigoMunicipio: "9999999"`, `codigoPais`), a nota leva `exportacao` (UF e local de embarque) e o item pode levar `exportacao` (drawback e exportação indireta). Na importação, o item leva `importacao` (a declaração de importação com as adições) e `impostos.ii`.
- **Cupom da NFC-e.** `GET /v1/nfce/:id/cupom` devolve o conteúdo do DANFE NFC-e já organizado: as divisões na ordem do manual oficial, os dizeres obrigatórios, os itens em campos, os totais e pagamentos como pares de rótulo e valor, a chave de acesso e o texto do QR Code. O sistema do caixa transforma isso na impressão da bobina (58 ou 80 mm); o cofre não conhece impressora.
- **DANFE e DANFE NFC-e em PDF.** O cofre gera os dois a partir do XML arquivado, a cada pedido, sem guardar o PDF. O DANFE da NF-e sai em A4, com canhoto, código de barras da chave, duplicatas, transportador e folhas de continuação quando os itens não cabem; a nota cancelada leva a marca CANCELADA e a de homologação, SEM VALOR FISCAL. O DANFE NFC-e sai na largura da bobina, com um ponto do PDF por ponto da impressora térmica (576 de largura para 80 mm, 384 para 58 mm): convertido em imagem nessa largura, o QR Code fica com módulos inteiros. Os totais de IBS, CBS e Imposto Seletivo saem nas informações complementares do DANFE, porque o leiaute oficial ainda não tem campos para eles.
- **Logotipo.** O emitente envia a imagem (PNG ou JPEG, até 300 KB) no painel do cofre; ela entra nos dois PDFs e fica disponível em `GET /v1/cofre/logotipo`.
- **Ainda não há:** impressão da carta de correção, contingência da NF-e (SVC) e, do emitente, eventos além de cancelamento e carta de correção.

### Contingência da NFC-e

Cobre o caso em que a SEFAZ não responde e a loja continua com internet. O certificado segue só no cofre: se a loja ficar sem internet, o caixa não alcança o cofre e não há emissão.

No pedido de NFC-e, `"contingencia": "automatica"` faz o cofre esperar até 20 segundos pela SEFAZ e, sem resposta conclusiva, emitir a nota em contingência offline (tipo de emissão 9). A resposta vem com `situacao: "contingencia"`, a chave, o QR Code offline e sem protocolo: é o que o caixa imprime.

- A nota em contingência usa um número novo. A nota normal que ficou sem resposta é conferida depois; se tiver sido autorizada, o cofre a cancela por substituição (evento 110112).
- Enquanto a SEFAZ segue fora, as vendas seguintes saem direto em contingência, sem esperar.
- A cada 5 minutos o cofre confere o status da SEFAZ e, quando ela volta, transmite as notas pendentes, o mesmo XML já assinado. `POST /v1/nfce/:id/consultar` tenta na hora, e `GET /v1/cofre` informa quantas notas aguardam.
- Se a SEFAZ rejeitar a nota na transmissão, ela fica `rejeitada` com o motivo e mantém o número. O sistema corrige e reenvia com a mesma referência; a nota sai com o mesmo número e a mesma data.
- `"contingencia": "forcada"` emite direto em contingência; o padrão, `"nunca"`, devolve 502.

Obrigações de quem emite em contingência, que ficam com o sistema do caixa: imprimir o DANFCE com os dizeres "EMITIDA EM CONTINGÊNCIA" e "Pendente de autorização" (o cupom de `GET /v1/nfce/:id/cupom` já vem com eles, e `?via=estabelecimento` devolve a segunda via), guardar a via do estabelecimento (ou o XML, conforme a regra da UF) e respeitar o prazo legal de transmissão, que é o fim do primeiro dia útil seguinte.

Um pedido de NFC-e:

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfce \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "ambiente": "homologacao",
    "referencia": "caixa1-venda-5001",
    "serie": 1,
    "naturezaOperacao": "Venda ao consumidor",
    "emitente": { "nome": "Loja Exemplo Ltda", "inscricaoEstadual": "111111111111", "regime": "simples_nacional",
      "endereco": { "logradouro": "Rua das Flores", "numero": "100", "bairro": "Centro",
        "codigoMunicipio": "3550308", "municipio": "São Paulo", "uf": "SP", "cep": "01001000" } },
    "itens": [ { "codigo": "789", "descricao": "Camiseta de algodão", "ncm": "61091000", "cfop": "5102",
      "unidade": "UN", "quantidade": 1, "valorUnitario": 59.9,
      "impostos": { "icms": { "origem": 0, "csosn": "102" } } } ],
    "pagamentos": [ { "forma": "01", "valor": 100 } ],
    "troco": 40.1
  }'
```

A resposta traz `chaveAcesso`, `protocolo`, `numero`, `valor` e, na NFC-e, `qrCode` e `urlConsulta`. Um exemplo de NF-e está no contrato.

### NF-e recebidas

O cofre baixa do Ambiente Nacional da NF-e as notas que outras empresas emitiram contra o CNPJ do certificado (distribuição de DF-e) e registra a manifestação do destinatário. Tem de ser o cofre, porque as duas coisas exigem o certificado.

> Estado desta parte: os pedidos e a leitura das respostas seguem as notas técnicas 2014.002 (v1.40) e 2020.001 e estão cobertos por testes com um Ambiente Nacional simulado. No serviço real, só a consulta por sequência foi exercitada: em 17/11/2026 um cofre publicado (0.9.0) baixou em produção os documentos de um CNPJ, com as notas completas. A manifestação, a consulta por chave e a busca por NSU ainda não tiveram teste real.

- **Como liga.** No painel do cofre, em "Notas recebidas", o emitente informa a UF do estabelecimento e escolhe se o cofre consulta sozinho. Vem desligado.
- **O cofre é o dono da sequência.** O Ambiente Nacional entrega os documentos numa sequência (NSU) e bloqueia por uma hora o CNPJ que consulta fora dela ou antes da hora. Por isso o último NSU e o horário da próxima consulta ficam só no cofre: o seu sistema lê o que já chegou, e não manda consultar.
- **Quando outro programa consulta o mesmo CNPJ** (o sistema do contador, um ERP antigo). A nota técnica pede que todos sigam a mesma sequência, e o bloqueio (656) vale para o CNPJ inteiro: um pode atrasar o outro em uma hora. Se o bloqueio devolver um NSU à frente do que o cofre conhece, ele segue desse número e busca um a um, pelo NSU, os documentos que ficaram para trás (cerca de 12 por hora, até 500 pendentes), mesmo com a consulta automática desligada. `documentosARecuperar`, em `GET /v1/distribuicao` e no painel, mostra quantos faltam. Com outro programa já registrando a ciência, deixe a ciência automática desligada.
- **Ritmo.** O cofre baixa em lotes de 50 até alcançar o último documento e então espera uma hora, que é a regra do serviço. A primeira consulta traz o que o Ambiente Nacional ainda guarda do CNPJ, que são os documentos dos últimos 90 dias; o que é mais antigo não vem por este serviço.
- **Primeiro o resumo, depois o XML.** O destinatário recebe de início só o resumo da nota (emitente, valor, data, situação). O XML completo é liberado depois da manifestação: ciência, confirmação ou operação não realizada.
- **Leitura pelo seu sistema.** `GET /v1/nfe-recebidas?depois=N` devolve as notas em ordem de `sequencia`, que cresce a cada mudança (o XML chegou, a nota foi cancelada, foi manifestada). Guarde `ultimaSequencia` e passe na leitura seguinte. `papel` diz se o titular é o `destinatario` ou um `terceiro` (transportador ou autorizado a baixar o XML).
- **Manifestação.** `POST /v1/nfe-recebidas/:id/manifestar` com `tipo` (`ciencia`, `confirmacao`, `desconhecimento`, `nao_realizada`); a operação não realizada pede `justificativa`. `POST /v1/nfe-recebidas/manifestar` faz o mesmo pela chave de acesso, até de nota que o cofre ainda não recebeu. Repetir a mesma manifestação não envia nada de novo. A conclusiva pode ser trocada (vale a última), com até dois registros de cada tipo. Depois de uma manifestação que libera o XML, o cofre já tenta baixá-lo pela chave.
- **Ciência automática.** Opção do painel, desligada por padrão: o cofre registra a ciência da operação de cada nota nova, o que libera o XML sem ninguém pedir. É um evento fiscal em nome da empresa (declara que ela sabe da nota, sem confirmar a operação).
- **Consulta por chave.** `POST /v1/distribuicao/consultar-chave` busca uma nota específica dos últimos 90 dias. O serviço aceita 20 por hora; o cofre para em 18.
- **Tudo o que chegou.** `GET /v1/distribuicao/documentos` lista os documentos na ordem de chegada, inclusive os que não são nota recebida, como a manifestação que um cliente registrou numa nota emitida pelo titular.
- **Ainda não há:** aviso (webhook) quando chega nota, e CT-e ou NFS-e recebidos.

### Relatórios e exportação por período

Servem para acompanhar o mês e para mandar os arquivos ao contador. Estão também no painel, em "Relatórios e exportação".

- **Relatório.** `GET /v1/relatorios/notas?ambiente=producao&de=2026-11-01&ate=2026-11-30` soma as notas pelo dia de emissão (até 366 dias): por situação, por dia, por CFOP, por natureza e por destinatário, com os totais de ICMS, ICMS ST, FCP, IPI, PIS, COFINS, II, ISS, IBS, CBS e Imposto Seletivo. Só a nota autorizada entra nos totais fiscais.
- **De onde vêm os impostos.** Dos XML arquivados. O cofre lê cada nota uma vez e guarda o resumo; `notasPorLer` diz quantas faltam (até 150 por pedido), e enquanto não for zero os totais estão incompletos. IBS e CBS da NFS-e ainda não são lidos.
- **Notas recebidas no relatório.** Entram as autorizadas em que o titular é o destinatário; os impostos somam só as que já têm o XML completo.
- **Exportação.** `POST /v1/exportacoes` com `ambiente`, `de`, `ate` e, se quiser, `incluir` (`nfse`, `nfe`, `nfce`, `eventos`, `inutilizacoes`, `recebidas`). A resposta traz os links de download: o ZIP em partes de até 400 arquivos e a planilha `.xlsx`, que também vai dentro da primeira parte. Os eventos acompanham a nota, seja qual for a data deles; nota rejeitada não tem XML fiscal e aparece só na planilha.
- **Links com prazo.** Cada link vale 30 minutos e não leva chave de API: é para o navegador do usuário baixar direto do cofre. `GET /v1/exportacoes/:id` devolve links novos. A exportação some 24 horas depois de criada.
- **Por que em partes.** O Worker tem limite de operações por requisição, então o ZIP é escrito durante o download, parte a parte, e nada fica montado no cofre além da lista dos arquivos e da planilha.
- **Pastas do ZIP.** `emitidas/nfe`, `emitidas/nfce`, `emitidas/nfse` (cada uma com `eventos/`; a NFS-e com `dps/`), `inutilizacoes`, `recebidas` (com `resumos/`, `eventos/` e `manifestacoes/`).

### NFS-e

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfse \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "ambiente": "homologacao",
    "referencia": "pedido-1001",
    "prestador": { "codigoMunicipio": "3550308", "regimeTributario": { "simplesNacional": "me_epp", "apuracaoSimples": 1 } },
    "tomador": { "cnpj": "99888777000166", "nome": "Cliente Ltda" },
    "servico": { "codigoMunicipioPrestacao": "3550308", "codigoTributacaoNacional": "010701", "descricao": "Suporte técnico" },
    "valores": { "servico": 1500 },
    "tributacao": { "issqn": { "aliquota": 2 }, "totalTributos": { "tipo": "percentual_simples", "percentual": 6 } }
  }'
```

- **`ambiente`**: `homologacao` (padrão) ou `producao`.
- **`referencia`**: o identificador do pedido no seu sistema. Reenviar a mesma referência nunca gera duas notas; se a primeira tentativa ficou sem resposta do governo, o cofre consulta antes de reenviar. A mesma referência com conteúdo diferente é recusada (`referencia_com_conteudo_diferente`); só uma nota rejeitada pode ser reenviada corrigida com a mesma referência. Vale para os três documentos.
- A numeração da DPS é controlada pelo cofre, por série. O emitente é sempre o titular do certificado instalado.
- Erros vêm como `{ "erro": { "codigo": "...", "mensagem": "..." } }`. Quando o governo rejeita a nota, o corpo traz também a emissão, com as mensagens recebidas.
- Uma chave criada como **somente homologação** nunca emite nem cancela em produção, mesmo com a produção liberada.

Cancelamento:

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfse/ID_DA_EMISSAO/cancelar \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{ "motivo": "erro_emissao", "justificativa": "Nota emitida com o valor incorreto" }'
```

Os campos aceitos estão no contrato; os schemas que os validam ficam em [`src/nfse/schema.ts`](src/nfse/schema.ts) e [`src/nfe/schema.ts`](src/nfe/schema.ts).

## Atualização

O governo muda regras, endereços e leiautes com frequência. As correções são publicadas no canal estável do NFapi (branch `cofre-estavel`), e o painel avisa quando há uma versão nova.

Para atualizar com um clique, crie o gatilho uma única vez:

1. No painel do Cloudflare, abra **Workers & Pages** e selecione o Worker do cofre.
2. Em **Configurações > Compilações > Ganchos de implantação** (em inglês, Settings > Builds > Deploy Hooks), clique em **Adicionar**, dê um nome ao gancho, escolha a branch `main` e salve.
3. Copie a URL que aparece abaixo do gancho e cole na seção **Atualização** do painel do cofre.

O botão **Atualizar** dispara um build no Cloudflare e a tela passa a mostrar o andamento: pedido enviado, build em curso e versão nova no ar, o que costuma levar de um a três minutos. Quando termina, o painel avisa em qualquer tela e mostra o botão **Recarregar a página**; a página recarregada pede o segredo de novo, porque ele não fica guardado no navegador. O cofre não enxerga o build do Cloudflare: ele sabe que terminou quando quem responde já é a versão nova. Se nada mudar em dez minutos, a tela avisa que o build está demorando e manda conferir o registro dele no painel do Cloudflare.

No começo do build, [`tools/atualizar.mjs`](tools/atualizar.mjs) baixa a versão publicada e a instala por cima; o nome do Worker, o banco, o bucket e tudo o que está guardado neles são preservados. Sem o gatilho, o mesmo resultado se obtém refazendo o deploy pelo painel do Cloudflare.

A atualização instala código publicado em `Quevenapp/nfapi`, que é aberto e pode ser conferido antes. Ela só acontece quando você dispara. Quem mantém um fork próprio pode desligá-la com a variável de build `NFAPI_ATUALIZAR=0`, ou apontar para outro repositório com `NFAPI_REPO` e `NFAPI_CANAL`.

## Segurança

- O certificado é gravado cifrado (AES-GCM) com chave derivada do `VAULT_SECRET`; a senha do `.pfx` não é guardada.
- O cofre só assina documentos cujo emitente é o titular do certificado e só transmite para endereços `*.gov.br`.
- As chaves de API são guardadas como hash; o valor aparece uma única vez, na criação, e cada chave pode ser revogada no painel.
- Toda troca com o governo fica gravada no seu R2, e toda operação, na trilha de auditoria.
- A URL do gatilho de atualização fica cifrada no cofre.

## Desenvolvimento

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm dev
```

`pnpm testar-certificado caminho/certificado.pfx` verifica, nesta máquina, se um certificado A1 é aceito pelos serviços de homologação.
