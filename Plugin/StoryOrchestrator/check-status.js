const http = require('http');

const storyId = 'story-f05196fdccfb';

function queryStatus() {
  return new Promise((resolve, reject) => {
    const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」${storyId}「末」
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

async function check() {
  console.log(`🔍 查询故事 ${storyId} 状态...`);
  const status = await queryStatus();
  console.log(JSON.stringify(status, null, 2));
}

check();
