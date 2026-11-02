#!/bin/sh
# Certificat auto-signé généré au démarrage : aucune clé privée n'est versionnée.
set -e
mkdir -p /etc/nginx/tls
if [ ! -f /etc/nginx/tls/server.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout /etc/nginx/tls/server.key -out /etc/nginx/tls/server.crt \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi
