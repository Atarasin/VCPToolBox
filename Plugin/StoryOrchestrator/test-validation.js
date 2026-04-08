const { validateInput } = require('./utils/ValidationSchemas');

const testData = {
  story_id: 'story-test',
  checkpoint_id: 'cp-test',
  approval: 'true',
  feedback: ''
};

console.log('测试数据:', testData);
console.log('approval类型:', typeof testData.approval);

const result = validateInput('userConfirmCheckpoint', testData);

console.log('验证结果:', result);
console.log('转换后的approval:', testData.approval);
console.log('转换后的approval类型:', typeof testData.approval);
