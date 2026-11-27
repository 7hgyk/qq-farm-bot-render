const test = require('node:test');
const assert = require('node:assert/strict');

const { createAutoReloginService } = require('../dist/runtime/auto-relogin.js');
const { wxLoginTaskManager } = require('../dist/services/wx-login/task-manager.js');

function buildHarness(overrides = {}) {
    const account = {
        id: '9',
        name: '测试号',
        code: 'old-code',
        platform: 'wx',
        uin: '',
        qq: '',
        avatar: '',
        createdAt: 1,
        updatedAt: 1,
        ...(overrides.withCredential === false ? {} : {
            wxCredential: {
                openid: 'fake-openid',
                accessToken: 'fake-access',
                refreshToken: 'fake-refresh',
                expiresAt: Date.now() + 3600_000,
                loginType: 'WX',
            },
        }),
    };
    const logs = [];
    const store = {
        getAutoRelogin: () => overrides.config || { enabled: true, intervalsSec: [1, 1, 1] },
        getOfflineReminder: () => ({ channels: [] }),
        getAccounts: () => ({ accounts: [account], nextId: 10 }),
        addOrUpdateAccount: (patch) => Object.assign(account, patch),
    };
    const service = createAutoReloginService({
        store,
        log: (tag, message) => logs.push(`${tag}: ${message}`),
        addAccountLog: () => {},
        startAccountWorker: async () => true,
    });
    return { account, logs, service };
}

test('auto relogin retries with configured intervals and falls back to a QR code after three failures', async () => {
    const originalRefresh = wxLoginTaskManager.service.refreshCredential;
    const originalBuffer = wxLoginTaskManager.service.fetchLoginBuffer;
    const originalCreate = wxLoginTaskManager.createTask;
    wxLoginTaskManager.service.refreshCredential = async () => { throw new Error('refresh rejected'); };
    wxLoginTaskManager.service.fetchLoginBuffer = async () => { throw new Error('buffer rejected'); };
    wxLoginTaskManager.createTask = async () => { throw new Error('qr offline'); };
    const { logs, service } = buildHarness();
    try {
        service.schedule({ accountId: '9', accountName: '测试号', reason: 'disconnect:test' });
        await new Promise(resolve => setTimeout(resolve, 4200));
        assert.equal(logs.filter(line => line.includes('自动重连失败（第')).length, 3);
        assert.ok(logs.some(line => line.includes('生成登录二维码失败')), 'should try to create a QR code after retries');
        assert.ok(logs.some(line => line.includes('启动应用宝自动重连')));
    } finally {
        wxLoginTaskManager.service.refreshCredential = originalRefresh;
        wxLoginTaskManager.service.fetchLoginBuffer = originalBuffer;
        wxLoginTaskManager.createTask = originalCreate;
    }
});

test('auto relogin does nothing when disabled in settings', async () => {
    const { logs, service } = buildHarness({ config: { enabled: false, intervalsSec: [1, 1, 1] } });
    service.schedule({ accountId: '9', accountName: '测试号', reason: 'disconnect:test' });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(logs.filter(line => line.includes('自动重连失败')).length, 0);
    assert.ok(logs.some(line => line.includes('自动重连已关闭')));
});
