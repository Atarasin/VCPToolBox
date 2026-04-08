const { AgentDispatcher } = require('./agents/AgentDispatcher');
const { AGENT_TYPES } = require('./agents/AgentDefinitions');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

async function testAgent() {
  console.log('🧪 测试 AgentDispatcher');
  console.log('=' .repeat(60));
  
  const pluginConfigPath = path.join(__dirname, 'config.env');
  let config = {};
  
  if (fs.existsSync(pluginConfigPath)) {
    config = dotenv.parse(fs.readFileSync(pluginConfigPath));
    console.log(`✅ 加载配置: ${pluginConfigPath}`);
  }
  
  const port = process.env.PORT || 6005;
  config.AGENT_ASSISTANT_URL = config.AGENT_ASSISTANT_URL || `http://127.0.0.1:${port}`;
  config.VCP_Key = config.VCP_Key || process.env.VCP_Key || 'aBcDeFgHiJkLmNoP';
  
  console.log('\n📋 Agent 配置:');
  console.log(`  WorldBuilder MODEL_ID: ${config.AGENT_WORLD_BUILDER_MODEL_ID || '未设置'}`);
  console.log(`  CharacterDesigner MODEL_ID: ${config.AGENT_CHARACTER_DESIGNER_MODEL_ID || '未设置'}`);
  console.log(`  URL: ${config.AGENT_ASSISTANT_URL}`);
  console.log(`  VCP_Key: ${config.VCP_Key.substring(0, 8)}...`);
  console.log();
  
  const dispatcher = new AgentDispatcher(config, {});
  
  console.log('🔍 测试单个Agent调用...');
  
  try {
    const result = await dispatcher.delegate(
      AGENT_TYPES.WORLD_BUILDER,
      '请为一个科幻故事生成世界观设定。故事梗概：一个关于AI觉醒的故事。',
      { timeoutMs: 30000, temporaryContact: true }
    );
    
    console.log('✅ Agent调用成功');
    console.log('📦 结果:', result.content.substring(0, 200) + '...');
  } catch (error) {
    console.error('❌ Agent调用失败:', error.message);
  }
}

testAgent();
