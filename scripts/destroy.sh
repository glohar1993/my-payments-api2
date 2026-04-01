#!/bin/bash
# Destroy Script - Tears down all AWS resources for a given environment
# USAGE: ENV=dev bash scripts/destroy.sh

set -euo pipefail

ENV="${ENV:-dev}"
SERVICE_NAME="${SERVICE_NAME:-my-payments-api2}"

echo "⚠️  About to destroy: ${SERVICE_NAME}-${ENV}"

if [ "${ENV}" = "production" ]; then
  echo "❌ REFUSING to destroy production! This must be done manually."
  exit 1
fi

read -p "Are you sure? (yes/no): " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo "🗑️  Destroying stack..."
ENV=${ENV} npx cdk destroy --force

echo "✅ Stack ${SERVICE_NAME}-${ENV} destroyed."
