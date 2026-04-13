const StoryOrchestrator = require('./core/StoryOrchestrator');

async function runPanelCompatibilityTests() {
  console.log('=== Panel API Compatibility Smoke Tests ===\n');

  await StoryOrchestrator.initialize({}, {});

  const story = await StoryOrchestrator.stateManager.createStory('Test story for panel API', {
    target_word_count: { min: 2000, max: 3000 },
    genre: 'fantasy'
  });

  const storyId = story.id;

  await StoryOrchestrator.stateManager.updatePhase1(storyId, {
    worldview: {
      setting: 'A magical kingdom',
      rules: { physical: 'Normal physics', special: 'Magic exists', limitations: 'Magic consumes mana' },
      factions: [{ name: 'Royal Guard', description: 'Protectors' }],
      history: { keyEvents: ['The Great War'], coreConflicts: ['Magic vs Technology'] },
      sceneNorms: ['Castles', 'Forests'],
      secrets: ['Hidden throne']
    },
    characters: {
      protagonists: [{ name: 'Elena', identity: 'Princess' }],
      supportingCharacters: [],
      antagonists: [],
      relationshipNetwork: { direct: [], hidden: [] },
      oocRules: {}
    },
    status: 'pending_confirmation'
  });

  await StoryOrchestrator.stateManager.setActiveCheckpoint(storyId, {
    id: 'cp-panel-test',
    phase: 'phase1',
    type: 'worldview_confirmation',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString()
  });

  const resGetStory = { json: (data) => data };
  const res404 = { status: (code) => ({ json: (data) => ({ code, ...data }) }) };

  async function mockGetStory(id) {
    const data = await StoryOrchestrator.stateManager.getStory(id);
    if (!data) return res404.status(404).json({ success: false, error: 'Story not found' });
    return resGetStory.json({ success: true, story: data });
  }

  async function mockGetWorldview(id) {
    const data = await StoryOrchestrator.stateManager.getStory(id);
    if (!data) return res404.status(404).json({ success: false, error: 'Story not found' });
    return resGetStory.json({
      success: true,
      worldview: data.phase1?.worldview || null,
      phase1Status: data.phase1?.status || 'pending',
      userConfirmed: data.phase1?.userConfirmed || false
    });
  }

  async function mockGetCharacters(id) {
    const data = await StoryOrchestrator.stateManager.getStory(id);
    if (!data) return res404.status(404).json({ success: false, error: 'Story not found' });
    let characters = [];
    const charData = data.phase1?.characters;
    if (charData && charData.protagonists) characters = characters.concat(charData.protagonists);
    if (charData && charData.supportingCharacters) characters = characters.concat(charData.supportingCharacters);
    if (charData && charData.antagonists) characters = characters.concat(charData.antagonists);
    return resGetStory.json({
      success: true,
      characters,
      total: characters.length,
      categories: {
        protagonists: (charData?.protagonists || []).length,
        supporting: (charData?.supportingCharacters || []).length,
        antagonists: (charData?.antagonists || []).length
      }
    });
  }

  async function mockGetHistory(id) {
    const data = await StoryOrchestrator.stateManager.getStory(id);
    if (!data) return res404.status(404).json({ success: false, error: 'Story not found' });
    return resGetStory.json({
      success: true,
      history: data.workflow?.history || [],
      currentState: data.workflow?.state || 'idle',
      currentPhase: data.workflow?.currentPhase || null,
      activeCheckpoint: data.workflow?.activeCheckpoint || null
    });
  }

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) { passed++; console.log('  PASS:', message); }
    else { failed++; console.error('  FAIL:', message); }
  }

  const s1 = await mockGetStory(storyId);
  assert(s1.success && s1.story.id === storyId, 'GET /stories/:id returns story');

  const w1 = await mockGetWorldview(storyId);
  assert(w1.success && w1.worldview && w1.worldview.setting === 'A magical kingdom', 'GET /stories/:id/worldview returns worldview');
  assert(w1.phase1Status === 'pending_confirmation', 'worldview API returns phase1Status');

  const c1 = await mockGetCharacters(storyId);
  assert(c1.success && c1.characters.length === 1 && c1.characters[0].name === 'Elena', 'GET /stories/:id/characters returns characters');
  assert(c1.categories.protagonists === 1, 'characters API returns categories');

  const h1 = await mockGetHistory(storyId);
  assert(h1.success && Array.isArray(h1.history), 'GET /stories/:id/history returns history array');
  assert(h1.activeCheckpoint && h1.activeCheckpoint.id === 'cp-panel-test', 'history API returns activeCheckpoint');

  const pwStory = await StoryOrchestrator.stateManager.createStory('PASS_WITH_WARNINGS panel test', { genre: 'test' });
  await StoryOrchestrator.stateManager.setActiveCheckpoint(pwStory.id, {
    id: 'cp-pw-panel',
    phase: 'phase1',
    type: 'worldview_confirmation',
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  const pwData = await StoryOrchestrator.stateManager.getStory(pwStory.id);
  assert(pwData.workflow.activeCheckpoint && pwData.workflow.activeCheckpoint.id === 'cp-pw-panel', 'Panel can read PASS_WITH_WARNINGS checkpoint');
  await StoryOrchestrator.stateManager.deleteStory(pwStory.id);

  await StoryOrchestrator.stateManager.deleteStory(storyId);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runPanelCompatibilityTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
