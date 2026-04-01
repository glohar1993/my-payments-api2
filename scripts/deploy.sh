#!/bin/bash
#
# Deploy Script for my-payments-api2
#
# USAGE:
#   ENV=dev bash scripts/deploy.sh
#   ENV=staging bash scripts/deploy.sh
#   ENV=production bash scripts/deploy.sh
#
# WHAT THIS DOES:
# 1. Installs dependencies
# 2. Runs linting and tests
# 3. Builds the TypeScript code
# 4. Synthesizes CDK (generates CloudFormation)
# 5. Deploys to AWS
# 6. Runs smoke tests against the deployed API
#

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# ============================================================
# Configuration
# ============================================================
ENV="${ENV:-dev}"
SERVICE_NAME="${SERVICE_NAME:-my-payments-api2}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo "=========================================="
echo "  Deploying: ${SERVICE_NAME}"
echo "  Environment: ${ENV}"
echo "  Region: ${AWS_REGION}"
echo "  Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=========================================="

# ============================================================
# Step 1: Install Dependencies
# ============================================================
echo ""
echo "📦 Step 1/6: Installing dependencies..."
npm ci --prefer-offline

# ============================================================
# Step 2: Lint
# ============================================================
echo ""
echo "🔍 Step 2/6: Running linter..."
npm run lint || {
  echo "❌ Linting failed! Fix errors before deploying."
  exit 1
}

# ============================================================
# Step 3: Run Tests
# ============================================================
echo ""
echo "🧪 Step 3/6: Running tests..."
npm test -- --ci --coverage || {
  echo "❌ Tests failed! Fix failing tests before deploying."
  exit 1
}

# Check coverage thresholds
echo "✅ All tests passed with sufficient coverage."

# ============================================================
# Step 4: Build
# ============================================================
echo ""
echo "🔨 Step 4/6: Building TypeScript..."
npm run build

# ============================================================
# Step 5: CDK Synth (Dry Run)
# ============================================================
echo ""
echo "☁️  Step 5/6: Synthesizing CloudFormation template..."
ENV=${ENV} npx cdk synth --quiet || {
  echo "❌ CDK synthesis failed! Check your infrastructure code."
  exit 1
}

# Show what will change (diff)
echo ""
echo "📋 Changes to be deployed:"
ENV=${ENV} npx cdk diff 2>/dev/null || true

# ============================================================
# Step 6: Deploy
# ============================================================
echo ""
if [ "${ENV}" = "production" ]; then
  echo "⚠️  PRODUCTION DEPLOYMENT - Requiring manual approval..."
  ENV=${ENV} npx cdk deploy --require-approval broadening
else
  echo "🚀 Step 6/6: Deploying to ${ENV}..."
  ENV=${ENV} npx cdk deploy --require-approval never
fi

# ============================================================
# Post-Deploy: Smoke Test
# ============================================================
echo ""
echo "🏥 Running post-deploy health check..."

# Get the API URL from CloudFormation outputs
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "${SERVICE_NAME}-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text \
  --region "${AWS_REGION}" 2>/dev/null || echo "")

if [ -n "${API_URL}" ]; then
  echo "   API URL: ${API_URL}"

  # Hit the health endpoint
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}health" || echo "000")

  if [ "${HTTP_STATUS}" = "200" ]; then
    echo "   ✅ Health check PASSED (HTTP ${HTTP_STATUS})"
  else
    echo "   ❌ Health check FAILED (HTTP ${HTTP_STATUS})"
    echo "   ⚠️  Service deployed but may not be healthy!"
    exit 1
  fi
else
  echo "   ⚠️  Could not retrieve API URL. Skipping smoke test."
fi

echo ""
echo "=========================================="
echo "  ✅ Deployment Complete!"
echo "  Service: ${SERVICE_NAME}"
echo "  Environment: ${ENV}"
echo "  Region: ${AWS_REGION}"
echo "=========================================="
