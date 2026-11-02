# Contexte de build : racine du dépôt. Étape 1 : bundle Vite. Étape 2 : nginx répartiteur + statique.
FROM node:22-alpine AS build
WORKDIR /app
COPY client/package.json client/package-lock.json client/
RUN cd client && npm ci
COPY shared shared
COPY client client
RUN cd client && npm run build

FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/gen-cert.sh /docker-entrypoint.d/05-gen-cert.sh
RUN chmod +x /docker-entrypoint.d/05-gen-cert.sh
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 8080 8443
