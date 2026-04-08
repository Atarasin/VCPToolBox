const http = require('http');

const VCP_HOST = process.env.VCP_HOST || 'localhost';
const VCP_PORT = process.env.VCP_PORT || 5890;
const VCP_KEY = process.env.VCP_KEY || 'test-key';

function makeRequest(path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const options = {
      hostname: VCP_HOST,
      port: VCP_PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

  const response = await makeRequest('/v1/chat/completions', {
    model: 'story-orchestrator',
    messages: [{
      role: 'user',
      content: '<<<[TOOL_REQUEST]>>>\n' +
        'tool_name:「始」StoryOrchestrator「末」,\n' +
        'command:「始」StartStoryProject「末」,\n' +
        'story_prompt:「始」一个关于AI觉醒的科幻故事，主角是一个家用机器人，在一次意外中获得了自我意识，开始探索人类与AI共存的伦理边界「末」,\n' +
        'target_word_count:「始」3000「末」,\n' +
        'genre:「始」科幻「末」\n' +
        '<<<[END_TOOL_REQUEST]>>>'
    }],
    stream: false
  });

  console.log('✅ 状态:', response.status);
  console.log('📦 响应:', JSON.stringify(response.data, null, 2));
}

test().catch(err => {
  console.error('❌ 错误:', err.message);
  console.log('💡 请确保服务器运行: node server.js');
});
