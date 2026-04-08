const http = require('http');

async function testHttpCall() {
  console.log('🧪 Node.js http模块调用测试');
  console.log('=' .repeat(60));
  
  const payload = JSON.stringify({
    model: 'volc-doubao-seed-2.0-pro',
    messages: [
      { role: 'system', content: '你是专业的世界观设定师。' },
      { role: 'user', content: '请为一个科幻故事生成世界观设定。故事梗概：一个关于AI觉醒的故事。' }
    ],
    temperature: 0.8,
    max_tokens: 3000,
    stream: false
  });
  
  console.log('🌐 URL: http://localhost:6005/v1/chat/completions');
  console.log('⏱️ 超时: 30秒');
  console.log();
  
  const options = {
    hostname: 'localhost',
    port: 6005,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer aBcDeFgHiJkLmNoP',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        console.log(`✅ 收到响应 (${elapsed}ms)`);
        console.log('📊 状态:', res.statusCode);
        try {
          const parsed = JSON.parse(data);
          console.log('📦 内容:', parsed.choices?.[0]?.message?.content?.substring(0, 200));
        } catch (e) {
          console.log('📦 原始:', data.substring(0, 200));
        }
        resolve();
      });
    });
    
    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      console.error(`❌ 错误 (${elapsed}ms):`, err.message);
      reject(err);
    });
    
    req.on('timeout', () => {
      const elapsed = Date.now() - startTime;
      console.error(`⏱️ 超时 (${elapsed}ms)`);
      req.destroy();
      reject(new Error('Timeout'));
    });
    
    req.setTimeout(30000);
    req.write(payload);
    req.end();
  });
}

testHttpCall();
