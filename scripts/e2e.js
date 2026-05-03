#!/usr/bin/env node
const { spawn } = require('child_process');
const child = spawn('node', ['--test', 'Plugin/StoryOrchestrator/tests/e2e-real.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, RUN_E2E_TESTS: '1' }
});
child.on('exit', code => process.exit(code ?? 0));
