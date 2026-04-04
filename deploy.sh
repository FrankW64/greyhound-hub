#!/bin/bash
# Greyhound Hub — deployment script
# Run from the project root on the VPS: bash deploy.sh
set -e

cd "$(dirname "$0")"

echo "── Pulling latest changes ──────────────────────────"
git pull origin main

echo "── Installing production dependencies ──────────────"
npm install --omit=dev

echo "── Ensuring runtime directories exist ──────────────"
mkdir -p data logs

echo "── Restarting via PM2 ──────────────────────────────"
pm2 restart greyhound-hub 2>/dev/null \
  || pm2 start ecosystem.config.js --env production

pm2 save

echo "── Done ────────────────────────────────────────────"
pm2 status greyhound-hub
