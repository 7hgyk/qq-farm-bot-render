import crypto from 'node:crypto';
import { WxLoginService } from './service';
import type { ScanStatus, WxCredential, WxLoginSession } from './service';

export { };

/**
 * 扫码登录任务管理器。
 *
 * 同时被管理面板路由和「掉线自动重连」复用：
 * - 面板通过 /api/wx-login/tasks 创建二维码并轮询；
 * - 自动重连失败后创建二维码，把公开图片地址推送到 PushPlus，
 *   再在这里等待用户扫码并拿到新的 login_buffer / 凭据。
 */

export type LoginTaskStatus = ScanStatus | 'ready_for_code' | 'failed';

export interface LoginTask {
    id: string;
    createdAt: number;
    status: LoginTaskStatus;
    session: WxLoginSession;
    qr: Buffer;
    code?: string;
    pending?: Promise<void>;
}

interface CodeCredential {
    credential: WxCredential;
    createdAt: number;
}

interface PublicQr {
    taskId: string;
    expiresAt: number;
}

export const TASK_TTL_MS = 5 * 60 * 1000;
const CODE_CREDENTIAL_TTL_MS = 10 * 60 * 1000;

export class WxLoginTaskManager {
    readonly service = new WxLoginService();
    private readonly tasks = new Map<string, LoginTask>();
    private readonly publicQrTokens = new Map<string, PublicQr>();
    private readonly credentialsByCode = new Map<string, CodeCredential>();

    async createTask(): Promise<LoginTask> {
        const { session, qr } = await this.service.createQrSession();
        const task: LoginTask = {
            id: crypto.randomBytes(32).toString('hex'),
            createdAt: Date.now(),
            status: 'waiting',
            session,
            qr,
        };
        this.tasks.set(task.id, task);
        return task;
    }

    getTask(taskId: string): LoginTask | null {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return null;
        if (Date.now() - task.createdAt > TASK_TTL_MS) {
            this.destroyTask(task.id);
            return null;
        }
        return task;
    }

    async poll(taskId: string): Promise<LoginTaskStatus> {
        const task = this.getTask(taskId);
        if (!task) throw new Error('Login task not found or expired');
        if (task.status === 'authorized' || task.status === 'ready_for_code') return task.status;
        task.status = await this.service.poll(task.session);
        if (task.status === 'cancelled' || task.status === 'expired') {
            // 任务结束前保留二维码图片，路由层读取状态后自行销毁。
        }
        return task.status;
    }

    async confirm(taskId: string): Promise<LoginTaskStatus> {
        const task = this.getTask(taskId);
        if (!task) throw new Error('Login task not found or expired');
        if (task.status !== 'authorized') throw new Error('Waiting for scan authorization');
        await this.service.confirm(task.session);
        task.status = 'ready_for_code';
        return task.status;
    }

    /**
     * 用扫码会话换取游戏 Code，并把凭据按 Code 暂存，
     * 供 /api/accounts 建号时自动挂到账号上（浏览器无需接触 token）。
     */
    async issueCode(taskId: string, appId: string): Promise<{ code: string; openid: string; nickname: string }> {
        const task = this.getTask(taskId);
        if (!task) throw new Error('Login task not found or expired');
        if (task.status !== 'ready_for_code') throw new Error('Login code is not ready');
        const code = await this.service.issueCode(task.session, appId);
        task.code = code;
        const credential = this.service.credentialFromSession(task.session);
        if (credential) {
            this.credentialsByCode.set(code, { credential, createdAt: Date.now() });
            this.pruneCredentials();
        }
        return { code, openid: String(task.session.openid || ''), nickname: String(task.session.nickname || '') };
    }

    credentialForCode(code: string): WxCredential | null {
        const entry = this.credentialsByCode.get(String(code || ''));
        if (!entry) return null;
        if (Date.now() - entry.createdAt > CODE_CREDENTIAL_TTL_MS) {
            this.credentialsByCode.delete(String(code));
            return null;
        }
        return { ...entry.credential };
    }

    /** 为推送中的二维码注册公开访问 token（无需面板登录即可加载图片）。 */
    registerPublicQr(taskId: string, ttlMs = TASK_TTL_MS): string {
        const token = crypto.randomBytes(24).toString('hex');
        this.publicQrTokens.set(token, { taskId, expiresAt: Date.now() + ttlMs });
        return token;
    }

    resolvePublicQr(token: string): LoginTask | null {
        const entry = this.publicQrTokens.get(String(token || ''));
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.publicQrTokens.delete(String(token));
            return null;
        }
        return this.getTask(entry.taskId);
    }

    destroyTask(taskId: string): void {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return;
        try { this.service.destroy(task.session); } catch { /* ignore */ }
        task.code = undefined;
        this.tasks.delete(task.id);
        for (const [token, entry] of this.publicQrTokens) {
            if (entry.taskId === task.id) this.publicQrTokens.delete(token);
        }
    }

    credentialFromTask(task: LoginTask): WxCredential | null {
        return this.service.credentialFromSession(task.session);
    }

    private pruneCredentials(): void {
        const now = Date.now();
        for (const [code, entry] of this.credentialsByCode) {
            if (now - entry.createdAt > CODE_CREDENTIAL_TTL_MS) this.credentialsByCode.delete(code);
        }
    }
}

export const wxLoginTaskManager = new WxLoginTaskManager();
