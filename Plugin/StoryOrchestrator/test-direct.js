const http = require('http');

const VCP_HOST = 'localhost';
const VCP_PORT = 6005;
const VCP_KEY = 'aBcDeFgHiJkLmNoP';

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

async function testDirectToolCall() {
  console.log('🚀 StoryOrchestrator 工具调用测试');
  console.log(`📡 ${VCP_HOST}:${VCP_PORT}`);
  console.log();

  // 直接调用工具接口
  const response = await makeRequest('/v1/human/tool', {
    tool_name: 'StoryOrchestrator',
    command: 'StartStoryProject',
    story_prompt: '一个关于AI觉醒的科幻故事，主角是一个家用机器人，在一次意外中获得了自我意识，开始探索人类与AI共存的伦理边界',
    target_word_count: 3000,
    genre: '科幻'
  });

  console.log('✅ 状态:', response.status);
  console.log('📦 响应:', JSON.stringify(response.data, null, 2));
}

testDirectToolCall().catch(err => {
  console.error('❌ 错误:', err.message);
});
