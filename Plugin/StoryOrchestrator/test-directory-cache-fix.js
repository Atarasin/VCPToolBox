const fs = require('fs').promises;
const path = require('path');
const { StateManager } = require('./core/StateManager');

async function runTests() {
  console.log('=== StateManager Directory and Cache Fix Tests ===\n');

  const stateDir = path.join(__dirname, 'state');
  const storiesDir = path.join(stateDir, 'stories');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      passed++;
      console.log('  PASS:', message);
    } else {
      failed++;
      console.error('  FAIL:', message);
    }
  }

  async function dirExists(dir) {
    try {
      await fs.access(dir);
      return true;
    } catch {
      return false;
    }
  }

  async function fileExists(file) {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  const stateManager = new StateManager();
  await stateManager.initialize();

  const story1 = await stateManager.createStory('Test story 1', { genre: 'test' });
  assert(story1 && story1.id, 'First story created successfully');

  await fs.rm(storiesDir, { recursive: true, force: true });
  assert(!(await dirExists(storiesDir)), 'state/stories directory is deleted');

  try {
    const story2 = await stateManager.createStory('Test story 2', { genre: 'test' });
    assert(story2 && story2.id, 'Second story created after directory deletion');
    assert(await fileExists(path.join(storiesDir, `${story2.id}.json`)), 'JSON file exists for second story');
  } catch (e) {
    assert(false, `Second story creation failed: ${e.message}`);
  }

  const story3 = await stateManager.createStory('Test story 3', { genre: 'test' });
  assert(stateManager.cache.has(story3.id), 'Story 3 is in cache after creation');

  const cachedStory = await stateManager.getStory(story3.id);
  assert(cachedStory && cachedStory.id === story3.id, 'getStory returns cached story before deletion');

  stateManager.repository.deleteStory(story3.id);
  const story3AfterDelete = await stateManager.getStory(story3.id);
  assert(story3AfterDelete === null, 'getStory returns null after story deleted from database');
  assert(!stateManager.cache.has(story3.id), 'Story 3 is removed from cache after DB deletion');

  try {
    await fs.rm(stateDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
