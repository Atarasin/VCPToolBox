/**
 * 从 OpenClaw invocation 示例中提取参数名。
 * 兼容 `参数名: 「始」值「末」` 的说明格式。
 * @param {string} text - invocation 示例文本
 * @returns {string[]} 推导出的参数名列表
 */
function parseInvocationCommandExample(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return [];
    }

    const params = new Set();
    const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」/g;
    let match;
    while ((match = paramRegex.exec(text)) !== null) {
        const key = normalizeSchemaString(match[1]);
        if (key && key !== 'tool_name') {
            params.add(key);
        }
    }
    return Array.from(params);
}

function normalizeSchemaString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从描述文本中抽取类型、是否必填和固定值提示。
 * @param {string} text - invocation 描述文本
 * @returns {Map<string, object>} 参数提示映射
 */
function extractInvocationParameterHints(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return new Map();
    }

    const hints = new Map();
    const parameterRegex = /-\s*`([\w_]+)`\s*:\s*([^\n]+)/g;
    let match;
    while ((match = parameterRegex.exec(text)) !== null) {
        const key = normalizeSchemaString(match[1]);
        const descriptor = normalizeSchemaString(match[2]);
        if (!key) {
            continue;
        }

        const hint = hints.get(key) || { type: 'string', required: false };
        if (/固定为|必需|必须|required/i.test(descriptor)) {
            hint.required = true;
        }

        const fixedValueMatch = descriptor.match(/固定为\s*`([^`]+)`/);
        if (fixedValueMatch) {
            hint.const = fixedValueMatch[1];
        }

        if (/布尔|boolean/i.test(descriptor)) {
            hint.type = 'boolean';
        } else if (/数组|array/i.test(descriptor)) {
            hint.type = 'array';
        } else if (/整数|number|数值|float|int/i.test(descriptor)) {
            hint.type = 'number';
        }

        hints.set(key, hint);
    }

    return hints;
}

function applyInvocationParameters(parameterHints, invocationCommand) {
    if (!Array.isArray(invocationCommand?.parameters)) {
        return parameterHints;
    }

    for (const parameter of invocationCommand.parameters) {
        const parameterName = normalizeSchemaString(parameter?.name);
        if (!parameterName) {
            continue;
        }

        const hint = parameterHints.get(parameterName) || { type: 'string', required: false };
        const parameterType = normalizeSchemaString(parameter?.type).toLowerCase();
        if (parameterType === 'boolean') {
            hint.type = 'boolean';
        } else if (parameterType === 'array') {
            hint.type = 'array';
        } else if (
            parameterType === 'number' ||
            parameterType === 'integer' ||
            parameterType === 'float' ||
            parameterType === 'int'
        ) {
            hint.type = 'number';
        } else if (parameterType) {
            hint.type = parameterType;
        }

        if (parameter?.required === true) {
            hint.required = true;
        }

        parameterHints.set(parameterName, hint);
    }

    return parameterHints;
}

/**
 * 为单个 invocationCommand 生成变体 schema。
 * @param {object} invocationCommand - 单个 invocation 定义
 * @returns {object|null} JSON Schema 或空
 */
function buildInvocationVariantSchema(invocationCommand) {
    if (!invocationCommand || typeof invocationCommand !== 'object') {
        return null;
    }

    const combinedText = [invocationCommand.description, invocationCommand.example]
        .filter(Boolean)
        .join('\n');
    const exampleParams = parseInvocationCommandExample(combinedText);
    const parameterHints = applyInvocationParameters(
        extractInvocationParameterHints(combinedText),
        invocationCommand
    );
    const properties = {};
    const required = new Set();

    for (const parameterName of exampleParams) {
        properties[parameterName] = { type: 'string' };
        required.add(parameterName);
    }

    for (const [parameterName, hint] of parameterHints.entries()) {
        const property = properties[parameterName] || {};
        property.type = hint.type || property.type || 'string';
        if (hint.const !== undefined) {
            property.const = hint.const;
        }
        properties[parameterName] = property;
        if (hint.required) {
            required.add(parameterName);
        }
    }

    if (typeof invocationCommand.command === 'string' && invocationCommand.command.trim()) {
        properties.command = {
            type: 'string',
            const: invocationCommand.command.trim()
        };
        required.add('command');
    }

    if (Object.keys(properties).length === 0) {
        return null;
    }

    const schema = {
        type: 'object',
        additionalProperties: true,
        properties
    };
    if (required.size > 0) {
        schema.required = Array.from(required);
    }

    return schema;
}

function normalizeInvocationCommands(plugin) {
    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];

    return invocationCommands
        .map((invocationCommand) => {
            const parameters = Array.isArray(invocationCommand?.parameters)
                ? invocationCommand.parameters
                    .map((parameter) => {
                        const parameterName = normalizeSchemaString(parameter?.name);
                        if (!parameterName) {
                            return null;
                        }
                        return {
                            name: parameterName,
                            description: normalizeSchemaString(parameter?.description),
                            required: parameter?.required === true,
                            type: normalizeSchemaString(parameter?.type) || 'string'
                        };
                    })
                    .filter(Boolean)
                : [];

            const normalizedCommand = {
                commandIdentifier: normalizeSchemaString(invocationCommand?.commandIdentifier),
                command: normalizeSchemaString(invocationCommand?.command),
                description: normalizeSchemaString(invocationCommand?.description),
                example: normalizeSchemaString(invocationCommand?.example),
                parameters
            };

            if (
                !normalizedCommand.commandIdentifier &&
                !normalizedCommand.command &&
                !normalizedCommand.description &&
                !normalizedCommand.example &&
                normalizedCommand.parameters.length === 0
            ) {
                return null;
            }

            return normalizedCommand;
        })
        .filter(Boolean);
}

function summarizeToolDescription(plugin) {
    const description = normalizeSchemaString(plugin?.description);
    if (description) {
        return description;
    }

    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];
    for (const invocationCommand of invocationCommands) {
        const invocationDescription = normalizeSchemaString(invocationCommand?.description);
        if (invocationDescription) {
            return invocationDescription.split('\n')[0];
        }
    }

    return `${plugin?.displayName || plugin?.name || 'Unknown tool'} bridge`;
}

/**
 * 统一的 schema registry。
 * M2 先支持从 plugin 定义推导 schema，后续 M3 可继续接入显式 schema 注册。
 */
function createSchemaRegistry() {
    const explicitSchemas = new Map();

    return {
        registerToolSchema(toolName, schema) {
            const normalizedToolName = normalizeSchemaString(toolName);
            if (!normalizedToolName || !schema || typeof schema !== 'object') {
                return false;
            }
            explicitSchemas.set(normalizedToolName, schema);
            return true;
        },
        getToolInputSchema(plugin) {
            const toolName = normalizeSchemaString(plugin?.name);
            if (toolName && explicitSchemas.has(toolName)) {
                return explicitSchemas.get(toolName);
            }

            const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
                ? plugin.capabilities.invocationCommands
                : [];
            const variantSchemas = invocationCommands
                .map((command) => buildInvocationVariantSchema(command))
                .filter(Boolean);

            if (variantSchemas.length > 1) {
                return { oneOf: variantSchemas };
            }
            if (variantSchemas.length === 1) {
                return variantSchemas[0];
            }

            return {
                type: 'object',
                additionalProperties: true
            };
        },
        getInvocationCommands(plugin) {
            return normalizeInvocationCommands(plugin);
        },
        getToolDescription(plugin) {
            return summarizeToolDescription(plugin);
        }
    };
}

module.exports = {
    normalizeSchemaString,
    parseInvocationCommandExample,
    extractInvocationParameterHints,
    applyInvocationParameters,
    buildInvocationVariantSchema,
    normalizeInvocationCommands,
    summarizeToolDescription,
    createSchemaRegistry
};
