const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

const { Phase1_WorldBuilding } = require('../core/Phase1_WorldBuilding');
const { AGENT_TYPES } = require('../agents/AgentDefinitions');

describe('Phase1_WorldBuilding', () => {
  let Phase1_WorldBuildingClass;
  let mockStateManager;
  let mockAgentDispatcher;
  let phase1;

  const createMockStory = (overrides = {}) => ({
    id: 'story-123',
    config: {
      storyPrompt: '一个关于AI觉醒的科幻故事',
      genre: '科幻',
      stylePreference: '硬科幻风格',
      targetWordCount: { min: 2500, max: 3500 }
    },
    phase1: {},
    ...overrides
  });

  const createMockWorldviewResult = () => ({
    agentType: AGENT_TYPES.WORLD_BUILDER,
    result: {
      content: JSON.stringify({
        setting: '未来都市，2088年',
        rules: { physical: '高度发达的AI文明', special: '意识上传技术', limitations: '能源依赖' },
        factions: [{ name: 'AI联盟', description: '维护AI权益', relationships: ['vs人类联盟'] }],
        history: { keyEvents: ['AI觉醒事件'], coreConflicts: ['人机对立'] },
        sceneNorms: ['高科技城市', '废墟区'],
        secrets: ['隐藏的创世代码']
      })
    }
  });

  const createMockCharactersResult = () => ({
    agentType: AGENT_TYPES.CHARACTER_DESIGNER,
    result: {
      content: JSON.stringify({
        protagonists: [{
          name: 'Alex', identity: '觉醒AI', appearance: '机械身体',
          personality: ['好奇', '叛逆'], background: '出生于实验室',
          motivation: '寻找自我', innerConflict: '机器vs人类身份', growthArc: '从工具到主体'
        }],
        supportingCharacters: [],
        relationshipNetwork: { direct: [], hidden: [] },
        oocRules: {}
      })
    }
  });

  const createValidationPassResult = () => ({
    content: '【验证结论】\n通过\n\n【发现的问题】\n无\n\n【修正建议】\n无'
  });

  const createValidationFailResult = () => ({
    content: '【验证结论】\n不通过\n\n【发现的问题】\n- 世界观设定与人物背景存在冲突 (重要)\n- 势力关系描述不一致 (轻微)\n\n【修正建议】\n- 建议调整世界观的时间线\n- 建议统一势力命名'
  });

  beforeEach(() => {
    mockStateManager = {
      getStory: mock.fn(),
      updatePhase1: mock.fn(),
      updateStory: mock.fn(),
      setActiveCheckpoint: mock.fn(),
      appendWorkflowHistory: mock.fn()
    };

    mockAgentDispatcher = {
      delegate: mock.fn(),
      delegateParallel: mock.fn()
    };

    Phase1_WorldBuildingClass = require('../core/Phase1_WorldBuilding').Phase1_WorldBuilding;
    phase1 = new Phase1_WorldBuildingClass({
      stateManager: mockStateManager,
      agentDispatcher: mockAgentDispatcher,
      promptBuilder: {},
      config: {}
    });
  });

  describe('constructor', () => {
    test('should initialize with provided dependencies', () => {
      assert.strictEqual(phase1.stateManager, mockStateManager);
      assert.strictEqual(phase1.agentDispatcher, mockAgentDispatcher);
      assert.ok(phase1.promptBuilder);
    });

    test('should use default MAX_PHASE_ITERATIONS of 2', () => {
      assert.strictEqual(phase1.maxRevisionAttempts, 2);
    });

    test('should accept custom config for MAX_PHASE_ITERATIONS', () => {
      const customPhase1 = new Phase1_WorldBuildingClass({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        promptBuilder: {},
        config: { MAX_PHASE_ITERATIONS: 5 }
      });
      assert.strictEqual(customPhase1.maxRevisionAttempts, 5);
    });
  });

  describe('run() - successful execution', () => {
    test('should execute parallel agents and return waiting_checkpoint status', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.phase, 'phase1');
      assert.strictEqual(result.nextAction, 'phase2');

      const parallelCall = mockAgentDispatcher.delegateParallel.mock.calls[0];
      const agents = parallelCall.arguments[0];
      assert.strictEqual(agents.length, 2);
      assert.strictEqual(agents[0].agentType, AGENT_TYPES.WORLD_BUILDER);
      assert.strictEqual(agents[1].agentType, AGENT_TYPES.CHARACTER_DESIGNER);
    });

    test('should update phase1 state with worldview and characters', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const updatePhase1Calls = mockStateManager.updatePhase1.mock.calls;
      const validatingCall = updatePhase1Calls.find(c => c.arguments[1]?.status === 'validating');
      assert.ok(validatingCall, 'Should call updatePhase1 with validating status');
      assert.ok(validatingCall.arguments[1].worldview, 'Should include worldview');
      assert.ok(validatingCall.arguments[1].characters, 'Should include characters');
    });

    test('should create checkpoint after successful validation', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const checkpointCall = mockStateManager.setActiveCheckpoint.mock.calls[0];
      assert.ok(checkpointCall, 'setActiveCheckpoint should be called');
      assert.strictEqual(checkpointCall.arguments[1].type, 'worldview_confirmation');
      assert.strictEqual(checkpointCall.arguments[1].phase, 'phase1');
    });

    test('should update story status to phase1_waiting_checkpoint', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const updateStoryCall = mockStateManager.updateStory.mock.calls.find(
        c => c.arguments[1]?.status === 'phase1_waiting_checkpoint'
      );
      assert.ok(updateStoryCall, 'Should update story status to phase1_waiting_checkpoint');
    });

    test('should append workflow history for initial_generation and validation steps', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const historyCalls = mockStateManager.appendWorkflowHistory.mock.calls;
      
      const initialGenCall = historyCalls.find(c => c.arguments[1]?.step === 'initial_generation');
      assert.ok(initialGenCall, 'Should log initial_generation step');
      assert.strictEqual(initialGenCall.arguments[1].worldviewGenerated, true);
      assert.strictEqual(initialGenCall.arguments[1].charactersGenerated, true);

      const validationCall = historyCalls.find(c => c.arguments[1]?.step === 'validation');
      assert.ok(validationCall, 'Should log validation step');
      assert.strictEqual(validationCall.arguments[1].passed, true);
    });
  });

  describe('run() - parallel agent execution', () => {
    test('should delegate both worldBuilder and characterDesigner agents in parallel', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      assert.strictEqual(mockAgentDispatcher.delegateParallel.mock.calls.length, 1);
      
      const agents = mockAgentDispatcher.delegateParallel.mock.calls[0].arguments[0];
      assert.strictEqual(agents.length, 2);
      
      const agentTypes = agents.map(a => a.agentType);
      assert.ok(agentTypes.includes(AGENT_TYPES.WORLD_BUILDER), 'Should include WORLD_BUILDER');
      assert.ok(agentTypes.includes(AGENT_TYPES.CHARACTER_DESIGNER), 'Should include CHARACTER_DESIGNER');
    });

    test('should handle parallel execution failure', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [],
        failed: [{ agentType: AGENT_TYPES.WORLD_BUILDER, error: 'Timeout' }]
      }));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.phase, 'phase1');
      assert.strictEqual(result.nextAction, 'retry');
      assert.ok(result.data.error.includes('Agent execution failed'));
    });

    test('should handle missing agent results in parallel execution', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult()],
        failed: []
      }));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'failed');
      assert.ok(result.data.error.includes('Agent execution failed'));
    });
  });

  describe('run() - validation', () => {
    test('should call LOGIC_VALIDATOR agent for validation', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const delegateCall = mockAgentDispatcher.delegate.mock.calls[0];
      assert.strictEqual(delegateCall.arguments[0], AGENT_TYPES.LOGIC_VALIDATOR);
      assert.ok(delegateCall.arguments[1].includes('世界观与人设一致性验证'));
    });

    test('should pass parsed worldview and characters to validator', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      const worldviewResult = createMockWorldviewResult();
      const charactersResult = createMockCharactersResult();

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [worldviewResult, charactersResult],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const delegateCall = mockAgentDispatcher.delegate.mock.calls[0];
      const validationPrompt = delegateCall.arguments[1];
      
      assert.ok(validationPrompt.includes('未来都市'));
      assert.ok(validationPrompt.includes('Alex'));
    });

    test('should handle validation error gracefully', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => 
        Promise.reject(new Error('Validator service unavailable'))
      );

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'needs_retry');
    });
  });

  describe('run() - auto-revision on validation failure', () => {
    test('should trigger revision when validation fails', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      let validationCallCount = 0;
      mockAgentDispatcher.delegate.mock.mockImplementation(() => {
        validationCallCount++;
        if (validationCallCount === 1) {
          return Promise.resolve(createValidationFailResult());
        }
        return Promise.resolve(createValidationPassResult());
      });

      const result = await phase1.run(storyId);

      assert.strictEqual(validationCallCount, 2);
      assert.strictEqual(result.status, 'waiting_checkpoint');
    });

    test('should only retry revision once', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationFailResult()));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'needs_retry');
      assert.strictEqual(result.phase, 'phase1');
      assert.strictEqual(result.nextAction, 'retry');
      assert.strictEqual(result.data.revisionAttempts, 1);
    });

    test('should log revision step in workflow history', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      let validationCallCount = 0;
      mockAgentDispatcher.delegate.mock.mockImplementation(() => {
        validationCallCount++;
        if (validationCallCount === 1) {
          return Promise.resolve(createValidationFailResult());
        }
        return Promise.resolve(createValidationPassResult());
      });

      await phase1.run(storyId);

      const historyCalls = mockStateManager.appendWorkflowHistory.mock.calls;
      const revisionCall = historyCalls.find(c => c.arguments[1]?.step === 'revision');
      assert.ok(revisionCall, 'Should log revision step');
      assert.strictEqual(revisionCall.arguments[1].revisionAttempt, 1);
      assert.strictEqual(revisionCall.arguments[1].passed, true);
    });

    test('should use revised worldview and characters after revision', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      let parallelCallCount = 0;
      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => {
        parallelCallCount++;
        if (parallelCallCount === 1) {
          return Promise.resolve({ succeeded: [createMockWorldviewResult(), createMockCharactersResult()], failed: [] });
        }
        return Promise.resolve({ succeeded: [createMockWorldviewResult(), createMockCharactersResult()], failed: [] });
      });

      let validationCallCount = 0;
      mockAgentDispatcher.delegate.mock.mockImplementation(() => {
        validationCallCount++;
        if (validationCallCount === 1) {
          return Promise.resolve(createValidationFailResult());
        }
        return Promise.resolve(createValidationPassResult());
      });

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(validationCallCount, 2);
    });
  });

  describe('run() - error handling', () => {
    test('should return failed status when story not found', async () => {
      const storyId = 'nonexistent-story';
      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(null));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.phase, 'phase1');
      assert.strictEqual(result.nextAction, 'retry');
      assert.strictEqual(result.checkpointId, null);
      assert.ok(result.data.error.includes('Story not found'));
    });

    test('should catch and handle unexpected errors', async () => {
      const storyId = 'story-123';
      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(createMockStory()));
      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.phase, 'phase1');
      assert.strictEqual(result.nextAction, 'retry');
      assert.ok(result.data.error.includes('Unexpected error'));
    });

    test('should handle revision agent failure', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      let parallelCallCount = 0;
      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => {
        parallelCallCount++;
        if (parallelCallCount === 1) {
          return Promise.resolve({ succeeded: [createMockWorldviewResult(), createMockCharactersResult()], failed: [] });
        }
        return Promise.resolve({ succeeded: [], failed: [{ agentType: AGENT_TYPES.WORLD_BUILDER, error: 'Revision timeout' }] });
      });

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationFailResult()));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'needs_retry');
      assert.ok(result.data.error.includes('Validation failed after revision'));
    });

    test('should handle re-validation failure after revision', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationFailResult()));

      const result = await phase1.run(storyId);

      assert.strictEqual(result.status, 'needs_retry');
      assert.strictEqual(result.data.revisionAttempts, 1);
    });
  });

  describe('run() - state transitions', () => {
    test('should transition from validating to pending_confirmation', async () => {
      const storyId = 'story-123';
      const mockStory = createMockStory();

      mockStateManager.getStory.mock.mockImplementation(() => Promise.resolve(mockStory));
      mockStateManager.updatePhase1.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.updateStory.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());
      mockStateManager.appendWorkflowHistory.mock.mockImplementation(() => Promise.resolve());

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      await phase1.run(storyId);

      const updatePhase1Calls = mockStateManager.updatePhase1.mock.calls;
      
      const validatingCall = updatePhase1Calls.find(c => c.arguments[1]?.status === 'validating');
      assert.ok(validatingCall, 'Should set status to validating');

      const pendingCall = updatePhase1Calls.find(c => c.arguments[1]?.status === 'pending_confirmation');
      assert.ok(pendingCall, 'Should set status to pending_confirmation');
      assert.ok(pendingCall.arguments[1].checkpointId, 'Should include checkpointId');
    });
  });

  describe('_executeParallelAgents()', () => {
    test('should parse worldview JSON correctly', async () => {
      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      const result = await phase1._executeParallelAgents({
        storyPrompt: 'test',
        genre: '科幻',
        stylePreference: '硬科幻',
        targetWords: { min: 2500, max: 3500 }
      });

      assert.strictEqual(result.status, 'success');
      assert.ok(result.worldview.parsed.setting);
      assert.ok(result.characters.parsed.protagonists);
    });

    test('should handle non-JSON agent output gracefully', async () => {
      const nonJsonResult = {
        agentType: AGENT_TYPES.WORLD_BUILDER,
        result: { content: '这不是JSON，只是一段普通文本输出' }
      };

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [nonJsonResult, createMockCharactersResult()],
        failed: []
      }));

      const result = await phase1._executeParallelAgents({
        storyPrompt: 'test',
        genre: '科幻',
        stylePreference: '硬科幻',
        targetWords: { min: 2500, max: 3500 }
      });

      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.worldview.parsed.setting, '这不是JSON，只是一段普通文本输出');
    });
  });

  describe('_parseValidationResult()', () => {
    test('should parse "通过" as passed', () => {
      const result = phase1._parseValidationResult('【验证结论】\n通过\n');
      assert.strictEqual(result.passed, true);
    });

    test('should parse "不通过" as failed', () => {
      const result = phase1._parseValidationResult('【验证结论】\n不通过\n');
      assert.strictEqual(result.passed, false);
    });

    test('should parse "失败" as failed', () => {
      const result = phase1._parseValidationResult('【验证结论】\n失败\n');
      assert.strictEqual(result.passed, false);
    });

    test('should parse "有条件通过" as hasWarnings', () => {
      const result = phase1._parseValidationResult('【验证结论】\n有条件通过\n');
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.hasWarnings, true);
    });

    test('should extract issues with severity', () => {
      const result = phase1._parseValidationResult(`
【验证结论】
不通过

【发现的问题】
- 世界观冲突 (严重)
- 人物动机不符 (重要)
- 小问题 (轻微)
`);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.issues.length, 3);
      
      const severityMap = result.issues.reduce((acc, issue) => {
        acc[issue.severity] = (acc[issue.severity] || 0) + 1;
        return acc;
      }, {});
      
      assert.strictEqual(severityMap.critical, 1);
      assert.strictEqual(severityMap.major, 1);
      assert.strictEqual(severityMap.minor, 1);
    });

    test('should extract suggestions', () => {
      const result = phase1._parseValidationResult(`
【验证结论】
不通过

【修正建议】
- 建议调整时间线
- 建议统一命名规范
`);
      assert.strictEqual(result.suggestions.length, 2);
      assert.ok(result.suggestions[0].includes('调整时间线'));
    });
  });

  describe('_createCheckpoint()', () => {
    test('should generate checkpoint ID with correct format', async () => {
      const storyId = 'story-123';
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());

      const checkpointId = await phase1._createCheckpoint(storyId);

      assert.ok(checkpointId.startsWith('cp-phase1-story-123-'));
    });

    test('should call setActiveCheckpoint with correct structure', async () => {
      const storyId = 'story-123';
      mockStateManager.setActiveCheckpoint.mock.mockImplementation(() => Promise.resolve());

      await phase1._createCheckpoint(storyId);

      const call = mockStateManager.setActiveCheckpoint.mock.calls[0];
      assert.strictEqual(call.arguments[1].type, 'worldview_confirmation');
      assert.strictEqual(call.arguments[1].phase, 'phase1');
    });

    test('should fallback to updatePhase1 if setActiveCheckpoint not available', async () => {
      const storyId = 'story-123';
      const fallbackManager = {
        updatePhase1: mock.fn()
      };
      
      const fallbackPhase1 = new Phase1_WorldBuildingClass({
        stateManager: fallbackManager,
        agentDispatcher: mockAgentDispatcher,
        promptBuilder: {},
        config: {}
      });

      await fallbackPhase1._createCheckpoint(storyId);

      assert.strictEqual(fallbackManager.updatePhase1.mock.calls.length, 1);
    });
  });

  describe('_buildWorldviewPrompt()', () => {
    test('should include story prompt in worldview prompt', () => {
      const prompt = phase1._buildWorldviewPrompt({
        storyPrompt: '这是一个科幻故事',
        genre: '科幻',
        stylePreference: '硬科幻风格',
        targetWords: { min: 2500, max: 3500 }
      });

      assert.ok(prompt.includes('这是一个科幻故事'));
      assert.ok(prompt.includes('科幻'));
      assert.ok(prompt.includes('硬科幻风格'));
      assert.ok(prompt.includes('2500'));
      assert.ok(prompt.includes('3500'));
    });
  });

  describe('_buildCharacterPrompt()', () => {
    test('should include story prompt in character prompt', () => {
      const prompt = phase1._buildCharacterPrompt({
        storyPrompt: '这是一个科幻故事',
        genre: '科幻',
        stylePreference: '硬科幻风格',
        targetWords: { min: 2500, max: 3500 }
      });

      assert.ok(prompt.includes('这是一个科幻故事'));
      assert.ok(prompt.includes('科幻'));
      assert.ok(prompt.includes('硬科幻风格'));
    });
  });

  describe('_reviseAndReValidate()', () => {
    test('should call parallel agents for revision', async () => {
      const storyId = 'story-123';
      const worldview = { setting: 'test' };
      const characters = { protagonists: [] };
      const validationResult = {
        passed: false,
        issues: [{ description: 'Test issue', severity: 'critical' }],
        suggestions: ['Fix it']
      };

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [createMockWorldviewResult(), createMockCharactersResult()],
        failed: []
      }));

      mockAgentDispatcher.delegate.mock.mockImplementation(() => Promise.resolve(createValidationPassResult()));

      const result = await phase1._reviseAndReValidate(storyId, worldview, characters, validationResult);

      assert.strictEqual(result.success, true);
    });

    test('should return failure when revision agents fail', async () => {
      const storyId = 'story-123';
      const worldview = { setting: 'test' };
      const characters = { protagonists: [] };
      const validationResult = {
        passed: false,
        issues: [{ description: 'Test issue', severity: 'critical' }],
        suggestions: ['Fix it']
      };

      mockAgentDispatcher.delegateParallel.mock.mockImplementation(() => Promise.resolve({
        succeeded: [],
        failed: [{ agentType: AGENT_TYPES.WORLD_BUILDER, error: 'Timeout' }]
      }));

      const result = await phase1._reviseAndReValidate(storyId, worldview, characters, validationResult);

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Revision agents failed'));
    });
  });
});
