const http = require('http');

async function testWithAgent() {
  console.log('🧪 使用http.Agent禁用Keep-Alive');
  console.log('=' .repeat(60));
  
  const payload = JSON.stringify({
    model: 'volc-doubao-seed-2.0-pro',
    messages: [
      { role: 'system', content: '你是专业的世界观设定师。' },
      { role: 'user', content: '请为一个科幻故事生成世界观设定。' }
    ],
    temperature: 0.8,
    max_tokens: 3000,
    stream: false
  });
  
  const agent = new http.Agent({
    keepAlive: false,
    maxSockets: 1
  });
  
  const options = {
    hostname: 'localhost',
    port: 6005,
    path: '/v1/chat/completions',
    method: 'POST',
    agent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer aBcDeFgHiJkLmNoP',
      'Content-Length': Buffer.byteLength(payload),
      'Connection': 'close'
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
        agent.destroy();
        resolve();
      });
    });
    
    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      console.error(`❌ 错误 (${elapsed}ms):`, err.message);
      agent.destroy();
      reject(err);
    });
    
    req.setTimeout(30000, () => {
      const elapsed = Date.now() - startTime;
      console.error(`⏱️ 超时 (${elapsed}ms)`);
      req.destroy();
      agent.destroy();
      reject(new Error('Timeout'));
    });
    
    req.write(payload);
    req.end();
  });
}

testWithAgent();
