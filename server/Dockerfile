# Contexte de build : racine du dépôt (shared/ est partagé avec le client).
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY shared shared
COPY server/src server/src
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "src/index.js"]
