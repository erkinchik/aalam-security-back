#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

# Seed is NOT run automatically — too risky for prod and seed.ts will refuse
# unless ALLOW_PROD_SEED=true. To seed a fresh dev DB, run manually:
#   docker compose exec api npx prisma db seed

echo "Starting application..."
# `exec` makes node PID 1 so SIGTERM from `docker stop` reaches the Nest process
# directly (graceful shutdown via enableShutdownHooks).
exec node dist/src/main.js
