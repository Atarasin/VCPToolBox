/**
 * Retry policy with global defaults and step-level override.
 */

class RetryPolicy {
  constructor(globalConfig = {}) {
    this.hasGlobalOverride = Boolean(globalConfig && Object.keys(globalConfig).length > 0);
    this.globalConfig = {
      maxAttempts: globalConfig.maxAttempts ?? 3,
      backoffDelays: globalConfig.backoffDelays ?? [0, 250, 1000],
      ...globalConfig
    };
  }

  resolve(stepConfig = {}, workflowConfig = null) {
    const stepPolicy = stepConfig.retryPolicy || {};
    const inheritedPolicy = workflowConfig ? {
      maxAttempts: workflowConfig.maxAttempts ?? this.globalConfig.maxAttempts,
      backoffDelays: workflowConfig.backoffDelays ?? this.globalConfig.backoffDelays
    } : this.globalConfig;

    return {
      maxAttempts: stepPolicy.maxAttempts ?? inheritedPolicy.maxAttempts,
      backoffDelays: stepPolicy.backoffDelays ?? inheritedPolicy.backoffDelays
    };
  }

  isConfigured(stepConfig = {}, workflowConfig = null) {
    return Boolean(
      stepConfig.retryPolicy
      || workflowConfig
      || this.hasGlobalOverride
    );
  }

  shouldRetry(attempt, _error, policy) {
    if (attempt >= policy.maxAttempts) {
      return { shouldRetry: false, reason: 'max_attempts_exceeded' };
    }
    return { shouldRetry: true, reason: 'retry_eligible' };
  }

  getDelay(attempt, policy) {
    const delays = policy.backoffDelays;
    if (attempt < delays.length) {
      return delays[attempt];
    }
    return delays[delays.length - 1] || 0;
  }
}

module.exports = { RetryPolicy };
