const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ensureDiaryAllowed
} = require('../../../modules/agentGateway/policy/diaryScopeGuard');

test('ensureDiaryAllowed exposes allowed diaries in forbidden error details', () => {
    assert.throws(
        () => ensureDiaryAllowed({
            policy: {
                allowedDiaryNames: ['Nova', 'SharedMemory']
            },
            diaryName: 'ProjectAlpha',
            authContext: {
                agentId: 'Ariadne',
                sessionId: 'sess-diary-scope-guard',
                requestId: 'req-diary-scope-guard'
            }
        }),
        (error) => {
            assert.match(error.message, /Requested diary: ProjectAlpha\./);
            assert.match(error.message, /Allowed diaries: Nova, SharedMemory\./);
            assert.equal(error.code, 'AGW_FORBIDDEN');
            assert.deepEqual(error.details.allowedDiaries, ['Nova', 'SharedMemory']);
            assert.equal(error.details.diary, 'ProjectAlpha');
            assert.equal(error.details.agentId, 'Ariadne');
            return true;
        }
    );
});
