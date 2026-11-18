#!/bin/sh
# Déploie le relais gratuit sur Cloudflare Workers (compte Cloudflare gratuit requis : npx wrangler login).
set -eu
cd "$(dirname "$0")/../relay-worker"
[ -d node_modules ] || npm ci
npx wrangler deploy
