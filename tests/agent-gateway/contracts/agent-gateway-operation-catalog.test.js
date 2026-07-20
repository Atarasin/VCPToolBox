const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { OPERATION_CATALOG, REST_OPERATIONS, gatewayToolSchemas } = require('../../../modules/agentGateway/contracts/operations');
const { generateMcpDescriptors, generateOpenApiDocument } = require('../../../modules/agentGateway/contracts/generate');
const { createGatewayManagedToolDescriptors } = require('../../../modules/agentGateway/protocols/mcp/descriptors');
const legacyOperations = require('../../../modules/agentGateway/protocols/mcp/operations');
const canonicalOperations = require('../../../modules/agentGateway/contracts/operations');
const { validateGatewayToolArguments } = require('../../../modules/agentGateway/contracts/schemas/validator');
const { convertJsonSchemaToOpenApi } = require('../../../modules/agentGateway/contracts/generate/jsonSchemaToOpenApi');

test('operation catalog freezes the 17 REST paths and 8 MCP operations', () => {
    assert.equal(REST_OPERATIONS.length, 17);
    assert.equal(Object.keys(OPERATION_CATALOG.mcp).length, 8);
    assert.equal(new Set(REST_OPERATIONS.map((operation) => operation.path)).size, 17);
    for (const operation of REST_OPERATIONS) {
        assert.ok(operation.operationId);
        assert.ok(operation.method);
        assert.ok(operation.openapi);
        assert.ok(Array.isArray(operation.parameterLocations));
        assert.ok(Array.isArray(operation.errors));
    }
    for (const operation of OPERATION_CATALOG.mcp) {
        assert.ok(operation.operationId);
        assert.ok(operation.argsSchema);
        assert.ok(operation.resultSchema);
        assert.ok(operation.execution);
        assert.ok(operation.mcp.tool || operation.mcp.prompt);
        assert.ok(Array.isArray(operation.errors));
    }
});

test('legacy MCP operation entrypoint preserves canonical identity', () => {
    assert.equal(legacyOperations.GATEWAY_OPERATIONS, canonicalOperations.GATEWAY_OPERATIONS);
});

test('generated descriptors and OpenAPI artifacts are deterministic', () => {
    assert.deepEqual(generateMcpDescriptors(), createGatewayManagedToolDescriptors());
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const published = JSON.parse(fs.readFileSync(path.join(rootDir, 'mydoc/export/agent-gateway.openapi.json'), 'utf8'));
    const generatedDescriptors = JSON.parse(fs.readFileSync(
        path.join(rootDir, 'modules/agentGateway/contracts/generated/mcpDescriptors.json'), 'utf8'
    ));
    assert.deepEqual(generateOpenApiDocument(), published);
    assert.deepEqual(generateMcpDescriptors(), generatedDescriptors.tools);
});

test('AJV validation does not coerce, default, or remove fields', () => {
    const invalid = { jobId: 123, unexpected: true };
    const before = structuredClone(invalid);
    assert.ok(validateGatewayToolArguments('gateway_job_get', invalid).length > 0);
    assert.deepEqual(invalid, before);
});

test('all managed operations preserve the historical AJV acceptance corpus', () => {
    const corpus = {
        // M3.S1：agentId 改 optional（绑定 credential 可省略），省略不再是
        // schema 违例；invalid 用例改为类型违例。未绑定省略的受控 400 由
        // 运行时决议树负责（M3.S2），不再由 schema 层承担。
        gateway_agent_render: { valid: { maxLength: '2048', unknown: true }, invalid: { agentId: null } },
        gateway_agent_bootstrap: { valid: { maxLength: '2048', unknown: true }, invalid: { agentId: 123 } },
        gateway_job_get: { valid: { jobId: 'job-1', unknown: true }, invalid: { jobId: null } },
        gateway_job_cancel: { valid: { jobId: 'job-1', unknown: true }, invalid: {} },
        gateway_memory_search: { valid: { query: 'memory', k: '5', mode: 'auto', unknown: true },
            invalid: { query: 'memory', mode: 'unsupported' } },
        gateway_context_assemble: { valid: { query: 'context', tokenBudget: '1024', minScore: '0.5', unknown: true },
            invalid: { query: 'context', tokenBudget: null } },
        gateway_memory_write: { valid: { target: { diary: 'Nova' }, memory: { text: 'entry' },
            timestamp: 123, unknown: true }, invalid: { target: null, memory: { text: 'entry' } } },
        gateway_recall_run: { valid: { query: 'recall', unknown: true },
            invalid: { agentId: 'Ariadne', query: null } }
    };

    assert.deepEqual(Object.keys(corpus).sort(), Object.keys(gatewayToolSchemas).sort());
    for (const [operation, cases] of Object.entries(corpus)) {
        const before = structuredClone(cases.valid);
        assert.deepEqual(validateGatewayToolArguments(operation, cases.valid), [], `${operation} valid corpus`);
        assert.deepEqual(cases.valid, before, `${operation} input remains unchanged`);
        assert.ok(validateGatewayToolArguments(operation, cases.invalid).length > 0, `${operation} invalid corpus`);
    }
});

test('JSON Schema conversion handles nullable, examples, const, and unsupported keywords for OpenAPI 3.0', () => {
    assert.deepEqual(convertJsonSchemaToOpenApi({
        type: ['string', 'null'],
        const: 'fixed',
        examples: ['first', 'second'],
        $schema: 'https://json-schema.org/draft/2020-12/schema'
    }), {
        type: 'string',
        nullable: true,
        enum: ['fixed'],
        example: 'first'
    });
});
