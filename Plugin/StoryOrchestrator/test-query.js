const http = require('http');

const VCP_HOST = 'localhost';
const VCP_PORT = 6005;
const VCP_KEY = 'aBcDeFgHiJkLmNoP';
const STORY_ID = process.argv[2] || 'story-d5da0893c5f9';

function makeToolCall(toolRequestText) {
  return new Promise((resolve, reject) => {
    const postData = toolRequestText;
    const options = {
      hostname: VCP_HOST,
      port: VCP_PORT,
      path: '/v1/human/tool',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': `Bearer ${VCP_KEY}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(responseData) });
        } catch {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function test() {
  console.log('🔍 StoryOrchestrator 查询状态');
  console.log(`📡 ${VCP_HOST}:${VCP_PORT}`);
  console.log(`📖 Story ID: ${STORY_ID}`);
  console.log();

  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」${STORY_ID}「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);

  console.log('✅ 状态:', response.status);
  console.log('📦 响应:', JSON.stringify(response.data, null, 2));
}

test().catch(err => {
  console.error('❌ 错误:', err.message);
});
