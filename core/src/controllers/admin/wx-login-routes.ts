import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { wxLoginTaskManager } from '../../services/wx-login/task-manager';
import type { LoginTask } from '../../services/wx-login/task-manager';

export { };

const { createAuthRequired } = require('./middleware');

const TARGET_APP_ID = 'wx5306c5978fdb76e4';

function publicTask(task: LoginTask) {
    return {
        task_id: task.id,
        app_id: TARGET_APP_ID,
        status: task.status,
        expires_at: Math.floor((task.createdAt + 5 * 60 * 1000) / 1000),
    };
}

function findTask(req: Request, res: Response): LoginTask | null {
    const task = wxLoginTaskManager.getTask(String(req.params.taskId || ''));
    if (!task) {
        res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        return null;
    }
    return task;
}

function mountWxLoginRoutes(app: Application, ctx: AdminContext): void {
    // 公开二维码图片：自动重连把该地址推送到 PushPlus，手机微信点开即可扫码。
    // 必须注册在鉴权中间件之前，只认随机 token，不暴露任务列表。
    app.get('/api/wx-login/public/:token/qr', (req: Request, res: Response) => {
        const task = wxLoginTaskManager.resolvePublicQr(String(req.params.token || ''));
        if (!task) return res.status(404).json({ ok: false, error: 'QR code not found or expired' });
        res.type('jpeg').send(task.qr);
    });

    app.use('/api/wx-login', createAuthRequired(ctx));

    // 创建扫码任务（应用宝 / 微信共用同一入口，默认使用应用宝渠道）
    app.post('/api/wx-login/tasks', async (req, res) => {
        if (req.body?.app_id && req.body.app_id !== TARGET_APP_ID) {
            return res.status(400).json({ ok: false, error: 'Unsupported app_id' });
        }
        try {
            const task = await wxLoginTaskManager.createTask();
            res.json({ ok: true, data: { ...publicTask(task), qr_url: `/api/wx-login/tasks/${task.id}/qr` } });
        } catch (error: any) {
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    app.get('/api/wx-login/tasks/:taskId/qr', (req, res) => {
        const task = findTask(req, res);
        if (task) res.type('jpeg').send(task.qr);
    });

    app.delete('/api/wx-login/tasks/:taskId', (req, res) => {
        const task = wxLoginTaskManager.getTask(String(req.params.taskId || ''));
        if (!task) return res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        wxLoginTaskManager.destroyTask(task.id);
        return res.json({ ok: true });
    });

    app.get('/api/wx-login/tasks/:taskId/status', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            if (!task.pending) {
                task.pending = wxLoginTaskManager.poll(task.id).then(() => undefined).finally(() => { task.pending = undefined; });
            }
            await task.pending;
            const data = publicTask(task);
            if (task.status === 'cancelled' || task.status === 'expired') wxLoginTaskManager.destroyTask(task.id);
            res.json({ ok: true, data });
        } catch (error: any) {
            task.status = 'failed';
            wxLoginTaskManager.destroyTask(task.id);
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/wx-login/tasks/:taskId/confirm', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            if (!task.pending) {
                task.pending = wxLoginTaskManager.confirm(task.id).then(() => undefined).finally(() => { task.pending = undefined; });
            }
            await task.pending;
            res.json({ ok: true, data: publicTask(task) });
        } catch (error: any) {
            task.status = 'failed';
            wxLoginTaskManager.destroyTask(task.id);
            res.status(502).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/wx-login/tasks/:taskId/code', async (req, res) => {
        const task = findTask(req, res);
        if (!task) return;
        try {
            if (!task.pending) {
                task.pending = wxLoginTaskManager.issueCode(task.id, TARGET_APP_ID).then(() => undefined).finally(() => { task.pending = undefined; });
            }
            await task.pending;
            const data = {
                openid: String(task.session.openid || ''),
                app_id: TARGET_APP_ID,
                code: task.code,
                nickname: String(task.session.nickname || ''),
                err_msg: 'login:ok',
            };
            wxLoginTaskManager.destroyTask(task.id);
            res.json({ ok: true, data });
        } catch (error: any) {
            task.status = 'failed';
            wxLoginTaskManager.destroyTask(task.id);
            res.status(502).json({ ok: false, error: error.message });
        }
    });
}

module.exports = { mountWxLoginRoutes };
