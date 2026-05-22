#!/usr/bin/env bash
# S01 E2E Integration Verification Script
# Verifies recall profile infrastructure, route syntax, and runtime availability.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILED=0
PASS=0

report() {
    local status="$1"
    local msg="$2"
    if [ "$status" = "PASS" ]; then
        echo "[PASS] $msg"
        ((PASS+=1))
    else
        echo "[FAIL] $msg"
        ((FAILED+=1))
    fi
}

echo "=== S01 Integration Verification ==="
echo "Project root: ${PROJECT_ROOT}"
echo ""

# 1. recall_profiles.json exists
if [ -f "${PROJECT_ROOT}/modules/agentGateway/config/recall_profiles.json" ]; then
    report PASS "recall_profiles.json exists"
else
    report FAIL "recall_profiles.json missing"
fi

# 2. recallProfileResolver loads without error
if node -e "require('${PROJECT_ROOT}/modules/agentGateway/policy/recallProfileResolver.js'); console.log('ok')" >/dev/null 2>&1; then
    report PASS "recallProfileResolver loads"
else
    report FAIL "recallProfileResolver failed to load"
fi

# 3. recallRuntimeService loads without error
if node -e "require('${PROJECT_ROOT}/modules/agentGateway/services/recallRuntimeService.js'); console.log('ok')" >/dev/null 2>&1; then
    report PASS "recallRuntimeService loads"
else
    report FAIL "recallRuntimeService failed to load"
fi

# 4. recallProjectionService loads without error
if node -e "require('${PROJECT_ROOT}/modules/agentGateway/services/recallProjectionService.js'); console.log('ok')" >/dev/null 2>&1; then
    report PASS "recallProjectionService loads"
else
    report FAIL "recallProjectionService failed to load"
fi

# 5. Route file syntax check
if node -c "${PROJECT_ROOT}/routes/agentGatewayRoutes.js" >/dev/null 2>&1; then
    report PASS "agentGatewayRoutes.js syntax valid"
else
    report FAIL "agentGatewayRoutes.js syntax error"
fi

# 6. MCP descriptor registry syntax check and contains recall_run
if node -c "${PROJECT_ROOT}/modules/agentGateway/adapters/mcpDescriptorRegistry.js" >/dev/null 2>&1; then
    report PASS "mcpDescriptorRegistry.js syntax valid"
else
    report FAIL "mcpDescriptorRegistry.js syntax error"
fi

if grep -q "gateway_recall_run" "${PROJECT_ROOT}/modules/agentGateway/adapters/mcpDescriptorRegistry.js"; then
    report PASS "mcpDescriptorRegistry.js contains gateway_recall_run"
else
    report FAIL "mcpDescriptorRegistry.js missing gateway_recall_run"
fi

# 7. createGatewayServiceBundle syntax check
if node -c "${PROJECT_ROOT}/modules/agentGateway/createGatewayServiceBundle.js" >/dev/null 2>&1; then
    report PASS "createGatewayServiceBundle.js syntax valid"
else
    report FAIL "createGatewayServiceBundle.js syntax error"
fi

# 8. Runtime endpoint tests (only if server is up)
VCP_PORT="${VCP_PORT:-3000}"
VCP_HOST="${VCP_HOST:-localhost}"
BASE_URL="http://${VCP_HOST}:${VCP_PORT}"

if command -v curl >/dev/null 2>&1; then
    if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
        echo ""
        echo "VCP server detected at ${BASE_URL}, running endpoint tests..."

        # Test recall/run with minimal payload (expect 401 or 400, not 404)
        RECALL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST \
            -H "Content-Type: application/json" \
            -d '{"agentId":"test-agent","query":"hello"}' \
            "${BASE_URL}/agent_gateway/recall/run" 2>/dev/null || echo "000")

        if [ "$RECALL_STATUS" != "404" ] && [ "$RECALL_STATUS" != "000" ]; then
            report PASS "POST /agent_gateway/recall/run reachable (status=${RECALL_STATUS})"
        else
            report FAIL "POST /agent_gateway/recall/run unreachable (status=${RECALL_STATUS})"
        fi

        # Test old memory/search still accessible
        MEM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST \
            -H "Content-Type: application/json" \
            -d '{"query":"hello"}' \
            "${BASE_URL}/agent_gateway/memory/search" 2>/dev/null || echo "000")

        if [ "$MEM_STATUS" != "404" ] && [ "$MEM_STATUS" != "000" ]; then
            report PASS "POST /agent_gateway/memory/search reachable (status=${MEM_STATUS})"
        else
            report FAIL "POST /agent_gateway/memory/search unreachable (status=${MEM_STATUS})"
        fi
    else
        echo ""
        echo "VCP server not detected at ${BASE_URL}, skipping runtime endpoint tests."
        echo "Start the server and re-run to validate /recall/run and /memory/search."
    fi
else
    echo ""
    echo "curl not available, skipping runtime endpoint tests."
fi

echo ""
echo "=== Results ==="
echo "Passed: ${PASS}"
echo "Failed: ${FAILED}"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
