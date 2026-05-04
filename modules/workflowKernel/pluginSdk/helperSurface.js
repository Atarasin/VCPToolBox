const HELPER_SURFACE_STATES = Object.freeze({
  STABLE_SHARED_SURFACE: 'stable-shared-surface',
  SHARED_WITH_PLUGIN_SUPPLIED_SEMANTICS: 'shared-with-plugin-supplied-semantics'
});

const SHARED_HELPER_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'schema-validation-step-handler',
    label: 'Schema Validation Step Handler',
    state: HELPER_SURFACE_STATES.STABLE_SHARED_SURFACE,
    module: 'pluginSdk/schemaValidation',
    exports: ['createSchemaValidationStepHandler'],
    rationale: 'Provides reusable schema-validation step orchestration without embedding StoryOrchestrator-specific schema meaning.',
    pluginOwnedConcerns: ['schema validator implementations', 'schemaType meaning'],
    consumers: ['story-orchestrator-adapter', 'workflow-kernel-certification', 'plugin-sdk-contract-tests']
  }),
  Object.freeze({
    id: 'structured-data-extraction',
    label: 'Structured Data Extraction Helpers',
    state: HELPER_SURFACE_STATES.STABLE_SHARED_SURFACE,
    module: 'pluginSdk/extraction',
    exports: [
      'normalizeExtractionOptions',
      'extractWithMetrics',
      'runExtractionStep',
      'createParseStructuredDataStepHandler'
    ],
    rationale: 'Handles generic parse/extract/retry flow while leaving parser configuration and payload meaning to the plugin.',
    pluginOwnedConcerns: ['extraction schemas', 'fallback payload semantics'],
    consumers: ['story-orchestrator-steps', 'plugin-sdk-contract-tests']
  }),
  Object.freeze({
    id: 'structured-validation-orchestration',
    label: 'Structured Validation Orchestration',
    state: HELPER_SURFACE_STATES.SHARED_WITH_PLUGIN_SUPPLIED_SEMANTICS,
    module: 'pluginSdk/structuredValidation',
    exports: [
      'buildIssueObjects',
      'determineIssueSeverity',
      'parseStructuredValidationResult',
      'createStructuredValidationStepHandler'
    ],
    rationale: 'Shares validation call/parse mechanics but requires plugin-supplied prompt construction, agent selection, and domain interpretation.',
    pluginOwnedConcerns: ['prompt wording', 'verdict policy', 'domain-specific issue interpretation'],
    consumers: ['story-orchestrator-steps', 'plugin-sdk-contract-tests']
  }),
  Object.freeze({
    id: 'workflow-contract-builders',
    label: 'Workflow Contract Builders',
    state: HELPER_SURFACE_STATES.STABLE_SHARED_SURFACE,
    module: 'pluginSdk/contracts',
    exports: [
      'definePhaseOutputContract',
      'defineCheckpointPayloadContract',
      'defineBusinessSnapshotContract',
      'defineArtifactProjectionContract',
      'createSchemaValidationStepDefinition',
      'createHumanReviewCheckpointStep',
      'createPromptRevisionMacro',
      'projectContractFields',
      'readContractValue',
      'getPath'
    ],
    rationale: 'Stabilizes shared workflow-authoring contracts while allowing each plugin to supply its own fields, prompts, and phase semantics.',
    pluginOwnedConcerns: ['field mappings', 'checkpoint titles', 'phase-specific macro composition'],
    consumers: ['story-orchestrator-workflow-definition', 'workflow-kernel-certification', 'plugin-sdk-contract-tests']
  })
]);

function listSharedHelperFamilies() {
  return SHARED_HELPER_FAMILIES.map((family) => ({
    ...family,
    exports: [...family.exports],
    pluginOwnedConcerns: [...family.pluginOwnedConcerns],
    consumers: [...family.consumers]
  }));
}

function getSharedHelperFamily(familyId) {
  return listSharedHelperFamilies().find((family) => family.id === familyId) || null;
}

module.exports = {
  HELPER_SURFACE_STATES,
  listSharedHelperFamilies,
  getSharedHelperFamily
};
