#!/usr/bin/env bash
# Entrypoint for both Railway services. Routes to the right app by
# reading RAILWAY_SERVICE_NAME, which Railway injects at runtime.
set -e

if [ "${RAILWAY_SERVICE_NAME}" = "perpetual-warmth" ]; then
  # Web service: Next.js. Railway injects PORT; next start respects it.
  cd shorok-erp-app
  export PORT="${PORT:-3000}"
  exec pnpm --filter @shorok/web start
else
  # API service (shorok-erp-app). Railway injects PORT.
  export API_PORT="${PORT:-3001}"
  exec node shorok-erp-app/apps/api/dist/main
fi
