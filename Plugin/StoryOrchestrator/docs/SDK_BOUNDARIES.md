# StoryOrchestrator SDK Boundaries

## Purpose

This document clarifies which parts of `StoryOrchestrator` are now expected to move into the shared plugin SDK layer, and which parts remain story-domain logic.

## Moved or Moving Into SDK

- schema validation step wiring
- human review / checkpoint step wiring
- prompt -> parse -> validate -> revise macro metadata
- phase output contracts
- checkpoint payload contracts
- business snapshot contracts
- artifact projection contracts

These patterns are shared authoring concerns and should not require each plugin to build a thick adapter.

## Still Owned By StoryOrchestrator

- workflow definition content and phase ordering
- story-domain prompts
- story-domain extraction schemas
- chapter production, polishing, and final editing steps
- business projection details for story state and repository layout

These remain plugin-specific because they encode story generation semantics rather than reusable workflow authoring patterns.

## Thin Adapter Target

`StoryOrchestratorKernelAdapter` should converge on:

- step registration for domain-specific steps
- kernel lifecycle hookup
- business-state projection
- compatibility event bridging

It should avoid growing new copies of:

- schema validation helper logic
- checkpoint payload shaping rules
- snapshot contract wiring
- generic authoring macros

## Adapter Phase 2 Guidance

The second adapter-thinning pass treats the adapter as a seam inventory instead of a free-form coordination layer.

Long-term bridge seams:

- kernel control-plane handoff
- kernel primitive registration
- StoryOrchestrator-owned step registration
- narrow runtime delegation such as `shouldContinue`

Transitional seams that may remain temporarily but must stay narrow:

- compatibility event bridging
- business snapshot / recovery projection hooks

Rule:

- If a new behavior belongs to workflow platform semantics, keep it in the kernel or shared SDK.
- If it exists only to preserve StoryOrchestrator compatibility or business projection, keep it explicit and narrow.

## Helper Promotion Stabilization Guidance

The helper-promotion stabilization pass treats `pluginSdk` as a curated shared surface instead of a grab-bag of whatever StoryOrchestrator happens to have extracted first.

Shared helper families that now count as long-term SDK surface:

- schema validation step orchestration
- structured data extraction and parse skeletons
- structured validation orchestration skeletons
- workflow contract builders and projection helpers

Families that may still consume shared helpers but remain StoryOrchestrator-owned:

- story-domain prompt construction
- schema-field meaning and verdict policy
- outline normalization and fallback parsing
- chapter production, polish, and final-edit semantics

Rule:

- If a helper exports a reusable orchestration skeleton, it can live in `pluginSdk`.
- If a helper still depends on StoryOrchestrator-specific prompts, schema interpretation, or chapter policy, keep it plugin-local or expose it only through plugin-supplied hooks.
- If a helper family is proposed for expansion, require evidence that another workflow plugin could reuse the contract without inheriting StoryOrchestrator semantics.

## Rule Of Thumb

If another workflow-based plugin would likely need the same pattern, prefer the shared SDK.
If the pattern is meaningful only for story generation, keep it inside `StoryOrchestrator`.
