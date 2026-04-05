const axios = require('axios');
const { AGENT_TYPES, getAgentConfig } = require('./AgentDefinitions');

const COMPLETION_MARKERS = {
  COMPLETE: '[[TaskComplete]]',
  FAILED: '[[TaskFailed]]',
  HEARTBEAT: '[[NextHeartbeat]]'
};

class AgentDispatcher {
  constructor(globalConfig, stateManager) {
    this.config = globalConfig;
    this.stateManager = stateManager;
    this.agentAssistantUrl = globalConfig.AGENT_ASSISTANT_URL || 'http://localhost:5890';
    this.vcpKey = globalConfig.VCP_Key;
  }

  async initialize() {
    console.log('[AgentDispatcher] Initialized');
  }

  async delegate(agentType, prompt, options = {}) {
    const agentConfig = getAgentConfig(agentType, this.config);
    
    if (!agentConfig.modelId) {
      throw new Error(`Agent ${agentType} not configured: missing MODEL_ID`);
    }

    const payload = {
      model: agentConfig.modelId,
      messages: [
        {
          role: 'system',
          content: agentConfig.systemPrompt || `你是${agentConfig.chineseName}Agent。`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: agentConfig.temperature,
      max_tokens: agentConfig.maxOutputTokens,
      stream: false
    };

    const delegationOptions = {
      timeoutMs: options.timeoutMs || 120000,
      temporaryContact: options.temporaryContact !== false,
      taskDelegation: options.taskDelegation || false,
      ...options
    };

    try {
      if (delegationOptions.taskDelegation) {
        return await this._delegateAsync(payload, delegationOptions);
      } else {
        return await this._delegateSync(payload, delegationOptions);
      }
    } catch (error) {
      console.error(`[AgentDispatcher] Delegation failed for ${agentType}:`, error.message);
      throw error;
    }
  }

  async _delegateSync(payload, options) {
    const response = await axios.post(
      `${this.agentAssistantUrl}/v1/chat/completions`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${this.vcpKey}`,
          'Content-Type': 'application/json'
        },
        timeout: options.timeoutMs
      }
    );

    const content = response.data.choices?.[0]?.message?.content || '';
    
    return {
      content,
      raw: response.data,
      markers: this._parseMarkers(content)
    };
  }

  async _delegateAsync(payload, options) {
    const response = await axios.post(
      `${this.agentAssistantUrl}/v1/human/tool`,
      {
        tool_name: 'AgentAssistant',
        command: 'delegate_task',
        payload: payload,
        temporary_contact: options.temporaryContact,
        timeout_ms: options.timeoutMs
      },
      {
        headers: {
          'Authorization': `Bearer ${this.vcpKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const delegationId = response.data.result?.delegation_id;
    if (!delegationId) {
      throw new Error('No delegation ID returned');
    }

    return {
      delegationId,
      status: 'delegated',
      poll: () => this.pollDelegation(delegationId, options.timeoutMs)
    };
  }

  async pollDelegation(delegationId, timeoutMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await axios.post(
          `${this.agentAssistantUrl}/v1/human/tool`,
          {
            tool_name: 'AgentAssistant',
            command: 'query_delegation',
            delegation_id: delegationId
          },
          {
            headers: {
              'Authorization': `Bearer ${this.vcpKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        const result = response.data.result;
        
        if (result.status === 'completed') {
          const content = result.response || '';
          return {
            content,
            status: 'completed',
            markers: this._parseMarkers(content),
            raw: result
          };
        }

        if (result.status === 'failed') {
          return {
            content: '',
            status: 'failed',
            error: result.error || 'Delegation failed',
            markers: { isComplete: false, isFailed: true, hasHeartbeat: false },
            raw: result
          };
        }

        await this._sleep(pollInterval);
      } catch (error) {
        if (error.response?.status === 404) {
          throw new Error(`Delegation not found: ${delegationId}`);
        }
        console.error('[AgentDispatcher] Poll error:', error.message);
        await this._sleep(pollInterval);
      }
    }

    throw new Error(`Delegation timeout: ${delegationId}`);
  }

  async delegateParallel(agentTasks) {
    const promises = agentTasks.map(task => 
      this.delegate(task.agentType, task.prompt, task.options)
        .then(result => ({ status: 'fulfilled', agentType: task.agentType, result }))
        .catch(error => ({ status: 'rejected', agentType: task.agentType, error: error.message }))
    );

    const results = await Promise.all(promises);
    
    return {
      succeeded: results.filter(r => r.status === 'fulfilled'),
      failed: results.filter(r => r.status === 'rejected')
    };
  }

  async delegateSerial(agentTasks, onProgress) {
    const results = [];
    
    for (let i = 0; i < agentTasks.length; i++) {
      const task = agentTasks[i];
      
      if (onProgress) {
        onProgress(i + 1, agentTasks.length, task.agentType);
      }

      try {
        const result = await this.delegate(task.agentType, task.prompt, task.options);
        results.push({
          status: 'success',
          agentType: task.agentType,
          result
        });
      } catch (error) {
        results.push({
          status: 'error',
          agentType: task.agentType,
          error: error.message
        });
        
        if (task.stopOnError !== false) {
          break;
        }
      }
    }

    return results;
  }

  _parseMarkers(content) {
    return {
      isComplete: content.includes(COMPLETION_MARKERS.COMPLETE),
      isFailed: content.includes(COMPLETION_MARKERS.FAILED),
      hasHeartbeat: content.includes(COMPLETION_MARKERS.HEARTBEAT)
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  extractContentAfterMarker(content, marker = COMPLETION_MARKERS.COMPLETE) {
    const index = content.indexOf(marker);
    if (index === -1) return content;
    return content.substring(index + marker.length).trim();
  }
}

module.exports = { AgentDispatcher, COMPLETION_MARKERS };
