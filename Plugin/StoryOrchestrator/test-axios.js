const axios = require('axios');

async function testDirectCall() {
  console.log('🧪 直接axios调用测试');
  console.log('=' .repeat(60));
  
  const payload = {
    model: 'volc-doubao-seed-2.0-pro',
    messages: [
      { role: 'system', content: '你是专业的世界观设定师。' },
      { role: 'user', content: '请为一个科幻故事生成世界观设定。故事梗概：一个关于AI觉醒的故事。' }
    ],
    temperature: 0.8,
    max_tokens: 3000,
    stream: false
  };
  
  console.log('📤 请求payload:', JSON.stringify(payload, null, 2));
  console.log('🌐 URL: http://localhost:6005/v1/chat/completions');
  console.log();
  
  try {
    const response = await axios.post(
      'http://localhost:6005/v1/chat/completions',
      payload,
      {
        headers: {
          'Authorization': 'Bearer aBcDeFgHiJkLmNoP',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    console.log('✅ 成功！');
    console.log('📊 状态:', response.status);
    console.log('📦 内容:', response.data.choices?.[0]?.message?.content?.substring(0, 200));
  } catch (error) {
    console.error('❌ 失败:', error.message);
    if (error.response) {
      console.error('📊 状态:', error.response.status);
      console.error('📦 响应:', error.response.data);
    }
  }
}

testDirectCall();
