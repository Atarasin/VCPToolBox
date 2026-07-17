const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { OPERATION_CATALOG, REST_OPERATIONS } = require('../../../modules/agentGateway/contracts/operations');
const { generateMcpDescriptors, generateOpenApiDocument } = require('../../../modules/agentGateway/contracts/generate');
const { createGatewayManagedToolDescriptors } = require('../../../modules/agentGateway/protocols/mcp/descriptors');
const legacyOperations = require('../../../modules/agentGateway/protocols/mcp/operations');
const canonicalOperations = require('../../../modules/agentGateway/contracts/operations');
const { validateGatewayToolArguments } = require('../../../modules/agentGateway/contracts/schemas/validator');

test('operation catalog freezes the 15 REST paths and 8 MCP operations', () => {
    assert.equal(REST_OPERATIONS.length, 15);
    assert.equal(Object.keys(OPERATION_CATALOG.mcp).length, 8);
    assert.equal(new Set(REST_OPERATIONS.map((operation) => operation.path)).size, 15);
});

test('legacy MCP operation entrypoint preserves canonical identity', () => {
    assert.equal(legacyOperations.GATEWAY_OPERATIONS, canonicalOperations.GATEWAY_OPERATIONS);
});

test('generated descriptors and OpenAPI artifacts are deterministic', () => {
    assert.deepEqual(generateMcpDescriptors(), createGatewayManagedToolDescriptors());
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const published = JSON.parse(fs.readFileSync(path.join(rootDir, 'mydoc/export/agent-gateway.openapi.json'), 'utf8'));
    assert.deepEqual(generateOpenApiDocument(), published);
});

test('AJV validation does not coerce, default, or remove fields', () => {
    const invalid = { jobId: 123, unexpected: true };
    const before = structuredClone(invalid);
    assert.ok(validateGatewayToolArguments('gateway_job_get', invalid).length > 0);
    assert.deepEqual(invalid, before);
});
