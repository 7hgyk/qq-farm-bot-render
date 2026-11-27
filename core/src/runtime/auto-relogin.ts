import type { Account, WxCredential } from '../types/account';
import { getNativeWxLoginCode } from '../services/wx-login/native-protocol';
import { describeError } from '../services/wx-login/net';
import { wxLoginTaskManager } from '../services/wx-login/task-manager';
import type { LoginTask } from '../services/wx-login/task-manager';
const { CONFIG } = require('../config/config');
const { readPushChannels } = require('../config/push-channels');
const { sendPushChannels } = require('../services/push');

export { };

/**
 * 应用宝免扫码自动重连。
 *
 * 掉线（断线 / 被踢）后按设置的间隔重试：
 *   第 1 次 3s、第 2 次 60s、第 3 次 180s（默认，可在设置里调整）。
 * 每次重试用扫码得到的 openid / access_token / refresh_token 重新取
 * 应用宝 login_buffer，再换游戏 Code 拉起账号。
 * 三次都失败则生成新的登录二维码，通过已启用的推送渠道（默认 PushPlus）
 * 推送给用户；用户在手机微信扫码后，服务端自动换取新凭据并重新登录。
 */

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const SCAN_POLL_INTERVAL_MS = 2000;
const SCAN_POLL_MAX_MS = 5 * 60 * 1000;
const TOTAL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BUFFER_REUSE_MS = 10 * 60 * 1000;

interface AutoReloginDeps {
    store: any;
    log: (tag: string, message: string, extra?: any) => void;
    addAccountLog: (type: string, message: string, accountId?: string, accountName?: string, extra?: any) => void;
    startAccountWorker: (account: any) => void | boolean | Promise<void | boolean>;
    isAccountRunning?: (accountId: string) => boolean;
}

interface ReloginState {
    accountId: string;
    accountName: string;
    reason: string;
    startedAt: number;
    cancelled: boolean;
    scanTaskId?: string;
    /** 已完成的换票次数，用于网络抖动时重试而不是直接作废二维码。 */
    confirmAttempts?: number;
    /** HTTP 换票（login_buffer）是否已成功，成功后不再重复调用。 */
    confirmed?: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function publicBaseUrl(): string {
    const configured = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || process.env.FARM_PUBLIC_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const port = Number(CONFIG.adminPort) || 3007;
    return `http://127.0.0.1:${port}`;
}

function findAccount(store: any, accountId: string): Account | null {
    const data = store.getAccounts();
    return (data.accounts || []).find((item: Account) => String(item.id) === String(accountId)) || null;
}

function normalizeCredential(raw: any): WxCredential | null {
    if (!raw || typeof raw !== 'object') return null;
    const openid = String(raw.openid || '').trim();
    const accessToken = String(raw.accessToken || '').trim();
    if (!openid || !accessToken) return null;
    return {
        openid,
        accessToken,
        refreshToken: String(raw.refreshToken || ''),
        expiresAt: Number(raw.expiresAt) || 0,
        loginType: String(raw.loginType || 'WX'),
        ...(raw.loginBuffer ? { loginBuffer: String(raw.loginBuffer) } : {}),
        ...(raw.loginBufferAt ? { loginBufferAt: Number(raw.loginBufferAt) } : {}),
    };
}

function createAutoReloginService(deps: AutoReloginDeps) {
    const { store, log, addAccountLog, startAccountWorker } = deps;
    const states = new Map<string, ReloginState>();
    const service = wxLoginTaskManager.service;

    function config() {
        try {
            return store.getAutoRelogin ? store.getAutoRelogin() : { enabled: true, intervalsSec: [3, 60, 180] };
        } catch {
            return { enabled: true, intervalsSec: [3, 60, 180] };
        }
    }

    function isRunning(accountId: string): boolean {
        try {
            return typeof deps.isAccountRunning === 'function' && deps.isAccountRunning(accountId);
        } catch {
            return false;
        }
    }

    function persistCredential(accountId: string, credential: WxCredential): void {
        store.addOrUpdateAccount({ id: accountId, wxCredential: credential });
    }

    function applyLogin(account: Account, code: string, credential: WxCredential): Account | null {
        store.addOrUpdateAccount({
            id: account.id,
            code,
            platform: 'wx',
            wxCredential: credential,
        });
        return findAccount(store, account.id);
    }

    /** 用保存的凭据重新换取游戏 Code；必要时先刷新 access_token。 */
    async function rebuildCode(account: Account): Promise<{ code: string; credential: WxCredential }> {
        let credential = normalizeCredential(account.wxCredential);
        if (!credential) throw new Error('账号没有应用宝扫码凭据');

        // 先试最近保存的 login_buffer，通常掉线后几分钟内仍然可用。
        if (credential.loginBuffer && Date.now() - (credential.loginBufferAt || 0) < LOGIN_BUFFER_REUSE_MS) {
            try {
                const code = await getNativeWxLoginCode(credential.loginBuffer, TARGET_APP_ID);
                if (code) return { code, credential };
            } catch {
                // 缓存票据失效，走刷新流程。
            }
        }

        const needsRefresh = !credential.accessToken
            || (credential.expiresAt > 0 && Date.now() > credential.expiresAt - 5 * 60 * 1000);
        if (needsRefresh && credential.refreshToken) {
            credential = await service.refreshCredential(credential);
            persistCredential(account.id, credential);
        }

        let loginBuffer = '';
        try {
            loginBuffer = await service.fetchLoginBuffer(credential);
        } catch (error) {
            if (!credential.refreshToken) throw error;
            credential = await service.refreshCredential(credential);
            persistCredential(account.id, credential);
            loginBuffer = await service.fetchLoginBuffer(credential);
        }

        const code = await getNativeWxLoginCode(loginBuffer, TARGET_APP_ID);
        if (!code) throw new Error('应用宝返回的登录 Code 为空');
        return {
            code,
            credential: { ...credential, loginBuffer, loginBufferAt: Date.now() },
        };
    }

    async function pushQrCode(account: Account, qrUrl: string, lastError: string): Promise<boolean> {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const channels = cfg ? readPushChannels(cfg).filter((entry: any) => entry.enabled) : [];
        if (!channels.length) {
            log('错误', '自动重连失败，且没有启用可用的推送渠道，无法推送登录二维码');
            return false;
        }
        const title = `账号 ${account.name} 需要重新扫码登录`;
        const base = publicBaseUrl();
        const panel = base.startsWith('http://127.0.0.1') ? '' : `\n\n[打开管理面板](${base}/)`;
        const content = [
            `账号 **${account.name}** 已掉线，自动重连 3 次失败，请在 5 分钟内扫码重新登录。`,
            '',
            `![扫码登录](${qrUrl})`,
            panel,
            '',
            `二维码地址：${qrUrl}`,
            lastError ? `最后一次错误：${lastError}` : '',
        ].filter(Boolean).join('\n');
        try {
            const results = await sendPushChannels(channels, { title, content });
            const ok = results.some((item: any) => item.ok);
            for (const result of results) {
                if (result.ok) log('系统', `登录二维码推送成功（${result.channel}）: ${account.name}`, { accountId: account.id });
                else log('错误', `登录二维码推送失败（${result.channel}）: ${result.msg}`, { accountId: account.id });
            }
            return ok;
        } catch (error: any) {
            log('错误', `登录二维码推送异常: ${error.message}`, { accountId: account.id });
            return false;
        }
    }

    async function waitForScan(state: ReloginState, task: LoginTask): Promise<void> {
        const deadline = Date.now() + SCAN_POLL_MAX_MS;
        while (!state.cancelled && Date.now() < deadline) {
            await sleep(SCAN_POLL_INTERVAL_MS);
            if (state.cancelled) break;
            if (isRunning(state.accountId)) {
                log('系统', `账号 ${state.accountName} 已被手动启动，结束扫码等待`, { accountId: state.accountId });
                return;
            }
            let status: string;
            try {
                status = await wxLoginTaskManager.poll(task.id);
            } catch (error: any) {
                log('错误', `扫码状态查询失败: ${error.message}`, { accountId: state.accountId });
                return;
            }
            if (status === 'authorized') {
                state.confirmAttempts = (state.confirmAttempts || 0) + 1;
                try {
                    // 换票分两步：HTTP 换 login_buffer，再用 native 协议换 Code。
                    // 网络抖动时不要作废二维码，保留会话重试几次。
                    if (!state.confirmed) {
                        await wxLoginTaskManager.confirm(task.id);
                        state.confirmed = true;
                    }
                    const result = await wxLoginTaskManager.issueCode(task.id, TARGET_APP_ID);
                    const credential = wxLoginTaskManager.credentialFromTask(task);
                    const account = findAccount(store, state.accountId);
                    if (!account) return;
                    if (!credential) throw new Error('扫码成功但未取得应用宝凭据');
                    const updated = applyLogin(account, result.code, credential);
                    if (updated && await startAccountWorker(updated) === false) {
                        throw new Error('账号进程尚未退出，未能启动');
                    }
                    log('系统', `账号 ${state.accountName} 扫码重登成功`, { accountId: state.accountId });
                    addAccountLog('auto_relogin', `扫码重登成功: ${state.accountName}`, state.accountId, state.accountName, { source: 'wx_scan' });
                } catch (error: any) {
                    const detail = describeError(error);
                    log('错误', `扫码后自动登录失败（第 ${state.confirmAttempts} 次）: ${detail}`, { accountId: state.accountId });
                    addAccountLog('auto_relogin', `扫码后自动登录失败（第 ${state.confirmAttempts} 次）: ${detail}`, state.accountId, state.accountName, { source: 'wx_scan' });
                    if (state.confirmAttempts >= 5) {
                        log('错误', `扫码换票连续失败，请到管理面板重新扫码: ${state.accountName}`, { accountId: state.accountId });
                        addAccountLog('auto_relogin', `扫码换票连续失败，需要重新扫码: ${state.accountName}`, state.accountId, state.accountName, {});
                        return;
                    }
                    await sleep(1500 * state.confirmAttempts);
                    continue;
                }
                return;
            }
            if (status === 'cancelled' || status === 'expired' || status === 'failed') {
                log('系统', `登录二维码已失效，请到管理面板重新扫码: ${state.accountName}`, { accountId: state.accountId });
                addAccountLog('auto_relogin', `登录二维码已失效，需重新扫码: ${state.accountName}`, state.accountId, state.accountName, {});
                return;
            }
        }
    }

    async function requestScan(state: ReloginState, lastError: string): Promise<void> {
        const account = findAccount(store, state.accountId);
        if (!account || state.cancelled) return;
        try {
            const task = await wxLoginTaskManager.createTask();
            if (state.cancelled) {
                wxLoginTaskManager.destroyTask(task.id);
                return;
            }
            const token = wxLoginTaskManager.registerPublicQr(task.id);
            state.scanTaskId = task.id;
            const qrUrl = `${publicBaseUrl()}/api/wx-login/public/${token}/qr`;
            log('系统', `自动重连失败，已生成登录二维码: ${account.name}`, { accountId: account.id, qrUrl });
            addAccountLog('auto_relogin', `自动重连失败，等待扫码: ${account.name}`, account.id, account.name, { qrUrl });
            const pushed = await pushQrCode(account, qrUrl, lastError);
            if (!pushed) log('错误', `登录二维码推送失败，可在管理面板重新登录: ${account.name}`, { accountId: account.id });
            await waitForScan(state, task);
            wxLoginTaskManager.destroyTask(task.id);
        } catch (error: any) {
            log('错误', `生成登录二维码失败: ${error.message}`, { accountId: state.accountId });
        }
    }

    async function run(state: ReloginState): Promise<void> {
        const cfg = config();
        const intervals: number[] = Array.isArray(cfg.intervalsSec) && cfg.intervalsSec.length === 3
            ? cfg.intervalsSec
            : [3, 60, 180];
        let lastError = '';
        for (let index = 0; index < intervals.length; index++) {
            await sleep(Math.max(1, Number(intervals[index]) || 1) * 1000);
            if (state.cancelled) return;
            if (Date.now() - state.startedAt > TOTAL_WINDOW_MS) break;
            if (isRunning(state.accountId)) {
                log('系统', `账号 ${state.accountName} 已恢复运行，取消自动重连`, { accountId: state.accountId });
                return;
            }
            const account = findAccount(store, state.accountId);
            if (!account) {
                log('系统', `账号 ${state.accountName} 已被删除，取消自动重连`, { accountId: state.accountId });
                return;
            }
            try {
                const result = await rebuildCode(account);
                if (state.cancelled || isRunning(state.accountId)) return;
                const updated = applyLogin(account, result.code, result.credential);
                if (updated && await startAccountWorker(updated) === false) {
                    throw new Error('账号进程尚未退出，未能启动');
                }
                log('系统', `账号 ${account.name} 应用宝自动重连成功（第 ${index + 1} 次）`, { accountId: account.id });
                addAccountLog('auto_relogin', `应用宝自动重连成功（第 ${index + 1} 次）: ${account.name}`, account.id, account.name, { attempt: index + 1 });
                return;
            } catch (error: any) {
                lastError = String(error?.message || error || 'unknown');
                log('错误', `账号 ${account.name} 自动重连失败（第 ${index + 1} 次）: ${lastError}`, { accountId: account.id, attempt: index + 1 });
                addAccountLog('auto_relogin', `自动重连失败（第 ${index + 1} 次）: ${lastError}`, account.id, account.name, { attempt: index + 1 });
            }
        }
        if (state.cancelled) return;
        await requestScan(state, lastError);
    }

    function schedule(payload: { accountId?: string; accountName?: string; reason?: string } = {}): void {
        const accountId = String(payload.accountId || '').trim();
        if (!accountId) return;
        if (!config().enabled) {
            log('系统', `账号 ${payload.accountName || accountId} 掉线，自动重连已关闭`, { accountId });
            return;
        }
        const previous = states.get(accountId);
        if (previous) previous.cancelled = true;
        const state: ReloginState = {
            accountId,
            accountName: String(payload.accountName || accountId),
            reason: String(payload.reason || 'disconnect'),
            startedAt: Date.now(),
            cancelled: false,
        };
        states.set(accountId, state);
        log('系统', `账号 ${state.accountName} 掉线（${state.reason}），启动应用宝自动重连`, { accountId });
        void run(state)
            .catch((error: any) => log('错误', `自动重连异常: ${error.message}`, { accountId }))
            .finally(() => {
                if (states.get(accountId) === state) states.delete(accountId);
            });
    }

    function cancel(accountId: string): void {
        const state = states.get(String(accountId || ''));
        if (!state) return;
        state.cancelled = true;
        if (state.scanTaskId) wxLoginTaskManager.destroyTask(state.scanTaskId);
        states.delete(state.accountId);
    }

    function cancelAll(): void {
        for (const state of states.values()) state.cancelled = true;
        states.clear();
    }

    return { schedule, cancel, cancelAll };
}

module.exports = { createAutoReloginService };
