const http = require('http');

const VCP_HOST = '127.0.0.1';
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
      family: 4,
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

async function startStory() {
  console.log('🚀 启动故事创作项目...\n');
  
  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」StartStoryProject「末」,
story_prompt:「始」一个关于AI觉醒的科幻故事，主角是一个家用机器人，在一次意外中获得了自我意识，开始探索人类与AI共存的伦理边界。要求3000字左右。「末」,
genre:「始」科幻「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);
  console.log('✅ 故事项目已创建');
  console.log('📦 响应:', JSON.stringify(response.data, null, 2));
  
  if (response.data?.result?.story_id) {
    return response.data.result.story_id;
  }
  throw new Error('Failed to create story');
}

async function queryStatus(storyId) {
  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」${storyId}「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);
  return response.data;
}

async function confirmCheckpoint(storyId, checkpointId) {
  console.log(`\n✅ 确认检查点: ${checkpointId}\n`);
  
  const toolRequest = `<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」${storyId}「末」,
checkpoint_id:「始」${checkpointId}「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>`;

  const response = await makeToolCall(toolRequest);
  console.log('📦 响应:', JSON.stringify(response.data, null, 2));
  return response.data;
}

async function waitForCheckpoint(storyId, maxAttempts = 30) {
  console.log(`\n⏳ 等待检查点 (最多${maxAttempts}次查询)...`);
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const status = await queryStatus(storyId);
    
    console.log(`\n📊 第${i + 1}次查询:`);
    console.log(`   阶段: ${status.result?.phase_name}`);
    console.log(`   状态: ${status.result?.status}`);
    console.log(`   进度: ${status.result?.progress_percent}%`);
    
    if (status.result?.checkpoint_pending && status.result?.checkpoint_id) {
      console.log(`   📝 发现检查点: ${status.result.checkpoint_id}`);
      return { hasCheckpoint: true, checkpointId: status.result.checkpoint_id, status };
    }
    
    if (status.result?.status?.includes('completed')) {
      console.log('\n🎉 故事创作完成！');
      return { hasCheckpoint: false, completed: true, status };
    }
    
    if (status.result?.status?.includes('failed')) {
      console.log('\n❌ 故事创作失败');
      return { hasCheckpoint: false, failed: true, status };
    }
  }
  
  return { hasCheckpoint: false, status: await queryStatus(storyId) };
}

async function runFullWorkflow() {
  console.log('🎬 StoryOrchestrator 完整工作流程测试');
  console.log('=' .repeat(60));
  console.log(`📡 服务器: ${VCP_HOST}:${VCP_PORT}`);
  console.log('=' .repeat(60));

  try {
    // 步骤1: 启动故事
    const storyId = await startStory();
    
    // 步骤2: 等待Phase1完成
    const phase1Result = await waitForCheckpoint(storyId, 30);
    if (phase1Result.hasCheckpoint) {
      await confirmCheckpoint(storyId, phase1Result.checkpointId);
    }
    
    // 步骤3: 等待Phase2完成
    const phase2Result = await waitForCheckpoint(storyId, 40);
    if (phase2Result.hasCheckpoint) {
      await confirmCheckpoint(storyId, phase2Result.checkpointId);
    }
    
    // 步骤4: 等待Phase3完成
    const phase3Result = await waitForCheckpoint(storyId, 40);
    if (phase3Result.hasCheckpoint) {
      await confirmCheckpoint(storyId, phase3Result.checkpointId);
    }
    
    // 最终状态
    console.log('\n📊 最终状态:');
    const finalStatus = await queryStatus(storyId);
    console.log(JSON.stringify(finalStatus, null, 2));
    
    if (finalStatus?.result?.status?.includes('completed')) {
      console.log('\n🎉 故事创作全流程完成！');
      console.log(`📖 Story ID: ${storyId}`);
    } else {
      console.log('\n⚠️ 流程未完成');
    }
    
  } catch (error) {
    console.error('\n❌ 错误:', error.message);
  }
}

runFullWorkflow();
