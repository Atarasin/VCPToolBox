const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
    createPublishedOpenApiDocument,
    PUBLISHED_NATIVE_GATEWAY_PATHS
} = require('../../../modules/agentGateway/contracts/publishedOpenApiDocument');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readYaml(filePath) {
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function extractNativeRoutePaths(routeFilePaths) {
    const routeSource = (Array.isArray(routeFilePaths) ? routeFilePaths : [routeFilePaths])
        .map((filePath) => fs.readFileSync(filePath, 'utf8'))
        .join('\n');
    const routePattern = /router\.(get|post)\('([^']+)'/g;
    const paths = new Set();
    let matched = routePattern.exec(routeSource);

    while (matched) {
        const rawPath = matched[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        paths.add(`/agent_gateway${rawPath}`);
        matched = routePattern.exec(routeSource);
    }

    return Array.from(paths).sort();
}

test('published Agent Gateway OpenAPI YAML and JSON stay equivalent to the canonical document source', () => {
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const yamlPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.yaml');
    const jsonPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.json');
    const yamlDocument = readYaml(yamlPath);
    const jsonDocument = readJson(jsonPath);
    const canonicalDocument = createPublishedOpenApiDocument();

    assert.deepEqual(yamlDocument, jsonDocument);
    assert.deepEqual(jsonDocument, canonicalDocument);
});

test('published Agent Gateway OpenAPI covers the full native route surface', () => {
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const yamlPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.yaml');
    const routeDir = path.join(rootDir, 'routes', 'agentGateway');
    const routeFilePaths = [path.join(rootDir, 'routes', 'agentGatewayRoutes.js'),
        ...fs.readdirSync(routeDir).filter((name) => name.endsWith('Routes.js'))
            .map((name) => path.join(routeDir, name))];
    const yamlDocument = readYaml(yamlPath);
    const publishedPaths = Object.keys(yamlDocument.paths).sort();
    const routePaths = extractNativeRoutePaths(routeFilePaths);

    assert.deepEqual(publishedPaths, Array.from(PUBLISHED_NATIVE_GATEWAY_PATHS).sort());
    assert.deepEqual(routePaths, Array.from(PUBLISHED_NATIVE_GATEWAY_PATHS).sort());
    assert.equal(yamlDocument.info['x-release-stage'], 'ga');
    assert.equal(yamlDocument.components.securitySchemes.gatewayKeyHeader.name, 'x-agent-gateway-key');
});

test('published Agent Gateway OpenAPI keeps formal runtime and envelope schemas machine-readable', () => {
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const jsonPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.json');
    const document = readJson(jsonPath);

    assert.ok(document.components.schemas.GatewayMeta);
    assert.ok(document.components.schemas.HealthData);
    assert.ok(document.components.schemas.HealthEnvelope);
    assert.ok(document.components.schemas.JobObject);
    assert.ok(document.components.schemas.RuntimeEvent);
    assert.ok(document.components.schemas.AgentRenderMeta);
    assert.ok(document.paths['/agent_gateway/health']);
    assert.ok(document.paths['/agent_gateway/jobs/{jobId}']);
    assert.ok(document.paths['/agent_gateway/events/stream']);
    assert.equal(
        document.paths['/agent_gateway/health'].get.responses['200'].$ref,
        '#/components/responses/HealthSuccess'
    );
    assert.ok(document.paths['/agent_gateway/tools/{toolName}/invoke'].post.responses['202']);
    assert.equal(
        document.components.responses.AgentRenderSuccess.content['application/json'].examples.renderedPrompt.value
            .data.renderMeta.memoryRecallApplied,
        true
    );
    assert.ok(
        document.components.responses.TooManyRequests.content['application/json'].examples.rateLimited.value.meta.traceId
    );
    assert.equal(
        document.components.responses.PayloadTooLarge.content['application/json'].examples.payloadRejected.value.code,
        'AGW_PAYLOAD_TOO_LARGE'
    );
    assert.ok(document.paths['/agent_gateway/recall/run']);
    assert.ok(document.components.schemas.RecallRunRequest);
    assert.ok(document.components.schemas.RecallRunData);
    assert.ok(document.components.schemas.RecallRunEnvelope);
    assert.ok(document.components.schemas.RecallRunItem);
    assert.equal(
        document.paths['/agent_gateway/recall/run'].post.requestBody.content['application/json'].schema.$ref,
        '#/components/schemas/RecallRunRequest'
    );
    assert.equal(
        document.paths['/agent_gateway/recall/run'].post.responses['200'].$ref,
        '#/components/responses/RecallRunSuccess'
    );
    assert.equal(
        document.paths['/agent_gateway/recall/run'].post.responses['403'].$ref,
        '#/components/responses/Forbidden'
    );
    assert.equal(
        document.paths['/agent_gateway/recall/run'].post.responses['404'].$ref,
        '#/components/responses/NotFound'
    );
});

/**
 * 每个 MCP 操作有两份参数 schema：`argsSchema`（服务端校验）与
 * `mcp.tool.inputSchema` / `mcp.prompt.arguments`（对外发布，进 tools/list、
 * prompts/list，宿主看到的就是它）。两者都是 `additionalProperties: false`，
 * 一旦漂移就出现「服务端收得下、宿主根本不会发」的静默失配——新增参数只改
 * 了其中一份是最容易犯的形态。
 */
const MCP_OPERATION_SOURCE = readJson(
    path.join(__dirname, '..', '..', '..', 'modules', 'agentGateway', 'contracts', 'operations', 'mcpOperations.json')
);

test('每个 MCP 操作的服务端 argsSchema 与对外发布的参数面逐字段一致', () => {
    for (const operation of MCP_OPERATION_SOURCE) {
        const expected = Object.keys(operation.argsSchema?.properties || {}).sort();
        assert.ok(expected.length > 0, `${operation.toolName} 必须声明 argsSchema.properties`);

        const publishedTool = operation.mcp?.tool;
        if (publishedTool) {
            assert.deepEqual(
                Object.keys(publishedTool.inputSchema?.properties || {}).sort(),
                expected,
                `${operation.toolName}: mcp.tool.inputSchema 与 argsSchema 字段集漂移`
            );
        }

        const publishedPrompt = operation.mcp?.prompt;
        if (publishedPrompt) {
            assert.deepEqual(
                (publishedPrompt.arguments || []).map((argument) => argument.name).sort(),
                expected,
                `${operation.toolName}: mcp.prompt.arguments 与 argsSchema 字段集漂移`
            );
        }
    }
});

test('render 与 bootstrap 对外声明 query —— 缺了宿主就不会传，检索静默退化', () => {
    const renderOperations = MCP_OPERATION_SOURCE.filter(
        (operation) => operation.execution?.operationName === 'agents.render'
    );
    assert.equal(renderOperations.length, 2, 'render prompt 面与 bootstrap tool 面各一');

    for (const operation of renderOperations) {
        const publishedNames = operation.mcp?.tool
            ? Object.keys(operation.mcp.tool.inputSchema.properties)
            : operation.mcp.prompt.arguments.map((argument) => argument.name);
        assert.ok(publishedNames.includes('query'), `${operation.toolName} 必须对外声明 query`);
    }
});
