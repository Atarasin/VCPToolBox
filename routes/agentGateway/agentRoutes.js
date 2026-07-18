'use strict';

const { AGW_ERROR_CODES, AGENT_GATEWAY_HEADERS, NATIVE_GATEWAY_VERSION, applyGovernedCapabilitySections, resolveDedicatedGatewayAuth, normalizeNativeString, parseNativeBoolean, createNativeRequestContext, sendNativeError, buildNativeResponseMeta, buildNativeOperationMeta, buildNativeOperationHeaders, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, sendNativeServiceResult, executeNativeOperationSafely, buildNativeAuthContext, createGovernedRequestBody, createNativeStreamFilters, writeNativeSseEvent, buildNativeHealthSnapshot } = require('./shared');

function registerAgentListRoute(router, context) {
    const { protocolConfig, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/agents', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-registry');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.list',
            requestContext,
            authContext,
            payload: req.query
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        try {
            const agents = await agentRegistryService.listAgents();
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    agents
                },
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent registry',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerAgentDetailRoute(router, context) {
    const { protocolConfig, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/agents/:agentId', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-registry');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.detail',
            requestContext,
            authContext,
            payload: {
                ...req.query,
                agentId: req.params.agentId
            }
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        try {
            const agent = await agentRegistryService.getAgentDetail(req.params.agentId);
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: agent,
                authContext,
                operationControl
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeErrorWithOperation(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details,
                    authContext,
                    operationControl
                });
            }
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent detail',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerAgentRenderRoute(router, context) {
    const { protocolConfig, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/agents/:agentId/render', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-agent-render');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.render',
            requestContext,
            authContext,
            payload: req.body
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        try {
            const rendered = await agentRegistryService.renderAgent(req.params.agentId, {
                variables: req.body?.variables,
                model: req.body?.model,
                maxLength: req.body?.maxLength,
                context: req.body?.context,
                messages: req.body?.messages
            });
            if (
                rendered &&
                typeof rendered === 'object' &&
                rendered.success === true &&
                (
                    rendered.status === 'completed' ||
                    rendered.status === 'accepted' ||
                    rendered.status === 'waiting_approval'
                )
            ) {
                return sendNativeServiceResult(res, {
                    result: rendered,
                    startedAt,
                    authContext,
                    operationControl
                });
            }

            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: rendered,
                authContext,
                operationControl
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeErrorWithOperation(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details,
                    authContext,
                    operationControl
                });
            }
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to render agent',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

module.exports = { registerAgentListRoute, registerAgentDetailRoute, registerAgentRenderRoute };
