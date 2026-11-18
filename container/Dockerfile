# Proxy mTLS do cofre NFapi. Sem dependências: só o Node e a cadeia ICP-Brasil.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
COPY ca ./ca

ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
