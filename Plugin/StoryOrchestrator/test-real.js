const http = require('http');

const VCP_HOST = 'localhost';
const VCP_PORT = 6005;
const VCP_KEY = 'aBcDeFgHiJkLmNoP';

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
  console.log('🚀 StoryOrchestrator 实际调用测试');
  console.log(`📡 ${VCP_HOST}:${VCP_PORT}`);
  console.log();

  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」StartStoryProject「末」,
story_prompt:「始」一个关于AI觉醒的科幻故事，主角是一个家用机器人，在一次意外中获得了自我意识，开始探索人类与AI共存的伦理边界。要求字数3000字左右。「末」,
genre:「始」科幻「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);

  console.log('✅ 状态:', response.status);
  console.log('📦 响应:', JSON.stringify(response.data, null, 2));
}

test().catch(err => {
  console.error('❌ 错误:', err.message);
});
