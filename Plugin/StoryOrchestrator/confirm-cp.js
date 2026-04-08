const http = require('http');

const storyId = 'story-f05196fdccfb';
const checkpointId = 'cp-phase1-story-f05196fdccfb-1775484091633';

function confirmCheckpoint() {
  return new Promise((resolve, reject) => {
    const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」${storyId}「末」,
checkpoint_id:「始」${checkpointId}「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>`;

    const postData = toolRequest;
    const options = {
      hostname: '127.0.0.1',
      port: 6005,
      path: '/v1/human/tool',
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': 'Bearer aBcDeFgHiJkLmNoP',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('✅ 确认Phase1检查点...');
  const result = await confirmCheckpoint();
  console.log('结果:', JSON.stringify(result, null, 2));
}

main();
