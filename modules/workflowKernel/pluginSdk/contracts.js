const PLUGIN_SDK_CONTRACT_VERSION = 'plugin-sdk.v1';

function definePhaseOutputContract({ phaseId, outputs = {} } = {}) {
  return {
    type: 'phase_output_contract',
    contractVersion: PLUGIN_SDK_CONTRACT_VERSION,
    phaseId,
    outputs
  };
}

function defineCheckpointPayloadContract({
  checkpointType,
  phaseId,
  title = null,
  reviewFields = {},
  response = {}
} = {}) {
  return {
    type: 'checkpoint_payload_contract',
    contractVersion: PLUGIN_SDK_CONTRACT_VERSION,
    checkpointType,
    phaseId,
    title,
    reviewFields,
    response
  };
}

function defineBusinessSnapshotContract({
  phaseId,
  snapshotFields = {},
  restoreOutputs = {}
} = {}) {
  return {
    type: 'business_snapshot_contract',
    contractVersion: PLUGIN_SDK_CONTRACT_VERSION,
    phaseId,
    snapshotFields,
    restoreOutputs
  };
}

function defineArtifactProjectionContract({
  artifactType,
  phaseId,
  source = {},
  summaryFields = {}
} = {}) {
  return {
    type: 'artifact_projection_contract',
    contractVersion: PLUGIN_SDK_CONTRACT_VERSION,
    artifactType,
    phaseId,
    source,
    summaryFields
  };
}

function createSchemaValidationStepDefinition({
  id,
  dataRef,
  schemaType,
  outputKey,
  inputKey = 'data'
}) {
  return {
    id,
    type: 'schemaValidate',
    input: {
      [inputKey]: { $ref: dataRef },
      schemaType
    },
    outputKey
  };
}

function createHumanReviewCheckpointStep({
  id,
  checkpointType,
  promptTemplate,
  onCheckpointReject = 'retry',
  contract = null
}) {
  const step = {
    id,
    type: 'checkpoint',
    checkpointType,
    promptTemplate,
    onCheckpointReject
  };

  if (contract) {
    step.contract = contract;
  }

  return step;
}

function createPromptRevisionMacro({
  idPrefix,
  generatorStep,
  parserStep,
  validationStep,
  guardStep = null
}) {
  const steps = [generatorStep, parserStep, validationStep];

  if (guardStep) {
    steps.push(guardStep);
  }

  return {
    id: idPrefix,
    type: 'prompt_revision_macro',
    steps
  };
}

function projectContractFields(source, fields = {}) {
  const projected = {};

  for (const [targetKey, descriptor] of Object.entries(fields)) {
    const value = readContractValue(source, descriptor);
    if (value !== undefined) {
      projected[targetKey] = value;
    }
  }

  return projected;
}

function readContractValue(source, descriptor) {
  if (typeof descriptor === 'function') {
    return descriptor(source);
  }

  if (typeof descriptor === 'string') {
    return getPath(source, descriptor);
  }

  if (descriptor && typeof descriptor === 'object') {
    if (typeof descriptor.get === 'function') {
      return descriptor.get(source);
    }
    if (typeof descriptor.path === 'string') {
      return getPath(source, descriptor.path);
    }
    if (descriptor.value !== undefined) {
      return descriptor.value;
    }
  }

  return undefined;
}

function getPath(source, path) {
  if (!path) {
    return source;
  }

  return path.split('.').reduce((current, part) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    return current[part];
  }, source);
}

module.exports = {
  PLUGIN_SDK_CONTRACT_VERSION,
  definePhaseOutputContract,
  defineCheckpointPayloadContract,
  defineBusinessSnapshotContract,
  defineArtifactProjectionContract,
  createSchemaValidationStepDefinition,
  createHumanReviewCheckpointStep,
  createPromptRevisionMacro,
  projectContractFields,
  readContractValue,
  getPath
};
