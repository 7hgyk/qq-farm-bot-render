const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSkipOfflineReminder } = require('../dist/runtime/relogin-reminder.js');

test('自动重连开启时，被踢与断线提醒交给二维码推送，不重复发下线提醒', () => {
    assert.equal(shouldSkipOfflineReminder('kickout:kicked', true), true);
    assert.equal(shouldSkipOfflineReminder('disconnect:ws_close:online:1006', true), true);
});

test('自动重连关闭时，掉线提醒照常发送', () => {
    assert.equal(shouldSkipOfflineReminder('kickout:kicked', false), false);
    assert.equal(shouldSkipOfflineReminder('disconnect:ws_close:online:1006', false), false);
});

test('离线超时等其他提醒不受自动重连影响', () => {
    assert.equal(shouldSkipOfflineReminder('offline_timeout', true), false);
    assert.equal(shouldSkipOfflineReminder('', true), false);
    assert.equal(shouldSkipOfflineReminder(undefined, true), false);
});
