const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');

const {
    createPublishedOpenApiDocument
} = require('../modules/agentGateway/contracts/publishedOpenApiDocument');

async function ensureDir(directoryPath) {
    await fs.mkdir(directoryPath, { recursive: true });
}

async function writeDocument(filePath, content) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf8');
}

async function main() {
    const rootDir = path.resolve(__dirname, '..');
    const exportDir = path.join(rootDir, 'mydoc', 'export');
    const yamlPath = path.join(exportDir, 'agent-gateway.openapi.yaml');
    const jsonPath = path.join(exportDir, 'agent-gateway.openapi.json');
    const document = createPublishedOpenApiDocument();

    await writeDocument(yamlPath, yaml.dump(document, {
        noRefs: true,
        lineWidth: 120,
        quotingType: '"'
    }));
    await writeDocument(jsonPath, `${JSON.stringify(document, null, 2)}\n`);

    process.stdout.write([
        `Wrote ${path.relative(rootDir, yamlPath)}`,
        `Wrote ${path.relative(rootDir, jsonPath)}`
    ].join('\n'));
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
