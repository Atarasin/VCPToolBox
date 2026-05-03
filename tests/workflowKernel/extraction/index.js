const fs = require('fs');
const path = require('path');

function loadTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadTests(fullPath);
    } else if (entry.name.endsWith('.test.js')) {
      require(fullPath);
    }
  }
}

loadTests(__dirname);
