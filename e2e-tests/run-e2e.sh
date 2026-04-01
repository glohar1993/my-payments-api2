#!/bin/bash
# ============================================================
# End-to-End Test Runner
# ============================================================
#
# HOW E2E TESTING WORKS:
# ----------------------
# Unlike unit tests (which mock everything), E2E tests hit
# the REAL deployed API. This catches issues that unit tests
# can't: IAM permission problems, network config, DynamoDB
# schema mismatches, API Gateway misconfigurations, etc.
#
# WHEN THIS RUNS:
# - After every staging deployment (automated)
# - Before production deployment (gate)
# - On-demand by developers
#
# AT MASTERCARD:
# E2E tests would also validate:
# - mTLS certificate authentication
# - ISO 8583 message format compliance
# - Response time SLAs (< 200ms for auth)
# - PCI audit logging
#
# USAGE:
#   API_URL=https://abc123.execute-api.us-east-1.amazonaws.com/staging/ bash e2e-tests/run-e2e.sh
#

set -euo pipefail

# ============================================================
# Configuration
# ============================================================
API_URL="${API_URL:?❌ API_URL environment variable is required}"
TIMEOUT=10  # seconds
PASS=0
FAIL=0
TOTAL=0
TEST_ITEM_ID="e2e-test-$(date +%s)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================================
# Test Helper Functions
# ============================================================

run_test() {
  local test_name="$1"
  local expected_status="$2"
  local method="$3"
  local endpoint="$4"
  local body="${5:-}"

  TOTAL=$((TOTAL + 1))
  echo -n "  Test ${TOTAL}: ${test_name}... "

  # Build curl command
  local curl_args=(-s -o /tmp/e2e_response.json -w "%{http_code}" --max-time ${TIMEOUT})

  if [ "${method}" = "POST" ]; then
    curl_args+=(-X POST -H "Content-Type: application/json" -d "${body}")
  fi

  # Execute request
  local actual_status
  actual_status=$(curl "${curl_args[@]}" "${API_URL}${endpoint}" 2>/dev/null || echo "000")

  # Check result
  if [ "${actual_status}" = "${expected_status}" ]; then
    echo -e "${GREEN}PASS${NC} (HTTP ${actual_status})"
    PASS=$((PASS + 1))
    return 0
  else
    echo -e "${RED}FAIL${NC} (expected ${expected_status}, got ${actual_status})"
    echo "    Response: $(cat /tmp/e2e_response.json 2>/dev/null || echo 'No response')"
    FAIL=$((FAIL + 1))
    return 0  # return 0 so set -e doesn't abort the script on test failures
  fi
}

check_response_field() {
  local test_name="$1"
  local field="$2"
  local expected="$3"

  TOTAL=$((TOTAL + 1))
  echo -n "  Test ${TOTAL}: ${test_name}... "

  local actual
  actual=$(cat /tmp/e2e_response.json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
keys = '${field}'.split('.')
for k in keys:
    data = data[k]
print(data)
" 2>/dev/null || echo "PARSE_ERROR")

  if [ "${actual}" = "${expected}" ]; then
    echo -e "${GREEN}PASS${NC} (${field} = ${expected})"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} (${field}: expected '${expected}', got '${actual}')"
    FAIL=$((FAIL + 1))
  fi
}

check_response_header() {
  local test_name="$1"
  local header="$2"
  local expected="$3"

  TOTAL=$((TOTAL + 1))
  echo -n "  Test ${TOTAL}: ${test_name}... "

  local actual
  actual=$(curl -s -D - -o /dev/null --max-time ${TIMEOUT} "${API_URL}health" 2>/dev/null | grep -i "^${header}:" | cut -d: -f2- | tr -d '[:space:]' || echo "NOT_FOUND")

  if echo "${actual}" | grep -qi "${expected}"; then
    echo -e "${GREEN}PASS${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} (header '${header}': expected '${expected}', got '${actual}')"
    FAIL=$((FAIL + 1))
  fi
}

check_response_time() {
  local test_name="$1"
  local endpoint="$2"
  local max_ms="$3"

  TOTAL=$((TOTAL + 1))
  echo -n "  Test ${TOTAL}: ${test_name}... "

  local time_ms
  time_ms=$(curl -s -o /dev/null -w "%{time_total}" --max-time ${TIMEOUT} "${API_URL}${endpoint}" 2>/dev/null || echo "99")
  time_ms=$(echo "${time_ms} * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "99000")

  if [ "${time_ms}" -lt "${max_ms}" ]; then
    echo -e "${GREEN}PASS${NC} (${time_ms}ms < ${max_ms}ms)"
    PASS=$((PASS + 1))
  else
    echo -e "${YELLOW}WARN${NC} (${time_ms}ms > ${max_ms}ms - SLA breach!)"
    FAIL=$((FAIL + 1))
  fi
}

# ============================================================
# Test Execution
# ============================================================

echo ""
echo "=========================================="
echo "  E2E Test Suite"
echo "  API: ${API_URL}"
echo "  Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=========================================="

# --- Health Check Tests ---
echo ""
echo -e "${YELLOW}► Health Check Tests${NC}"
run_test "Health endpoint returns 200" "200" "GET" "health"
check_response_field "Health status is healthy" "status" "healthy"
check_response_field "Version is present" "version" "1.0.0"

# --- Security Header Tests ---
echo ""
echo -e "${YELLOW}► Security Header Tests (PCI Compliance)${NC}"
check_response_header "X-Content-Type-Options is nosniff" "X-Content-Type-Options" "nosniff"
check_response_header "X-Frame-Options is DENY" "X-Frame-Options" "DENY"
check_response_header "HSTS is present" "Strict-Transport-Security" "max-age"
check_response_header "Cache-Control is no-store" "Cache-Control" "no-store"

# --- CRUD Operation Tests ---
echo ""
echo -e "${YELLOW}► CRUD Operation Tests${NC}"

# Create
run_test "Create item returns 201" "201" "POST" "items" \
  "{\"id\": \"${TEST_ITEM_ID}\", \"data\": {\"name\": \"E2E Test Item\", \"value\": 42}}"
check_response_field "Created item has correct ID" "item.id" "${TEST_ITEM_ID}"

# Read
run_test "Get item by ID returns 200" "200" "GET" "items/${TEST_ITEM_ID}"
check_response_field "Retrieved item has correct ID" "item.id" "${TEST_ITEM_ID}"

# List
run_test "List items returns 200" "200" "GET" "items"

# Not Found
run_test "Get non-existent item returns 404" "404" "GET" "items/does-not-exist-12345"

# --- Error Handling Tests ---
echo ""
echo -e "${YELLOW}► Error Handling Tests${NC}"
run_test "Unknown route returns 403 (API Gateway default)" "403" "GET" "this/route/does/not/exist"
run_test "Invalid POST body returns error" "400" "POST" "items" \
  "{\"missing_required_fields\": true}"

# --- Performance Tests ---
echo ""
echo -e "${YELLOW}► Performance Tests (SLA Validation)${NC}"
check_response_time "Health check < 2000ms" "health" 2000
check_response_time "Get item < 3000ms" "items/${TEST_ITEM_ID}" 3000
check_response_time "List items < 5000ms" "items" 5000

# ============================================================
# Results Summary
# ============================================================
echo ""
echo "=========================================="
echo "  Results: ${PASS} passed, ${FAIL} failed, ${TOTAL} total"
echo "=========================================="

# Cleanup test data (best effort)
echo ""
echo "🧹 Note: Test item '${TEST_ITEM_ID}' remains in DynamoDB."
echo "   In production, you'd have a cleanup Lambda or TTL to auto-delete test data."

# Exit with failure if any test failed
if [ ${FAIL} -gt 0 ]; then
  echo ""
  echo -e "${RED}❌ E2E tests FAILED! Do not deploy to production.${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}✅ All E2E tests PASSED! Safe to proceed.${NC}"
  exit 0
fi
