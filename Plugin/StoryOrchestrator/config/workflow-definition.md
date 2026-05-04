# StoryOrchestrator Workflow Definition

**Version:** 1.0.0  
**Definition ID:** `story-orchestrator-v1`

Declarative workflow configuration mapping StoryOrchestrator's three hardcoded phases to WorkflowKernel steps. Used when `USE_WORKFLOW_KERNEL=true`.

---

## Overview

This workflow replaces the imperative Phase1/Phase2/Phase3 classes with a declarative step graph executed by WorkflowKernel. The feature switch (`USE_WORKFLOW_KERNEL`) enables gradual rollout: when disabled, legacy phase classes continue to run.

### Architecture

```
StoryOrchestrator
  └── WorkflowEngine
        ├── Legacy path: phases.phase1.run() / phase2.run() / phase3.run()
        └── Kernel path: StoryOrchestratorKernelAdapter
              └── WorkflowKernel
                    └── workflow-definition.js (this file)
```

### Execution Flow

```
Phase 1: 世界观与人设搭建
  ├─ parallelGroup: worldBuilder + characterDesigner
  ├─ parseAgentJson (worldview)
  ├─ parseAgentJson (characters)
  ├─ schemaValidate (worldview)
  ├─ schemaValidate (characters)
  ├─ guard: schema valid?
  ├─ storyValidate: consistency check
  ├─ guard: verdict != FAIL?
  └─ checkpoint: phase1_worldview_confirmation

Phase 2: 大纲与正文生产
  ├─ generateOutline: plotArchitect
  ├─ parseOutline
  ├─ schemaValidate (outline)
  ├─ guard: outline schema valid?
  ├─ storyValidate: outline validation
  ├─ guard: verdict != FAIL?
  ├─ checkpoint: phase2_outline_confirmation
  ├─ produceChapters: chapter-by-chapter loop
  └─ checkpoint: phase2_content_confirmation

Phase 3: 润色与终稿
  ├─ polishChapters: iterative polish + quality gate
  ├─ finalEdit: finalEditor agent
  └─ checkpoint: final_acceptance
```

---

## Phase 1: 世界观与人设搭建

**Phase ID:** `phase1`  
**Historical source before retirement:** `Phase1_WorldBuilding.run()`

### Steps

| Step ID | Type | Purpose | Output Key |
|---------|------|---------|------------|
| `generateWorldAndCharacters` | `parallelGroup` | Run worldBuilder and characterDesigner in parallel | `worldviewRaw`, `charactersRaw` |
| `parseWorldview` | `parseAgentJson` | Extract JSON from worldBuilder output | `worldview` |
| `parseCharacters` | `parseAgentJson` | Extract JSON from characterDesigner output | `characters` |
| `schemaValidateWorldview` | `schemaValidate` | Validate worldview schema | `worldviewSchema` |
| `schemaValidateCharacters` | `schemaValidate` | Validate characters schema | `charactersSchema` |
| `guardSchemaValid` | `guard` | Halt if schema invalid | — |
| `validatePhase1` | `storyValidate` | Consistency validation via logicValidator agent | `phase1Validation` |
| `guardPhase1Valid` | `guard` | Halt if validation verdict is FAIL | — |
| `checkpointPhase1` | `checkpoint` | Human review checkpoint | — |

### Data Flow ($ref paths)

- `ctx.inputs.storyPrompt` → agentCall prompts
- `ctx.outputs.worldviewRaw.content` → parseWorldview
- `ctx.outputs.charactersRaw.content` → parseCharacters
- `ctx.outputs.worldview` → schemaValidateWorldview, validatePhase1
- `ctx.outputs.characters` → schemaValidateCharacters, validatePhase1
- `ctx.outputs.worldviewSchema.valid` → guardSchemaValid condition
- `ctx.outputs.charactersSchema.valid` → guardSchemaValid condition
- `ctx.outputs.phase1Validation.verdict` → guardPhase1Valid condition

### Checkpoint Behavior

- **Type:** `phase1_worldview_confirmation`
- **Prompt:** Review worldview and character designs for completeness and consistency
- **On reject:** Retry (re-runs Phase 1 with feedback)
- **Auto-continue:** Disabled (requires human approval)

---

## Phase 2: 大纲与正文生产

**Phase ID:** `phase2`  
**Historical source before retirement:** `Phase2_OutlineDrafting.run()` + `continueFromCheckpoint()`

### Steps

| Step ID | Type | Purpose | Output Key |
|---------|------|---------|------------|
| `generateOutline` | `generateOutline` | Build prompt and call plotArchitect | `outlineRaw` |
| `parseOutline` | `parseOutline` | Extract structured outline from text | `outline` |
| `schemaValidateOutline` | `schemaValidate` | Validate outline schema | `outlineSchema` |
| `guardOutlineSchema` | `guard` | Halt if outline schema invalid | — |
| `validateOutline` | `storyValidate` | Validate outline logic and consistency | `outlineValidation` |
| `guardOutlineValid` | `guard` | Halt if validation verdict is FAIL | — |
| `checkpointOutline` | `checkpoint` | Human review of outline | — |
| `produceChapters` | `produceChapters` | Chapter-by-chapter content production | `chaptersResult` |
| `checkpointContent` | `checkpoint` | Human review of all chapters | — |

### Data Flow ($ref paths)

- `ctx.inputs.storyPrompt` → generateOutline
- `ctx.outputs.worldview` → generateOutline, validateOutline, produceChapters
- `ctx.outputs.characters` → generateOutline, validateOutline, produceChapters
- `ctx.outputs.outlineRaw.content` → parseOutline
- `ctx.outputs.outline` → schemaValidateOutline, validateOutline, produceChapters
- `ctx.outputs.outlineSchema.valid` → guardOutlineSchema condition
- `ctx.outputs.outlineValidation.verdict` → guardOutlineValid condition
- `ctx.inputs.storyId` → produceChapters
- `ctx.inputs.targetWordCount` → produceChapters

### Checkpoint Behavior

**Outline Checkpoint (`checkpointOutline`):**
- **Type:** `phase2_outline_confirmation`
- **Prompt:** Review chapter structure, core event allocation, story function coverage
- **On reject:** Retry outline generation with feedback

**Content Checkpoint (`checkpointContent`):**
- **Type:** `phase2_content_confirmation`
- **Prompt:** Review chapter content quality, word count compliance, consistency
- **On reject:** Retry specific chapters or full phase2 content production

---

## Phase 3: 润色与终稿

**Phase ID:** `phase3`  
**Historical source before retirement:** `Phase3_Refinement.run()` + `continueFromCheckpoint()`

### Steps

| Step ID | Type | Purpose | Output Key |
|---------|------|---------|------------|
| `polishChapters` | `polishChapters` | Iterative polish loop with quality gates | `polishedChapters` |
| `finalEdit` | `finalEdit` | Final editor agent run | `finalEditorOutput` |
| `checkpointFinal` | `checkpoint` | Final acceptance checkpoint | — |

### Data Flow ($ref paths)

- `ctx.outputs.chaptersResult.chapters` → polishChapters
- `ctx.outputs.worldview` → polishChapters (for validation context)
- `ctx.outputs.characters` → polishChapters (for validation context)
- `ctx.outputs.polishedChapters` → finalEdit

### Checkpoint Behavior

- **Type:** `final_acceptance`
- **Prompt:** Review final manuscript quality
- **On reject:** Re-run Phase 3 polish loop with feedback
- **Auto-continue:** Disabled (requires human approval)

---

## Custom Step Types

The following step types are registered by `StoryOrchestratorKernelAdapter` and are not part of WorkflowKernel's built-in set.

### `parseAgentJson`

Extracts structured JSON from agent raw text output. Uses the same repair logic as the legacy phase classes (handles truncated JSON).

**Input:**
- `raw` (string): Raw agent output text

**Output:**
- `parsed` (Object): Parsed JSON object
- `repairUsed` (boolean): Whether JSON repair was applied

### `schemaValidate`

Runs `SchemaValidator` on parsed data.

**Input:**
- `data` (Object): Parsed data to validate
- `schemaType` (string): `'worldview' | 'characters' | 'outline'`

**Output:**
- `valid` (boolean): Overall validity
- `schemaValid` (boolean): Schema structure validity
- `completenessValid` (boolean): Content completeness
- `errors` (string[]): Validation errors
- `warnings` (string[]): Validation warnings

### `storyValidate`

Runs consistency/logic validation via `logicValidator` agent. Includes internal revision loop (one revision attempt for Phase 1, up to 5 for outline).

**Input:**
- `validationType` (string): `'phase1' | 'outline'`
- `worldview` (Object): Story worldview
- `characters` (Object): Story characters
- `outline` (Object): Story outline (for outline validation)
- `storyPrompt` (string): Original story prompt

**Output:**
- `verdict` (string): `'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL'`
- `issues` (Object[]): List of issues with severity
- `suggestions` (string[]): Improvement suggestions
- `blockingIssues` (Object[]): Critical/blocking issues
- `nonBlockingIssues` (Object[]): Non-blocking issues

### `generateOutline`

Builds outline prompt via `PromptBuilder.buildOutlinePrompt()` and delegates to `plotArchitect` agent.

**Input:**
- `storyPrompt` (string)
- `worldview` (Object)
- `characters` (Object)
- `targetWordCount` (Object): `{ min, max }`

**Output:**
- `content` (string): Raw agent response

### `parseOutline`

Parses outline text using the shared normalization rules preserved by the kernel adapter.

**Input:**
- `raw` (string): Raw outline text

**Output:**
- `chapters` (Object[]): Array of chapter objects
- `structure` (string): Overall story structure
- `keyTurningPoints` (string[]): Key turning points
- `foreshadowing` (string[]): Foreshadowing plan

### `produceChapters`

Chapter-by-chapter content production loop. For each chapter:
1. `chapterOperations.createChapterDraft()`
2. `chapterOperations.fillDetails()`
3. Word count check and auto-expand
4. `contentValidator.comprehensiveValidation()`
5. `chapterOperations.reviseChapter()` if validation fails
6. Save to state

**Input:**
- `storyId` (string)
- `outline` (Object): Parsed outline with chapters array
- `worldview` (Object)
- `characters` (Object)
- `targetWordCount` (Object): `{ min, max }`

**Output:**
- `chapters` (Object[]): Completed chapters with content, metrics, validation
- `totalWordCount` (number): Total word count across all chapters
- `completedCount` (number): Number of successfully completed chapters

### `polishChapters`

Iterative polish loop (up to `MAX_PHASE_ITERATIONS` iterations). For each iteration:
1. For each chapter: `chapterOperations.polishChapter()`
2. `contentValidator.comprehensiveValidation()` on full manuscript
3. `contentValidator.qualityScore()` on full manuscript
4. Exit when `avgScore >= QUALITY_THRESHOLD` and no critical issues

**Input:**
- `storyId` (string)
- `chapters` (Object[]): Draft chapters from Phase 2
- `worldview` (Object)
- `characters` (Object)

**Output:**
- `chapters` (Object[]): Polished chapters
- `iterationCount` (number): Number of polish iterations performed
- `qualityScores` (Object[]): Quality scores per iteration
- `averageQualityScore` (number): Final average quality score

### `finalEdit`

Builds final editor prompt via `PromptBuilder.buildFinalEditorPrompt()` and delegates to `finalEditor` agent.

**Input:**
- `chapters` (Object[]): Polished chapters

**Output:**
- `content` (string): Final edited manuscript
- `report` (string): Editor's review report

---

## Built-in Step Types Used

| Type | Purpose |
|------|---------|
| `agentCall` | Delegate to a single agent via AgentDispatcher |
| `parallelGroup` | Execute sub-steps in parallel |
| `guard` | Conditional evaluation; fail or checkpoint on condition failure |
| `checkpoint` | Pause workflow for human intervention |

---

## Cross-Step Data Flow ($ref Convention)

All `$ref` paths follow the WorkflowKernel convention:

- `ctx.inputs.<key>` — Workflow inputs provided at start
- `ctx.outputs.<outputKey>` — Step outputs stored by `outputKey`
- `ctx.steps.<stepId>.outputs` — Direct step output access

### Input Contract

When starting the workflow, the following inputs must be provided:

```javascript
{
  storyId: string,        // Story identifier
  storyPrompt: string,    // Original story prompt
  genre: string,          // Story genre
  stylePreference: string,// Style preferences
  targetWordCount: { min: number, max: number },
  targetWords: { min: number, max: number }  // Alias used by some agents
}
```

### Output Contract

After workflow completion (or at checkpoint boundaries), the following outputs are available:

```javascript
{
  worldview: Object,           // Parsed worldview
  characters: Object,          // Parsed characters
  outline: Object,             // Parsed outline
  chaptersResult: Object,      // { chapters, totalWordCount, completedCount }
  polishedChapters: Object[],  // Polished chapters
  finalEditorOutput: Object    // { content, report }
}
```

---

## Checkpoint Points

| Phase | Step ID | Checkpoint Type | Legacy Equivalent |
|-------|---------|-----------------|-------------------|
| Phase 1 | `checkpointPhase1` | `phase1_worldview_confirmation` | Historical phase1 worldview review checkpoint |
| Phase 2 | `checkpointOutline` | `phase2_outline_confirmation` | Historical phase2 outline review checkpoint |
| Phase 2 | `checkpointContent` | `phase2_content_confirmation` | Historical phase2 content review checkpoint |
| Phase 3 | `checkpointFinal` | `final_acceptance` | Historical phase3 final acceptance checkpoint |

---

## Retry and Recovery

### Global Retry Policy

```javascript
{
  maxAttempts: 3,
  backoffDelays: [0, 250, 1000]
}
```

### Phase-Specific Retry Behavior

- **Phase 1:** `storyValidate` attempts one automatic revision if initial validation FAILs.
- **Phase 2 Outline:** `storyValidate` attempts up to 5 outline revisions if validation FAILs.
- **Phase 2 Content:** Individual chapter failures are handled within `produceChapters`; failed chapters are logged but production continues.
- **Phase 3:** Polish loop exits when quality threshold is met or max iterations reached.

### Recovery Actions

The workflow supports the same recovery actions as the legacy engine:
- `continue` — Resume from current state
- `restart_phase` — Restart a specific phase (clears downstream data)
- `rollback` — Rollback to a previous checkpoint

---

## Migration Notes

### What's Changed

1. **Phase classes -> step graph:** Imperative `Phase1_WorldBuilding.run()` style orchestration has been retired and replaced by declarative step definitions.
2. **State management:** WorkflowKernel persists execution cursor and context independently via `StoryStateRepositoryAdapter`.
3. **Event schema:** Kernel emits generic events (`workflow.step_completed`, `workflow.checkpoint_pending`); `StoryEventAdapter` maps to legacy event names for backward compatibility.

### What's Preserved

1. **Agent definitions:** Same agent types (`worldBuilder`, `characterDesigner`, `plotArchitect`, etc.).
2. **Prompt building:** `PromptBuilder` utilities reused by custom step handlers.
3. **Schema validation:** `SchemaValidator` reused unchanged.
4. **Checkpoint semantics:** Same checkpoint types and review semantics are preserved, but timeout continuation is now kernel-owned rather than phase-class owned.
5. **Chapter operations:** `ChapterOperations` methods reused by `produceChapters` and `polishChapters` handlers.
6. **Content validation:** `ContentValidator` methods reused by custom step handlers.

### Feature Switch

```javascript
// config.env
USE_WORKFLOW_KERNEL=true   // Preferred and supported runtime path
USE_WORKFLOW_KERNEL=false  // Compatibility flag only; WorkflowEngine still requires kernel control plane
```

When `WorkflowEngine` initializes, it now installs `StoryOrchestratorKernelAdapter` and delegates supported runtime execution to `WorkflowKernel`. `USE_WORKFLOW_KERNEL` remains readable for diagnostics and rollout bookkeeping, but phase-class fallback runtime is retired and is no longer a supported execution mode.

---

## Known Limitations

1. **Checkpoint rejection handling:** When a checkpoint is rejected, the kernel workflow resumes from the next step. The adapter layer must map rejection to phase re-run (handled in WorkflowEngine's `resume()` method).
2. **Chapter-level retry:** Individual chapter retry (user rejects a specific chapter) requires adapter-level handling to re-run only the affected chapter.
3. **State snapshots:** The kernel uses independent workflow state tables. Cross-compatibility with legacy checkpoint/snapshot tables is handled by `StoryStateRepositoryAdapter`.

---

## Testing

To verify the workflow definition loads correctly:

```javascript
const definition = require('./workflow-definition');
const { WorkflowDefinitionSchema } = require('../../../modules/workflowKernel/types/WorkflowDefinition');
WorkflowDefinitionSchema.validate(definition); // Should not throw
```

To verify step types are registered:

```javascript
const adapter = new StoryOrchestratorKernelAdapter({ ...deps });
await adapter.initialize();
const registered = adapter.kernel.stepRegistry.list();
// Should include: agentCall, checkpoint, guard, loop, parallelGroup, noop,
// parseAgentJson, schemaValidate, storyValidate, generateOutline, parseOutline,
// produceChapters, polishChapters, finalEdit
```
