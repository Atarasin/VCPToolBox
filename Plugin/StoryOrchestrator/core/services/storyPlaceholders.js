'use strict';

const {
  calculateProgress,
  getPhaseName
} = require('./storyProjection');

async function getPlaceholderValue(orchestrator, placeholder) {
  if (placeholder === 'StoryOrchestratorStatus') {
    const stories = await orchestrator.stateManager.listStories();
    const activeStories = [];

    for (const storyId of stories.slice(0, 5)) {
      const story = await orchestrator.stateManager.getStory(storyId);
      if (story && !story.finalOutput) {
        activeStories.push({
          id: storyId,
          phase: getPhaseName(story),
          progress: calculateProgress(story)
        });
      }
    }

    return JSON.stringify(activeStories, null, 2);
  }

  if (placeholder === 'StoryBible') {
    const stories = await orchestrator.stateManager.listStories();
    const activeStories = [];

    for (const storyId of stories.slice(0, 3)) {
      const story = await orchestrator.stateManager.getStory(storyId);
      if (story && !story.finalOutput && (story.phase1?.worldview || story.phase1?.characters)) {
        activeStories.push({
          id: storyId,
          genre: story.genre,
          worldview: story.phase1?.worldview || null,
          characters: story.phase1?.characters || null,
          plot_outline: story.phase2?.outline || null
        });
      }
    }

    if (activeStories.length === 0) {
      return 'No active story projects with bible data';
    }
    return JSON.stringify(activeStories, null, 2);
  }

  return null;
}

module.exports = {
  getPlaceholderValue
};
