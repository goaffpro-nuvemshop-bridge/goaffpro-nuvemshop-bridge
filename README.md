# GoAffPro ↔ Nuvemshop Bridge (Node.js)

Este projeto é um **middleware** para integrar **GoAffPro** (afiliados) com **Nuvemshop/Tiendanube** via API.
Funciona assim:
- Cria/gera cupons na Nuvemshop quando um afiliado nasce no GoAffPro (via webhook) e/ou sincroniza cupons.
- Atribui vendas por **cupom** automaticamente (lendo pedidos pagos via webhook `order/paid`).
- Opcional: coleta **UTMs** no checkout via `Script` da Nuvemshop e salva nos **Custom Fields** do pedido para auditoria.
- Envia os pedidos para o GoAffPro Admin API para atribuição de comissão.

> ⚠️ Este repositório é um **esqueleto funcional**. Você só precisa configurar as variáveis de ambiente, instalar e publicar.

## 1) Pré‑requisitos

- Node 18+
- Uma aplicação criada no **Partner Portal** da Nuvemshop, com **scopes**:
  - `read_orders`, `write_orders`
  - `read_coupons`, `write_coupons`
  - `write_scripts` (se for usar o script)
  - `webhooks` (os webhooks exigem permissões dos recursos)

- Uma conta GoAffPro com **Access Token** do Admin API (Settings → Advanced → Access Tokens).

## 2) Instalação

```bash
cp .env.example .env
# edite o .env com seus dados
npm install
npm run dev
```

Exponha publicamente (Render, Railway, Fly.io, etc.) e aponte o **Redirect URL** e os **Webhooks** para `https://seu-dominio` conforme abaixo.

## 3) Fluxos principais

### OAuth da Nuvemshop
- A Nuvemshop redireciona para `GET /auth/callback?code=...`
- O servidor troca o `code` por `access_token` e `user_id` (store_id) e guarda em memória simples (arquivo JSON seria o próximo passo).

### Webhooks Nuvemshop
- `POST /webhooks/nuvemshop` (verifica `x-linkedstore-hmac-sha256`): reage a `order/paid`.
- Busca o pedido pela API, lê cupom/valor/email e **cria/atualiza** custom fields (UTMs) se existirem.
- Envia o pedido para o GoAffPro Admin API (atribuição por cupom e/ou affiliate_id opcional).

### Webhooks GoAffPro (opcional)
- Configure no GoAffPro um webhook para **affiliate created** → `POST /webhooks/goaffpro?secret=...`
- O servidor cria um **cupom** na Nuvemshop (código baseado no afiliado) e chama a Admin API do GoAffPro para **atribuir** o cupom ao afiliado.

### Script (opcional) para UTM
- Ao instalar, se houver `NS_SCRIPT_ID`, o servidor **associa** o Script à loja e serve `/public/ns-script.js`.
- O script captura utms (`utm_source`, `utm_medium`, etc.) e no checkout manda para `POST /session/utm`.
- No webhook de pedido pago, o servidor tenta colar as UTMs nos **Order Custom Fields** para auditoria.

## 4) Endpoints

- `GET /health` – sanity check
- `GET /auth/callback` – troca `code` por token
- `POST /webhooks/nuvemshop` – recebe eventos da Nuvemshop (usa verificação HMAC)
- `POST /webhooks/goaffpro?secret=...` – recebe eventos do GoAffPro (proteção via query `secret`)
- `POST /session/utm` – salva UTMs por e‑mail para posterior vínculo no pedido
- `POST /admin/test` – ping simples para validar credenciais

## 5) Ajustes que você pode querer fazer
- Persistir tokens/UTMs em banco (Postgres/Redis) em vez de memória.
- Alterar o formato do payload enviado ao GoAffPro conforme o **Swagger** do Admin API.
- Customizar a regra de geração de cupom (prefixo, sufixo, validade, valor).

---

> Documentação útil (links oficiais):
- Nuvemshop API – **Autenticação** e **token**: https://www.tiendanube.com/apps/authorize/token  
- Base URL e **versão 2025‑03**: `https://api.nuvemshop.com.br/2025-03/{store_id}`  
- **Coupons** (criar/editar): API → Resources → Coupons  
- **Webhooks** (eventos `order/paid`, HMAC `x-linkedstore-hmac-sha256`)  
- **Scripts** (injeção de JS no checkout/store)  
- **Order Custom Fields** (gravar UTMs p/ auditoria)  
- GoAffPro – **Access Tokens** (Admin → Settings → Advanced → Access Tokens) e **Webhooks**
