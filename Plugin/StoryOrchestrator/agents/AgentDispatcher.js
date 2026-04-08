const http = require('http');
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
    const port = process.env.PORT || globalConfig.PORT || 5890;
    this.agentAssistantUrl = globalConfig.AGENT_ASSISTANT_URL || `http://127.0.0.1:${port}`;
    this.vcpKey = globalConfig.VCP_Key || process.env.VCP_Key || process.env.Key;
    console.log(`[AgentDispatcher] URL: ${this.agentAssistantUrl}`);
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
    const url = new URL(`${this.agentAssistantUrl}/v1/chat/completions`);
    const postData = JSON.stringify(payload);
    
    const requestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      family: 4,
      headers: {
        'Authorization': `Bearer ${this.vcpKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const responseData = JSON.parse(data);
            const content = responseData.choices?.[0]?.message?.content || '';
            resolve({
              content,
              raw: responseData,
              markers: this._parseMarkers(content)
            });
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(options.timeoutMs, () => {
        req.destroy();
        reject(new Error(`Request timeout after ${options.timeoutMs}ms`));
      });

      req.write(postData);
      req.end();
    });
  }

  async _delegateAsync(payload, options) {
    const url = new URL(`${this.agentAssistantUrl}/v1/human/tool`);
    const postData = JSON.stringify({
      tool_name: 'AgentAssistant',
      command: 'delegate_task',
      payload: payload,
      temporary_contact: options.temporaryContact,
      timeout_ms: options.timeoutMs
    });

    const requestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      family: 4,
      headers: {
        'Authorization': `Bearer ${this.vcpKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const responseData = JSON.parse(data);
            const delegationId = responseData.result?.delegation_id;
            if (!delegationId) {
              reject(new Error('No delegation ID returned'));
              return;
            }
            resolve({
              delegationId,
              status: 'delegated',
              poll: () => this.pollDelegation(delegationId, options.timeoutMs)
            });
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  async pollDelegation(delegationId, timeoutMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const url = new URL(`${this.agentAssistantUrl}/v1/human/tool`);
        const postData = JSON.stringify({
          tool_name: 'AgentAssistant',
          command: 'query_delegation',
          delegation_id: delegationId
        });

        const requestOptions = {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          family: 4,
          headers: {
            'Authorization': `Bearer ${this.vcpKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const result = await new Promise((resolve, reject) => {
          const req = http.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            });
          });

          req.on('error', reject);
          req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Poll timeout'));
          });

          req.write(postData);
          req.end();
        });

        if (result.result?.status === 'completed') {
          const content = result.result.response || '';
          return {
            content,
            status: 'completed',
            markers: this._parseMarkers(content),
            raw: result.result
          };
        }

        if (result.result?.status === 'failed') {
          return {
            content: '',
            status: 'failed',
            error: result.result.error || 'Delegation failed',
            markers: { isComplete: false, isFailed: true, hasHeartbeat: false },
            raw: result.result
          };
        }

        await this._sleep(pollInterval);
      } catch (error) {
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
