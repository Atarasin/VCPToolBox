const http = require('http');

const VCP_HOST = 'localhost';
const VCP_PORT = process.env.VCP_PORT || 6005;
const VCP_KEY = process.env.VCP_Key || 'aBcDeFgHiJkLmNoP';

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

async function startStoryProject() {
  console.log('🚀 启动故事创作项目...');
  console.log('=' .repeat(60));
  
  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」StartStoryProject「末」,
story_prompt:「始」一个关于AI觉醒的科幻故事，主角是一个家用机器人，在一次意外中获得了自我意识，开始探索人类与AI共存的伦理边界。要求字数3000字左右。「末」,
genre:「始」科幻「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);
  console.log('状态:', response.status);
  console.log('响应:', JSON.stringify(response.data, null, 2));
  
  if (response.data?.status === 'success' && response.data?.result?.story_id) {
    return response.data.result.story_id;
  }
  throw new Error('Failed to start story project');
}

async function queryStoryStatus(storyId) {
  console.log('\n🔍 查询故事状态...');
  console.log('=' .repeat(60));
  
  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」${storyId}「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);
  console.log('状态:', response.status);
  console.log('响应:', JSON.stringify(response.data, null, 2));
  
  return response.data;
}

async function confirmCheckpoint(storyId, checkpointId) {
  console.log('\n✅ 确认检查点...');
  console.log('=' .repeat(60));
  
  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」${storyId}「末」,
checkpoint_id:「始」${checkpointId}「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);
  console.log('状态:', response.status);
  console.log('响应:', JSON.stringify(response.data, null, 2));
  
  return response.data;
}

async function waitAndQuery(storyId, iterations = 3, delayMs = 5000) {
  console.log(`\n⏳ 等待 ${delayMs/1000} 秒后查询状态...`);
  
  for (let i = 0; i < iterations; i++) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const status = await queryStoryStatus(storyId);
    
    if (status?.result?.checkpoint_pending && status?.result?.checkpoint_id) {
      console.log('\n📝 发现检查点，需要用户确认');
      return { hasCheckpoint: true, checkpointId: status.result.checkpoint_id, status };
    }
    
    if (status?.result?.status?.includes('completed')) {
      console.log('\n🎉 故事创作完成！');
      return { hasCheckpoint: false, completed: true, status };
    }
    
    if (status?.result?.status?.includes('failed')) {
      console.log('\n❌ 故事创作失败');
      return { hasCheckpoint: false, failed: true, status };
    }
  }
  
  return { hasCheckpoint: false, status: await queryStoryStatus(storyId) };
}

async function runFullWorkflow() {
  console.log('🎬 StoryOrchestrator 完整工作流程测试');
  console.log('=' .repeat(60));
  console.log(`📡 服务器: ${VCP_HOST}:${VCP_PORT}`);
  console.log('=' .repeat(60));
  console.log();

  try {
    const storyId = await startStoryProject();
    console.log(`\n✨ 故事项目已创建: ${storyId}`);
    
    let phase1Result = await waitAndQuery(storyId, 3, 5000);
    
    if (phase1Result.hasCheckpoint) {
      console.log('\n📍 第一阶段完成，等待确认检查点...');
      await confirmCheckpoint(storyId, phase1Result.checkpointId);
      
      let phase2Result = await waitAndQuery(storyId, 3, 5000);
      
      if (phase2Result.hasCheckpoint) {
        console.log('\n📍 第二阶段完成，等待确认检查点...');
        await confirmCheckpoint(storyId, phase2Result.checkpointId);
        
        let phase3Result = await waitAndQuery(storyId, 3, 5000);
        
        if (phase3Result.hasCheckpoint) {
          console.log('\n📍 第三阶段完成，等待最终确认...');
          await confirmCheckpoint(storyId, phase3Result.checkpointId);
        }
      }
    }
    
    console.log('\n📊 最终状态:');
    const finalStatus = await queryStoryStatus(storyId);
    
    if (finalStatus?.result?.status?.includes('completed')) {
      console.log('\n🎉 故事创作全流程完成！');
    } else {
      console.log('\n⚠️ 故事创作仍在进行中或遇到问题');
    }
    
    console.log('\n✅ 测试完成');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.log('\n💡 可能的原因:');
    console.log('   - VCPToolBox服务器未运行');
    console.log('   - 插件配置不正确');
    console.log('   - Agent模型服务端点不可用');
    process.exit(1);
  }
}

runFullWorkflow();
