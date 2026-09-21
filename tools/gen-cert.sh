#!/usr/bin/env bash
# Generate the self-signed TLS certificate for the sparkDash dashboard.
# SAN covers the LAN IP of the deployment host plus loopback names.
# Existing certs are kept unless --force is passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/config/tls"
CRT="$DIR/server.crt"
KEY="$DIR/server.key"

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

if [ -e "$CRT" ] || [ -e "$KEY" ]; then
  if [ "$FORCE" -ne 1 ]; then
    echo "TLS certificate already exists:"
    echo "  $CRT"
    echo "  $KEY"
    echo "Refusing to overwrite — pass --force to regenerate."
    exit 0
  fi
fi

mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=sparkDash" \
  -addext "subjectAltName=IP:192.168.10.100,IP:127.0.0.1,DNS:localhost"

chmod 600 "$KEY"
chmod 644 "$CRT"
echo "Wrote $CRT and $KEY (key mode 600, 825 days)."
