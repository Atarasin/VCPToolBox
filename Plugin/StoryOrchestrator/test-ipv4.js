const http = require('http');

async function testIpv4() {
  console.log('🧪 强制IPv4测试');
  console.log('=' .repeat(60));
  
  const payload = JSON.stringify({
    model: 'kimi-k2.6',
    messages: [{ role: 'user', content: '你好' }],
    stream: false
  });
  
  const options = {
    hostname: '127.0.0.1',
    port: 6005,
    path: '/v1/chat/completions',
    method: 'POST',
    family: 4,
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
          console.log('📦 内容:', parsed.choices?.[0]?.message?.content?.substring(0, 100));
        } catch (e) {
          console.log('📦 原始:', data.substring(0, 100));
        }
        resolve();
      });
    });
    
    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      console.error(`❌ 错误 (${elapsed}ms):`, err.message);
      reject(err);
    });
    
    req.setTimeout(30000, () => {
      const elapsed = Date.now() - startTime;
      console.error(`⏱️ 超时 (${elapsed}ms)`);
      req.destroy();
      reject(new Error('Timeout'));
    });
    
    req.write(payload);
    req.end();
  });
}

testIpv4();
