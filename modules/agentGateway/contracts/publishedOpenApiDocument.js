const packageJson = require('../../../package.json');
const {
    AGENT_GATEWAY_HEADERS,
    GATEWAY_CAPABILITY_SECTIONS,
    NATIVE_GATEWAY_RELEASE_STAGE,
    NATIVE_GATEWAY_VERSION,
    PUBLISHED_NATIVE_GATEWAY_PATHS
} = require('./protocolGovernance');

function createGatewayMetaSchema() {
    return {
        type: 'object',
        required: ['requestId', 'durationMs', 'gatewayVersion'],
        properties: {
            requestId: { type: 'string' },
            durationMs: { type: 'integer' },
            gatewayVersion: {
                type: 'string',
                example: NATIVE_GATEWAY_VERSION
            },
            authMode: {
                type: 'string',
                example: 'gateway_key'
            },
            authSource: {
                type: 'string',
                example: AGENT_GATEWAY_HEADERS.GATEWAY_KEY
            },
            gatewayId: {
                type: 'string',
                example: 'vcp-gateway'
            },
            traceId: {
                type: 'string',
                example: 'agwop_1234567890abcdef123456'
            },
            operationName: {
                type: 'string',
                example: 'tool.invoke'
            },
            retryAfterMs: {
                type: 'integer'
            },
            toolStatus: {
                type: 'string',
                enum: ['completed', 'accepted', 'waiting_approval']
            }
        }
    };
}

function createErrorEnvelopeSchema() {
    return {
        type: 'object',
        required: ['success', 'error', 'code', 'meta'],
        properties: {
            success: {
                type: 'boolean',
                enum: [false]
            },
            error: { type: 'string' },
            code: {
                type: 'string',
                example: 'AGW_FORBIDDEN'
            },
            details: {
                type: 'object',
                additionalProperties: true
            },
            meta: {
                $ref: '#/components/schemas/GatewayMeta'
            }
        }
    };
}

function createSuccessEnvelopeSchema(dataRef) {
    return {
        type: 'object',
        required: ['success', 'data', 'meta'],
        properties: {
            success: {
                type: 'boolean',
                enum: [true]
            },
            data: dataRef,
            meta: {
                $ref: '#/components/schemas/GatewayMeta'
            }
        }
    };
}

function createRequestContextSchema() {
    return {
        type: 'object',
        properties: {
            requestId: { type: 'string' },
            sessionId: { type: 'string' },
            agentId: { type: 'string' },
            source: { type: 'string' },
            runtime: {
                type: 'string',
                example: 'native'
            }
        }
    };
}

function createAuthContextSchema() {
    return {
        type: 'object',
        properties: {
            requestId: { type: 'string' },
            sessionId: { type: 'string' },
            agentId: { type: 'string' },
            maid: { type: 'string' },
            source: { type: 'string' },
            runtime: { type: 'string' },
            adapter: { type: 'string' },
            gatewayId: { type: 'string' },
            authMode: { type: 'string' },
            authSource: { type: 'string' },
            roles: {
                type: 'array',
                items: { type: 'string' }
            }
        }
    };
}

function createPublishedEventStreamExample() {
    return [
        'event: gateway.meta',
        `data: {"requestId":"req-stream-001","gatewayVersion":"${NATIVE_GATEWAY_VERSION}","authMode":"gateway_key","authSource":"${AGENT_GATEWAY_HEADERS.GATEWAY_KEY}","gatewayId":"gw-prod"}`,
        '',
        'event: job.waiting_approval',
        'data: {"eventId":"evt_001","eventType":"job.waiting_approval","jobId":"job_001","requestId":"req-stream-001","agentId":"Ariadne","sessionId":"sess-001","gatewayId":"gw-prod","timestamp":"2026-04-19T12:00:00.000Z","data":{"status":"waiting_approval","operation":"tool.invoke","metadata":{"toolName":"ProtectedTool"}}}',
        ''
    ].join('\n');
}

function createPublishedToolExample() {
    return {
        toolName: 'ProtectedTool',
        job: {
            jobId: 'job_001',
            status: 'waiting_approval',
            operation: 'tool.invoke',
            target: {
                type: 'tool',
                id: 'ProtectedTool'
            },
            metadata: {
                toolName: 'ProtectedTool'
            },
            authContext: {
                requestId: 'req-tool-001',
                sessionId: 'sess-tool-001',
                agentId: 'Ariadne',
                runtime: 'native',
                gatewayId: 'gw-prod',
                authMode: 'gateway_key',
                authSource: AGENT_GATEWAY_HEADERS.GATEWAY_KEY
            },
            createdAt: '2026-04-19T12:00:00.000Z',
            updatedAt: '2026-04-19T12:00:00.000Z',
            terminal: false
        },
        runtime: {
            deferred: true,
            status: 'waiting_approval'
        },
        audit: {
            approvalUsed: true,
            distributed: false
        }
    };
}

function createTooManyRequestsExample() {
    return {
        success: false,
        error: 'Request rate limit exceeded for this operation',
        code: 'AGW_RATE_LIMITED',
        details: {
            operationName: 'metrics.read',
            traceId: 'agwop_429example1234567890abcd',
            reason: 'rate_limited',
            retryAfterMs: 3000,
            limit: 5,
            windowMs: 60000
        },
        meta: {
            requestId: 'req-metrics-rate-001',
            durationMs: 1,
            gatewayVersion: NATIVE_GATEWAY_VERSION,
            traceId: 'agwop_429example1234567890abcd',
            operationName: 'metrics.read',
            retryAfterMs: 3000
        }
    };
}

function createPayloadTooLargeExample() {
    return {
        success: false,
        error: 'Request payload exceeds the configured operation limit',
        code: 'AGW_PAYLOAD_TOO_LARGE',
        details: {
            operationName: 'tool.invoke',
            traceId: 'agwop_413example1234567890abcd',
            reason: 'payload_too_large',
            payloadBytes: 16384,
            maxPayloadBytes: 4096
        },
        meta: {
            requestId: 'req-tool-payload-001',
            durationMs: 0,
            gatewayVersion: NATIVE_GATEWAY_VERSION,
            traceId: 'agwop_413example1234567890abcd',
            operationName: 'tool.invoke',
            retryAfterMs: 0
        }
    };
}

function createAgentRenderExample() {
    return {
        success: true,
        data: {
            agentId: 'Ariadne',
            alias: 'Ariadne',
            sourceFile: 'Agent/Ariadne.txt',
            renderedPrompt: '你是阿里阿德涅，当前项目是 VCPToolBox。\n记忆片段：上周完成了 gateway render contract 收口。',
            dependencies: {
                agents: [],
                toolboxes: [],
                variables: ['VarSystemInfo'],
                ragBlocks: ['[[阿里阿德涅日记本::Time::TagMemo]]'],
                metaThinkingBlocks: [],
                asyncResults: []
            },
            unresolved: [],
            warnings: [],
            truncated: false,
            renderMeta: {
                memoryRecallApplied: true,
                recallSources: ['tagmemo'],
                truncated: false,
                filteredByPolicy: false,
                unresolvedCount: 0,
                variableKeys: ['VarSystemInfo']
            },
            meta: {
                model: 'gpt-4.1',
                rawSize: 2400,
                renderedSize: 2800,
                variableKeys: ['VarSystemInfo']
            }
        },
        meta: {
            requestId: 'req-agent-render-001',
            durationMs: 12,
            gatewayVersion: NATIVE_GATEWAY_VERSION,
            traceId: 'agwop_renderexample1234567890',
            operationName: 'agents.render'
        }
    };
}

function createDocumentInfo() {
    return {
        title: 'VCP Agent Gateway API',
        version: '1.0.0',
        description: [
            'VCP Agent Gateway 的正式 Native published contract。',
            '',
            '说明：',
            `- 当前对外协议版本为 \`${NATIVE_GATEWAY_VERSION}\`，发布阶段为 \`${NATIVE_GATEWAY_RELEASE_STAGE}\`。`,
            '- 该文档覆盖当前正式开放的 `health / capabilities / agents / metrics / memory / context / tools / jobs / events` 资源。',
            '- 推荐优先使用独立 Gateway 凭证接入；Basic Auth 与 `admin_auth` Cookie 仅作为过渡兼容链路记录。',
            '- 该契约与 `routes/agentGatewayRoutes.js`、M7-M11 主 specs 以及 contract validation 保持对齐。'
        ].join('\n'),
        contact: {
            name: 'VCP Team'
        },
        'x-gateway-version': NATIVE_GATEWAY_VERSION,
        'x-release-stage': NATIVE_GATEWAY_RELEASE_STAGE,
        'x-vcp-version': packageJson.version
    };
}

function createPublishedOpenApiDocument() {
    return {
        openapi: '3.0.3',
        info: createDocumentInfo(),
        servers: [
            { url: 'http://localhost:3000', description: '本地默认端口' },
            { url: 'http://localhost:8080', description: '备用端口' }
        ],
        tags: [
            { name: 'Capabilities' },
            { name: 'Agents' },
            { name: 'Operations' },
            { name: 'Memory' },
            { name: 'Context' },
            { name: 'Tools' },
            { name: 'Jobs' },
            { name: 'Events' }
        ],
        security: [
            { gatewayKeyHeader: [] },
            { gatewayBearerAuth: [] },
            { basicAuth: [] },
            { adminAuthCookie: [] }
        ],
        paths: {
            '/agent_gateway/health': {
                get: {
                    tags: ['Operations'],
                    summary: '读取当前 gateway 实例的健康探测快照',
                    operationId: 'getAgentGatewayHealth',
                    parameters: [
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/HealthSuccess' },
                        401: { $ref: '#/components/responses/Unauthorized' },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/capabilities': {
                get: {
                    tags: ['Capabilities'],
                    summary: '获取当前 agent 可见的 Gateway capabilities',
                    operationId: 'getAgentGatewayCapabilities',
                    parameters: [
                        { $ref: '#/components/parameters/AgentIdQuery' },
                        { $ref: '#/components/parameters/MaidQuery' },
                        {
                            name: 'includeMemoryTargets',
                            in: 'query',
                            schema: { type: 'boolean', default: true }
                        },
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/CapabilitiesSuccess' },
                        400: { $ref: '#/components/responses/InvalidRequest' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/agents': {
                get: {
                    tags: ['Agents'],
                    summary: '获取当前 registry 中的 agent 列表',
                    operationId: 'listAgentGatewayAgents',
                    parameters: [
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/AgentListSuccess' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/agents/{agentId}': {
                get: {
                    tags: ['Agents'],
                    summary: '获取单个 agent 的详细定义',
                    operationId: 'getAgentGatewayAgentDetail',
                    parameters: [
                        { $ref: '#/components/parameters/AgentIdPath' },
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/AgentDetailSuccess' },
                        404: { $ref: '#/components/responses/NotFound' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/agents/{agentId}/render': {
                post: {
                    tags: ['Agents'],
                    summary: '将单个 agent 渲染为可消费 prompt',
                    operationId: 'renderAgentGatewayAgent',
                    parameters: [{ $ref: '#/components/parameters/AgentIdPath' }],
                    requestBody: {
                        required: false,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/AgentRenderRequest' }
                            }
                        }
                    },
                    responses: {
                        200: { $ref: '#/components/responses/AgentRenderSuccess' },
                        404: { $ref: '#/components/responses/NotFound' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/metrics': {
                get: {
                    tags: ['Operations'],
                    summary: '读取当前 gateway 实例的运行指标快照',
                    operationId: 'getAgentGatewayMetrics',
                    parameters: [
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/MetricsSuccess' },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/memory/targets': {
                get: {
                    tags: ['Memory'],
                    summary: '获取当前 agent 可访问的 memory targets',
                    operationId: 'listAgentGatewayMemoryTargets',
                    parameters: [
                        { $ref: '#/components/parameters/AgentIdQuery' },
                        { $ref: '#/components/parameters/MaidQuery' },
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/MemoryTargetsSuccess' },
                        400: { $ref: '#/components/responses/InvalidRequest' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/memory/search': {
                post: {
                    tags: ['Memory'],
                    summary: '执行 diary memory 检索',
                    operationId: 'searchAgentGatewayMemory',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/MemorySearchRequest' }
                            }
                        }
                    },
                    responses: {
                        200: { $ref: '#/components/responses/MemorySearchSuccess' },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        400: { $ref: '#/components/responses/ValidationError' },
                        403: { $ref: '#/components/responses/Forbidden' },
                        404: { $ref: '#/components/responses/NotFound' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/memory/write': {
                post: {
                    tags: ['Memory'],
                    summary: '写入 durable memory 到指定 diary',
                    operationId: 'writeAgentGatewayMemory',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/MemoryWriteRequest' }
                            }
                        }
                    },
                    responses: {
                        200: { $ref: '#/components/responses/MemoryWriteSuccess' },
                        413: { $ref: '#/components/responses/PayloadTooLarge' },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        400: { $ref: '#/components/responses/ValidationError' },
                        403: { $ref: '#/components/responses/Forbidden' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/context/assemble': {
                post: {
                    tags: ['Context'],
                    summary: '根据 query 或 recentMessages 组装 recall context',
                    operationId: 'assembleAgentGatewayContext',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ContextAssembleRequest' }
                            }
                        }
                    },
                    responses: {
                        200: { $ref: '#/components/responses/ContextSuccess' },
                        413: { $ref: '#/components/responses/PayloadTooLarge' },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        400: { $ref: '#/components/responses/ValidationError' },
                        403: { $ref: '#/components/responses/Forbidden' },
                        404: { $ref: '#/components/responses/NotFound' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/tools/{toolName}/invoke': {
                post: {
                    tags: ['Tools'],
                    summary: '调用单个 tool',
                    operationId: 'invokeAgentGatewayTool',
                    parameters: [{ $ref: '#/components/parameters/ToolNamePath' }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ToolInvokeRequest' }
                            }
                        }
                    },
                    responses: {
                        200: { $ref: '#/components/responses/ToolInvokeSuccess' },
                        202: { $ref: '#/components/responses/ToolInvokeAccepted' },
                        413: { $ref: '#/components/responses/PayloadTooLarge' },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        400: { $ref: '#/components/responses/ValidationError' },
                        403: { $ref: '#/components/responses/Forbidden' },
                        404: { $ref: '#/components/responses/NotFound' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/jobs/{jobId}': {
                get: {
                    tags: ['Jobs'],
                    summary: '轮询正式 job runtime 状态',
                    operationId: 'getAgentGatewayJob',
                    parameters: [
                        { $ref: '#/components/parameters/JobIdPath' },
                        { $ref: '#/components/parameters/AgentIdQueryOptional' },
                        { $ref: '#/components/parameters/SessionIdQuery' },
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: { $ref: '#/components/responses/JobSuccess' },
                        403: { $ref: '#/components/responses/Forbidden' },
                        404: { $ref: '#/components/responses/NotFound' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/jobs/{jobId}/cancel': {
                post: {
                    tags: ['Jobs'],
                    summary: '取消一个可取消的 job',
                    operationId: 'cancelAgentGatewayJob',
                    parameters: [{ $ref: '#/components/parameters/JobIdPath' }],
                    requestBody: {
                        required: false,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/JobCancelRequest' }
                            }
                        }
                    },
                    responses: {
                        200: { $ref: '#/components/responses/JobSuccess' },
                        403: { $ref: '#/components/responses/Forbidden' },
                        404: { $ref: '#/components/responses/NotFound' },
                        409: { $ref: '#/components/responses/Conflict' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            },
            '/agent_gateway/events/stream': {
                get: {
                    tags: ['Events'],
                    summary: '通过 SSE 读取 runtime 事件流',
                    operationId: 'streamAgentGatewayEvents',
                    parameters: [
                        { $ref: '#/components/parameters/JobIdQuery' },
                        { $ref: '#/components/parameters/AgentIdQueryOptional' },
                        { $ref: '#/components/parameters/SessionIdQuery' },
                        { $ref: '#/components/parameters/RequestIdQuery' },
                        { $ref: '#/components/parameters/SourceQuery' },
                        { $ref: '#/components/parameters/RuntimeQuery' }
                    ],
                    responses: {
                        200: {
                            description: 'SSE 事件流',
                            headers: {
                                'x-agent-gateway-trace-id': {
                                    $ref: '#/components/headers/XTraceId'
                                },
                                'x-agent-gateway-version': {
                                    $ref: '#/components/headers/XGatewayVersion'
                                }
                            },
                            content: {
                                'text/event-stream': {
                                    schema: {
                                        type: 'string',
                                        example: createPublishedEventStreamExample()
                                    }
                                }
                            }
                        },
                        429: { $ref: '#/components/responses/TooManyRequests' },
                        401: { $ref: '#/components/responses/Unauthorized' },
                        500: { $ref: '#/components/responses/InternalError' }
                    }
                }
            }
        },
        components: {
            securitySchemes: {
                gatewayKeyHeader: {
                    type: 'apiKey',
                    in: 'header',
                    name: AGENT_GATEWAY_HEADERS.GATEWAY_KEY,
                    description: '推荐的 Native Gateway 专用凭证。'
                },
                gatewayBearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    description: '与 gateway key 等价的 Bearer 认证输入。'
                },
                basicAuth: {
                    type: 'http',
                    scheme: 'basic',
                    description: '过渡期兼容的管理后台 Basic Auth。'
                },
                adminAuthCookie: {
                    type: 'apiKey',
                    in: 'cookie',
                    name: 'admin_auth',
                    description: '过渡期兼容的管理态 Cookie。'
                }
            },
            headers: {
                XRequestId: {
                    description: '请求 ID',
                    schema: { type: 'string' }
                },
                XGatewayVersion: {
                    description: 'Agent Gateway 运行时版本',
                    schema: {
                        type: 'string',
                        example: NATIVE_GATEWAY_VERSION
                    }
                },
                XTraceId: {
                    description: 'Agent Gateway 操作级 trace 标识',
                    schema: {
                        type: 'string',
                        example: 'agwop_1234567890abcdef123456'
                    }
                }
            },
            parameters: {
                AgentIdPath: {
                    name: 'agentId',
                    in: 'path',
                    required: true,
                    schema: { type: 'string' }
                },
                JobIdPath: {
                    name: 'jobId',
                    in: 'path',
                    required: true,
                    schema: { type: 'string' }
                },
                ToolNamePath: {
                    name: 'toolName',
                    in: 'path',
                    required: true,
                    schema: { type: 'string' }
                },
                AgentIdQuery: {
                    name: 'agentId',
                    in: 'query',
                    required: true,
                    schema: { type: 'string' }
                },
                AgentIdQueryOptional: {
                    name: 'agentId',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                },
                JobIdQuery: {
                    name: 'jobId',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                },
                MaidQuery: {
                    name: 'maid',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                },
                RequestIdQuery: {
                    name: 'requestId',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                },
                SessionIdQuery: {
                    name: 'sessionId',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                },
                SourceQuery: {
                    name: 'source',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                },
                RuntimeQuery: {
                    name: 'runtime',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                }
            },
            responses: {
                CapabilitiesSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CapabilitiesEnvelope' }
                        }
                    }
                },
                AgentListSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/AgentListEnvelope' }
                        }
                    }
                },
                AgentDetailSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/AgentDetailEnvelope' }
                        }
                    }
                },
                AgentRenderSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/AgentRenderEnvelope' },
                            examples: {
                                renderedPrompt: {
                                    summary: 'final rendered prompt output',
                                    value: createAgentRenderExample()
                                }
                            }
                        }
                    }
                },
                MemoryTargetsSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/MemoryTargetsEnvelope' }
                        }
                    }
                },
                MetricsSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/MetricsEnvelope' }
                        }
                    }
                },
                HealthSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/HealthEnvelope' }
                        }
                    }
                },
                MemorySearchSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/MemorySearchEnvelope' }
                        }
                    }
                },
                MemoryWriteSuccess: {
                    description: '创建成功或命中幂等去重',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/MemoryWriteEnvelope' }
                        }
                    }
                },
                ContextSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ContextEnvelope' }
                        }
                    }
                },
                ToolInvokeSuccess: {
                    description: '工具已同步完成',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ToolInvokeEnvelope' }
                        }
                    }
                },
                ToolInvokeAccepted: {
                    description: '工具调用已进入 deferred runtime',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ToolInvokeEnvelope' }
                        }
                    }
                },
                JobSuccess: {
                    description: '成功',
                    headers: {
                        'x-request-id': { $ref: '#/components/headers/XRequestId' },
                        'x-agent-gateway-version': { $ref: '#/components/headers/XGatewayVersion' },
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/JobEnvelope' }
                        }
                    }
                },
                InvalidRequest: {
                    description: '请求参数缺失或格式不正确',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                },
                ValidationError: {
                    description: '请求体校验失败',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                },
                TooManyRequests: {
                    description: '请求超过当前网关运营保护阈值',
                    headers: {
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' },
                            examples: {
                                rateLimited: {
                                    summary: 'rate limit rejection',
                                    value: createTooManyRequestsExample()
                                }
                            }
                        }
                    }
                },
                PayloadTooLarge: {
                    description: '请求体超过当前 operation 的 payload 上限',
                    headers: {
                        'x-agent-gateway-trace-id': { $ref: '#/components/headers/XTraceId' }
                    },
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' },
                            examples: {
                                payloadRejected: {
                                    summary: 'payload size rejection',
                                    value: createPayloadTooLargeExample()
                                }
                            }
                        }
                    }
                },
                Unauthorized: {
                    description: '认证失败',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                },
                Forbidden: {
                    description: '被共享 policy 或当前权限限制拒绝',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                },
                NotFound: {
                    description: '目标 agent、tool、job 或资源不存在',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                },
                Conflict: {
                    description: '请求与当前资源状态冲突',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                },
                InternalError: {
                    description: '服务内部错误',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ErrorEnvelope' }
                        }
                    }
                }
            },
            schemas: {
                GatewayMeta: createGatewayMetaSchema(),
                ErrorEnvelope: createErrorEnvelopeSchema(),
                RequestContext: createRequestContextSchema(),
                AuthContext: createAuthContextSchema(),
                Message: {
                    type: 'object',
                    properties: {
                        role: { type: 'string' },
                        content: { type: 'string' }
                    }
                },
                MemoryTarget: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        displayName: { type: 'string' },
                        type: { type: 'string', example: 'diary' },
                        allowed: { type: 'boolean' }
                    }
                },
                ToolDescriptor: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        displayName: { type: 'string' },
                        pluginType: { type: 'string' },
                        distributed: { type: 'boolean' },
                        approvalRequired: { type: 'boolean' },
                        timeoutMs: { type: 'integer' },
                        description: { type: 'string' },
                        inputSchema: {
                            type: 'object',
                            additionalProperties: true
                        },
                        invocationCommands: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: true
                            }
                        }
                    }
                },
                ServerInfo: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        version: { type: 'string' },
                        bridgeVersion: { type: 'string' }
                    }
                },
                CapabilitiesData: {
                    type: 'object',
                    properties: {
                        server: { $ref: '#/components/schemas/ServerInfo' },
                        sections: {
                            type: 'array',
                            items: { type: 'string' },
                            example: GATEWAY_CAPABILITY_SECTIONS
                        },
                        tools: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/ToolDescriptor' }
                        },
                        memory: {
                            type: 'object',
                            properties: {
                                targets: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/MemoryTarget' }
                                },
                                features: {
                                    type: 'object',
                                    additionalProperties: { type: 'boolean' }
                                }
                            }
                        },
                        context: {
                            type: 'object',
                            properties: {
                                features: {
                                    type: 'object',
                                    additionalProperties: { type: 'boolean' }
                                }
                            }
                        },
                        jobs: {
                            type: 'object',
                            properties: {
                                supported: { type: 'boolean' },
                                states: {
                                    type: 'array',
                                    items: { type: 'string' }
                                },
                                actions: {
                                    type: 'array',
                                    items: { type: 'string' }
                                }
                            }
                        },
                        events: {
                            type: 'object',
                            properties: {
                                supported: { type: 'boolean' },
                                transports: {
                                    type: 'array',
                                    items: { type: 'string' }
                                },
                                filters: {
                                    type: 'array',
                                    items: { type: 'string' }
                                }
                            }
                        },
                        auth: {
                            type: 'object',
                            properties: {
                                authMode: { type: 'string' },
                                authSource: { type: 'string' },
                                gatewayId: { type: 'string' }
                            }
                        }
                    }
                },
                CapabilitiesEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/CapabilitiesData'
                }),
                DefaultPolicies: {
                    type: 'object',
                    properties: {
                        toolNames: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        memoryTargetIds: {
                            type: 'array',
                            items: { type: 'string' }
                        }
                    }
                },
                AgentPolicyHints: {
                    type: 'object',
                    properties: {
                        toolNames: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        memoryTargetIds: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        contextSupported: { type: 'boolean' },
                        memoryWriteSupported: { type: 'boolean' },
                        jobsSupported: { type: 'boolean' },
                        eventsSupported: { type: 'boolean' }
                    }
                },
                AgentListItem: {
                    type: 'object',
                    properties: {
                        agentId: { type: 'string' },
                        alias: { type: 'string' },
                        sourceFile: { type: 'string' },
                        exists: { type: 'boolean' },
                        mtime: { type: 'string', format: 'date-time', nullable: true },
                        hash: { type: 'string' },
                        summary: { type: 'string' },
                        defaultPolicies: { $ref: '#/components/schemas/DefaultPolicies' },
                        capabilityHints: { $ref: '#/components/schemas/AgentPolicyHints' }
                    }
                },
                AgentListData: {
                    type: 'object',
                    properties: {
                        agents: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/AgentListItem' }
                        }
                    }
                },
                AgentListEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/AgentListData'
                }),
                PlaceholderSummary: {
                    type: 'object',
                    properties: {
                        total: { type: 'integer' },
                        agents: { type: 'array', items: { type: 'string' } },
                        toolboxes: { type: 'array', items: { type: 'string' } },
                        variables: { type: 'array', items: { type: 'string' } },
                        ragBlocks: { type: 'integer' },
                        metaThinkingBlocks: { type: 'integer' },
                        asyncResults: { type: 'integer' }
                    }
                },
                PromptDependencies: {
                    type: 'object',
                    properties: {
                        agents: { type: 'array', items: { type: 'string' } },
                        toolboxes: { type: 'array', items: { type: 'string' } },
                        variables: { type: 'array', items: { type: 'string' } },
                        ragBlocks: { type: 'array', items: { type: 'string' } },
                        metaThinkingBlocks: { type: 'array', items: { type: 'string' } },
                        asyncResults: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    pluginName: { type: 'string' },
                                    requestId: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                AgentDetail: {
                    type: 'object',
                    properties: {
                        agentId: { type: 'string' },
                        alias: { type: 'string' },
                        sourceFile: { type: 'string' },
                        exists: { type: 'boolean' },
                        mtime: { type: 'string', format: 'date-time', nullable: true },
                        hash: { type: 'string' },
                        summary: { type: 'string' },
                        defaultPolicies: { $ref: '#/components/schemas/DefaultPolicies' },
                        capabilityHints: { $ref: '#/components/schemas/AgentPolicyHints' },
                        prompt: {
                            type: 'object',
                            properties: {
                                raw: { type: 'string' },
                                size: { type: 'integer' },
                                placeholderSummary: { $ref: '#/components/schemas/PlaceholderSummary' },
                                dependencies: { $ref: '#/components/schemas/PromptDependencies' }
                            }
                        },
                        accessibleTools: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/ToolDescriptor' }
                        },
                        accessibleMemoryTargets: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/MemoryTarget' }
                        }
                    }
                },
                AgentDetailEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/AgentDetail'
                }),
                AgentRenderRequest: {
                    type: 'object',
                    properties: {
                        requestContext: { $ref: '#/components/schemas/RequestContext' },
                        authContext: { $ref: '#/components/schemas/AuthContext' },
                        variables: {
                            type: 'object',
                            additionalProperties: { type: 'string' }
                        },
                        model: { type: 'string' },
                        maxLength: { type: 'integer' },
                        context: {
                            type: 'object',
                            additionalProperties: true
                        },
                        messages: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/Message' }
                        }
                    }
                },
                AgentRenderResult: {
                    type: 'object',
                    properties: {
                        agentId: { type: 'string' },
                        alias: { type: 'string' },
                        sourceFile: { type: 'string' },
                        renderedPrompt: { type: 'string' },
                        dependencies: { $ref: '#/components/schemas/PromptDependencies' },
                        unresolved: { type: 'array', items: { type: 'string' } },
                        warnings: { type: 'array', items: { type: 'string' } },
                        truncated: { type: 'boolean' },
                        renderMeta: { $ref: '#/components/schemas/AgentRenderMeta' },
                        meta: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                },
                AgentRenderMeta: {
                    type: 'object',
                    properties: {
                        memoryRecallApplied: { type: 'boolean' },
                        recallSources: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        truncated: { type: 'boolean' },
                        filteredByPolicy: { type: 'boolean' },
                        unresolvedCount: { type: 'integer' },
                        variableKeys: {
                            type: 'array',
                            items: { type: 'string' }
                        }
                    }
                },
                AgentRenderEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/AgentRenderResult'
                }),
                MemoryTargetsData: {
                    type: 'object',
                    properties: {
                        targets: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/MemoryTarget' }
                        }
                    }
                },
                MemoryTargetsEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/MemoryTargetsData'
                }),
                GatewayOperationMetric: {
                    type: 'object',
                    properties: {
                        operationName: { type: 'string' },
                        policy: {
                            type: 'object',
                            additionalProperties: true
                        },
                        active: { type: 'integer' },
                        totals: {
                            type: 'object',
                            additionalProperties: { type: 'integer' }
                        },
                        lastTraceId: { type: 'string' },
                        lastRequestId: { type: 'string' },
                        lastOutcome: { type: 'string' },
                        lastUpdatedAt: { type: 'string', format: 'date-time', nullable: true }
                    }
                },
                GatewayRecentRejection: {
                    type: 'object',
                    properties: {
                        traceId: { type: 'string' },
                        requestId: { type: 'string' },
                        operationName: { type: 'string' },
                        code: { type: 'string' },
                        reason: { type: 'string' },
                        retryAfterMs: { type: 'integer' },
                        subjectKey: { type: 'string' },
                        timestamp: { type: 'string', format: 'date-time' }
                    }
                },
                MetricsData: {
                    type: 'object',
                    properties: {
                        totals: {
                            type: 'object',
                            additionalProperties: { type: 'integer' }
                        },
                        operations: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/GatewayOperationMetric' }
                        },
                        recentRejections: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/GatewayRecentRejection' }
                        }
                    }
                },
                MetricsEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/MetricsData'
                }),
                HealthData: {
                    type: 'object',
                    required: ['status', 'serverTime', 'pluginManagerReady', 'knowledgeBaseReady', 'gatewayVersion'],
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['ok', 'degraded']
                        },
                        serverTime: {
                            type: 'string',
                            format: 'date-time'
                        },
                        pluginManagerReady: {
                            type: 'boolean'
                        },
                        knowledgeBaseReady: {
                            type: 'boolean'
                        },
                        gatewayVersion: {
                            type: 'string',
                            example: NATIVE_GATEWAY_VERSION
                        }
                    }
                },
                HealthEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/HealthData'
                }),
                MemorySearchRequest: {
                    type: 'object',
                    required: ['query', 'requestContext'],
                    properties: {
                        query: { type: 'string' },
                        diary: { type: 'string' },
                        diaries: { type: 'array', items: { type: 'string' } },
                        maid: { type: 'string' },
                        mode: {
                            type: 'string',
                            enum: ['rag', 'hybrid', 'auto']
                        },
                        k: { type: 'integer' },
                        timeAware: { type: 'boolean' },
                        groupAware: { type: 'boolean' },
                        rerank: { type: 'boolean' },
                        tagMemo: { type: 'boolean' },
                        requestContext: { $ref: '#/components/schemas/RequestContext' },
                        authContext: { $ref: '#/components/schemas/AuthContext' }
                    }
                },
                MemorySearchItem: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                        score: { type: 'number', format: 'float' },
                        sourceDiary: { type: 'string' },
                        sourceFile: { type: 'string' },
                        sourcePath: { type: 'string' },
                        tags: { type: 'array', items: { type: 'string' } },
                        updatedAt: { type: 'string', format: 'date-time', nullable: true }
                    }
                },
                MemorySearchData: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/MemorySearchItem' }
                        },
                        diagnostics: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                },
                MemorySearchEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/MemorySearchData'
                }),
                MemoryWriteRequest: {
                    type: 'object',
                    required: ['target', 'memory', 'requestContext'],
                    properties: {
                        target: {
                            type: 'object',
                            required: ['diary'],
                            properties: {
                                diary: { type: 'string' },
                                maid: { type: 'string' }
                            }
                        },
                        memory: {
                            type: 'object',
                            required: ['text', 'tags'],
                            properties: {
                                text: { type: 'string' },
                                tags: {
                                    type: 'array',
                                    items: { type: 'string' }
                                },
                                metadata: {
                                    type: 'object',
                                    additionalProperties: true
                                },
                                timestamp: {
                                    type: 'string',
                                    format: 'date-time'
                                }
                            }
                        },
                        options: {
                            type: 'object',
                            properties: {
                                deduplicate: { type: 'boolean', default: true },
                                idempotencyKey: { type: 'string' },
                                bridgeToolName: { type: 'string' }
                            }
                        },
                        requestContext: { $ref: '#/components/schemas/RequestContext' },
                        authContext: { $ref: '#/components/schemas/AuthContext' }
                    }
                },
                MemoryWriteData: {
                    type: 'object',
                    properties: {
                        writeStatus: {
                            type: 'string',
                            enum: ['created', 'skipped_duplicate']
                        },
                        diary: { type: 'string' },
                        entryId: { type: 'string' },
                        deduplicated: { type: 'boolean' },
                        filePath: { type: 'string' },
                        idempotentReplay: { type: 'boolean' },
                        timestamp: { type: 'string', format: 'date-time' }
                    }
                },
                MemoryWriteEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/MemoryWriteData'
                }),
                ContextAssembleRequest: {
                    type: 'object',
                    required: ['requestContext'],
                    properties: {
                        query: { type: 'string' },
                        recentMessages: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/Message' }
                        },
                        diary: { type: 'string' },
                        diaries: { type: 'array', items: { type: 'string' } },
                        maid: { type: 'string' },
                        mode: {
                            type: 'string',
                            enum: ['rag', 'hybrid', 'auto']
                        },
                        maxBlocks: { type: 'integer' },
                        tokenBudget: { type: 'integer' },
                        maxTokenRatio: { type: 'number', format: 'float' },
                        minScore: { type: 'number', format: 'float' },
                        timeAware: { type: 'boolean' },
                        groupAware: { type: 'boolean' },
                        rerank: { type: 'boolean' },
                        tagMemo: { type: 'boolean' },
                        requestContext: { $ref: '#/components/schemas/RequestContext' },
                        authContext: { $ref: '#/components/schemas/AuthContext' }
                    }
                },
                RecallBlock: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                        metadata: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                },
                ContextData: {
                    type: 'object',
                    properties: {
                        recallBlocks: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/RecallBlock' }
                        },
                        estimatedTokens: { type: 'integer' },
                        appliedPolicy: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                },
                ContextEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/ContextData'
                }),
                ToolInvokeRequest: {
                    type: 'object',
                    required: ['args', 'requestContext'],
                    properties: {
                        args: {
                            type: 'object',
                            additionalProperties: true
                        },
                        maid: { type: 'string' },
                        options: {
                            type: 'object',
                            properties: {
                                idempotencyKey: { type: 'string' }
                            }
                        },
                        requestContext: { $ref: '#/components/schemas/RequestContext' },
                        authContext: { $ref: '#/components/schemas/AuthContext' }
                    }
                },
                JobObject: {
                    type: 'object',
                    properties: {
                        jobId: { type: 'string' },
                        status: {
                            type: 'string',
                            enum: ['accepted', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled']
                        },
                        operation: { type: 'string' },
                        target: {
                            type: 'object',
                            nullable: true,
                            additionalProperties: true
                        },
                        metadata: {
                            type: 'object',
                            additionalProperties: true
                        },
                        authContext: { $ref: '#/components/schemas/AuthContext' },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                        completedAt: { type: 'string', format: 'date-time', nullable: true },
                        failedAt: { type: 'string', format: 'date-time', nullable: true },
                        cancelledAt: { type: 'string', format: 'date-time', nullable: true },
                        terminal: { type: 'boolean' }
                    }
                },
                ToolInvokeData: {
                    type: 'object',
                    properties: {
                        toolName: { type: 'string' },
                        result: {
                            type: 'object',
                            additionalProperties: true
                        },
                        job: { $ref: '#/components/schemas/JobObject' },
                        runtime: {
                            type: 'object',
                            additionalProperties: true
                        },
                        audit: {
                            type: 'object',
                            additionalProperties: true
                        }
                    },
                    example: createPublishedToolExample()
                },
                ToolInvokeEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/ToolInvokeData'
                }),
                JobData: {
                    type: 'object',
                    properties: {
                        job: { $ref: '#/components/schemas/JobObject' }
                    }
                },
                JobEnvelope: createSuccessEnvelopeSchema({
                    $ref: '#/components/schemas/JobData'
                }),
                JobCancelRequest: {
                    type: 'object',
                    properties: {
                        maid: { type: 'string' },
                        requestContext: { $ref: '#/components/schemas/RequestContext' },
                        authContext: { $ref: '#/components/schemas/AuthContext' }
                    }
                },
                RuntimeEvent: {
                    type: 'object',
                    properties: {
                        eventId: { type: 'string' },
                        eventType: {
                            type: 'string',
                            enum: [
                                'job.accepted',
                                'job.running',
                                'job.waiting_approval',
                                'job.completed',
                                'job.failed',
                                'job.cancelled'
                            ]
                        },
                        jobId: { type: 'string' },
                        requestId: { type: 'string' },
                        agentId: { type: 'string' },
                        sessionId: { type: 'string' },
                        gatewayId: { type: 'string' },
                        timestamp: { type: 'string', format: 'date-time' },
                        data: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                }
            }
        }
    };
}

module.exports = {
    PUBLISHED_NATIVE_GATEWAY_PATHS,
    createPublishedOpenApiDocument
};
