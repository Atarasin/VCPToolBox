const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
    createPublishedOpenApiDocument,
    PUBLISHED_NATIVE_GATEWAY_PATHS
} = require('../modules/agentGateway/contracts/publishedOpenApiDocument');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readYaml(filePath) {
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function extractNativeRoutePaths(routeFilePath) {
    const routeSource = fs.readFileSync(routeFilePath, 'utf8');
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
    const rootDir = path.resolve(__dirname, '..');
    const yamlPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.yaml');
    const jsonPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.json');
    const yamlDocument = readYaml(yamlPath);
    const jsonDocument = readJson(jsonPath);
    const canonicalDocument = createPublishedOpenApiDocument();

    assert.deepEqual(yamlDocument, jsonDocument);
    assert.deepEqual(jsonDocument, canonicalDocument);
});

test('published Agent Gateway OpenAPI covers the full native route surface', () => {
    const rootDir = path.resolve(__dirname, '..');
    const yamlPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.yaml');
    const routeFilePath = path.join(rootDir, 'routes', 'agentGatewayRoutes.js');
    const yamlDocument = readYaml(yamlPath);
    const publishedPaths = Object.keys(yamlDocument.paths).sort();
    const routePaths = extractNativeRoutePaths(routeFilePath);

    assert.deepEqual(publishedPaths, Array.from(PUBLISHED_NATIVE_GATEWAY_PATHS).sort());
    assert.deepEqual(routePaths, Array.from(PUBLISHED_NATIVE_GATEWAY_PATHS).sort());
    assert.equal(yamlDocument.info['x-release-stage'], 'ga');
    assert.equal(yamlDocument.components.securitySchemes.gatewayKeyHeader.name, 'x-agent-gateway-key');
});

test('published Agent Gateway OpenAPI keeps formal runtime and envelope schemas machine-readable', () => {
    const rootDir = path.resolve(__dirname, '..');
    const jsonPath = path.join(rootDir, 'mydoc', 'export', 'agent-gateway.openapi.json');
    const document = readJson(jsonPath);

    assert.ok(document.components.schemas.GatewayMeta);
    assert.ok(document.components.schemas.JobObject);
    assert.ok(document.components.schemas.RuntimeEvent);
    assert.ok(document.paths['/agent_gateway/jobs/{jobId}']);
    assert.ok(document.paths['/agent_gateway/events/stream']);
    assert.ok(document.paths['/agent_gateway/tools/{toolName}/invoke'].post.responses['202']);
});
