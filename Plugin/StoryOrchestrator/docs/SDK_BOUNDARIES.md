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

## Rule Of Thumb

If another workflow-based plugin would likely need the same pattern, prefer the shared SDK.
If the pattern is meaningful only for story generation, keep it inside `StoryOrchestrator`.
