const {
  definePhaseOutputContract,
  defineCheckpointPayloadContract,
  defineBusinessSnapshotContract,
  defineArtifactProjectionContract,
  projectContractFields
} = require('../../../modules/workflowKernel/pluginSdk');

const phaseOutputContracts = {
  phase1: definePhaseOutputContract({
    phaseId: 'phase1',
    outputs: {
      worldview: 'worldview.data',
      characters: 'characters.data',
      validation: 'phase1Validation'
    }
  }),
  phase2: definePhaseOutputContract({
    phaseId: 'phase2',
    outputs: {
      outline: 'outline',
      chapters: 'chaptersResult.chapters',
      currentChapter: 'chaptersResult.completedCount',
      totalWordCount: 'chaptersResult.totalWordCount'
    }
  }),
  phase3: definePhaseOutputContract({
    phaseId: 'phase3',
    outputs: {
      polishedChapters: 'polishedChapters.chapters',
      iterationCount: 'polishedChapters.iterationCount',
      finalEditorOutput: 'finalEditorOutput'
    }
  })
};

const checkpointContracts = {
  phase1_worldview_confirmation: defineCheckpointPayloadContract({
    checkpointType: 'phase1_worldview_confirmation',
    phaseId: 'phase1',
    title: '世界观与人设审查',
    reviewFields: {
      worldview: 'worldview.data',
      characters: 'characters.data',
      validation: 'phase1Validation'
    },
    response: {
      actions: ['approve', 'reject', 'modify'],
      feedbackField: 'feedback'
    }
  }),
  phase2_outline_confirmation: defineCheckpointPayloadContract({
    checkpointType: 'phase2_outline_confirmation',
    phaseId: 'phase2',
    title: '大纲审查',
    reviewFields: {
      outline: 'outline',
      validation: 'outlineValidation'
    },
    response: {
      actions: ['approve', 'reject', 'modify'],
      feedbackField: 'feedback'
    }
  }),
  phase2_content_confirmation: defineCheckpointPayloadContract({
    checkpointType: 'phase2_content_confirmation',
    phaseId: 'phase2',
    title: '正文审查',
    reviewFields: {
      outline: 'outline',
      chapters: 'chaptersResult.chapters',
      totalWordCount: 'chaptersResult.totalWordCount'
    },
    response: {
      actions: ['approve', 'reject', 'modify'],
      feedbackField: 'feedback'
    }
  }),
  final_acceptance: defineCheckpointPayloadContract({
    checkpointType: 'final_acceptance',
    phaseId: 'phase3',
    title: '终稿验收',
    reviewFields: {
      polishedChapters: 'polishedChapters.chapters',
      iterationCount: 'polishedChapters.iterationCount',
      finalEditorOutput: 'finalEditorOutput'
    },
    response: {
      actions: ['approve', 'reject', 'modify'],
      feedbackField: 'feedback'
    }
  })
};

const snapshotContracts = {
  phase1: defineBusinessSnapshotContract({
    phaseId: 'phase1',
    snapshotFields: {
      worldview: 'worldview.data',
      characters: 'characters.data',
      validation: 'phase1Validation'
    },
    restoreOutputs: {
      worldview: 'worldview',
      characters: 'characters',
      validation: 'phase1Validation'
    }
  }),
  phase2: defineBusinessSnapshotContract({
    phaseId: 'phase2',
    snapshotFields: {
      outline: 'outline',
      chapters: 'chaptersResult.chapters',
      currentChapter: 'chaptersResult.completedCount'
    },
    restoreOutputs: {
      outline: 'outline',
      chapters: 'chaptersResult.chapters',
      currentChapter: 'chaptersResult.completedCount'
    }
  }),
  phase3: defineBusinessSnapshotContract({
    phaseId: 'phase3',
    snapshotFields: {
      polishedChapters: 'polishedChapters.chapters',
      iterationCount: 'polishedChapters.iterationCount',
      finalEditorOutput: 'finalEditorOutput'
    },
    restoreOutputs: {
      polishedChapters: 'polishedChapters.chapters',
      iterationCount: 'polishedChapters.iterationCount',
      finalEditorOutput: 'finalEditorOutput'
    }
  })
};

const artifactContracts = {
  outline: defineArtifactProjectionContract({
    artifactType: 'outline',
    phaseId: 'phase2',
    source: { path: 'outline' },
    summaryFields: {
      chapterCount: (outputs) => outputs?.outline?.chapters?.length || 0
    }
  }),
  chapters: defineArtifactProjectionContract({
    artifactType: 'chapters',
    phaseId: 'phase2',
    source: { path: 'chaptersResult.chapters' },
    summaryFields: {
      chapterCount: (outputs) => outputs?.chaptersResult?.chapters?.length || 0,
      totalWordCount: 'chaptersResult.totalWordCount'
    }
  }),
  polishedChapters: defineArtifactProjectionContract({
    artifactType: 'polishedChapters',
    phaseId: 'phase3',
    source: { path: 'polishedChapters.chapters' },
    summaryFields: {
      chapterCount: (outputs) => outputs?.polishedChapters?.chapters?.length || 0,
      iterationCount: 'polishedChapters.iterationCount'
    }
  })
};

function buildCheckpointPayload(checkpointType, outputs = {}) {
  const contract = checkpointContracts[checkpointType];
  if (!contract) {
    return null;
  }

  return {
    checkpointType,
    contractVersion: contract.contractVersion,
    title: contract.title,
    reviewData: projectContractFields(outputs, contract.reviewFields)
  };
}

function buildSnapshotPayload(phaseId, outputs = {}) {
  const contract = snapshotContracts[phaseId];
  if (!contract) {
    return null;
  }

  return projectContractFields(outputs, contract.snapshotFields);
}

function buildRestoreOutputs(phaseId, snapshot = {}) {
  const contract = snapshotContracts[phaseId];
  if (!contract || !snapshot) {
    return {};
  }

  const restored = {};
  for (const [snapshotKey, outputPath] of Object.entries(contract.restoreOutputs || {})) {
    const value = snapshot[snapshotKey];
    if (value === undefined) {
      continue;
    }

    setPath(restored, outputPath, value);
  }

  return restored;
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let current = target;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

module.exports = {
  phaseOutputContracts,
  checkpointContracts,
  snapshotContracts,
  artifactContracts,
  buildCheckpointPayload,
  buildSnapshotPayload,
  buildRestoreOutputs
};
