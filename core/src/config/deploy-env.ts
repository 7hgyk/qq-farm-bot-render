import type { OfflineReminder, OfflineReminderChannel } from '../types/config';
export {};

/**
 * 云平台（Render / Railway / Docker 等）环境变量覆盖。
 *
 * 这些变量只影响运行期内存中的配置，不写回 data/ 目录：
 * - ADMIN_USERNAME / ADMIN_PASSWORD：覆盖管理面板登录账号，登录后无需再修改密码。
 * - PUSHPLUS_TOKEN：注入并启用 PushPlus 推送渠道。
 *
 * 平台面板中的变量优先于 data/ 里的持久化配置；删除变量后恢复为本地配置。
 */

export interface EnvAdminCredentials {
    username: string;
    password: string;
}

function readEnv(name: string): string {
    return String(process.env[name] ?? '').trim();
}

/** 管理面板端口：优先 ADMIN_PORT，其次平台注入的 PORT，最后回落到 3007。 */
export function getEnvAdminPort(): number | undefined {
    const raw = readEnv('ADMIN_PORT') || readEnv('PORT');
    if (!raw) return undefined;
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** 是否通过环境变量托管管理员密码。 */
export function isEnvAdminManaged(): boolean {
    return Boolean(readEnv('ADMIN_PASSWORD'));
}

/** 读取环境变量中的管理员账号；未设置 ADMIN_PASSWORD 时返回 null。 */
export function getEnvAdminCredentials(): EnvAdminCredentials | null {
    const password = readEnv('ADMIN_PASSWORD');
    if (!password) return null;
    return {
        username: readEnv('ADMIN_USERNAME') || 'admin',
        password,
    };
}

/** 读取环境变量中的 PushPlus Token；未设置时返回空字符串。 */
export function getEnvPushplusToken(): string {
    return readEnv('PUSHPLUS_TOKEN');
}

/**
 * 把环境变量里的 PushPlus Token 合并进离线提醒配置。
 * 环境变量存在时始终覆盖同名渠道的 Token 并启用该渠道；不修改 data/ 中的持久化配置。
 */
export function applyEnvPushOverrides(reminder: OfflineReminder): OfflineReminder {
    const token = getEnvPushplusToken();
    if (!token) return reminder;

    const channels: OfflineReminderChannel[] = Array.isArray(reminder.channels)
        ? reminder.channels.map(entry => ({ ...entry }))
        : [];
    const existing = channels.find(entry => entry.channel === 'pushplus');
    if (existing) {
        existing.token = token;
        existing.enabled = true;
    } else {
        channels.unshift({ channel: 'pushplus', endpoint: '', token, secret: '', enabled: true });
    }

    return {
        ...reminder,
        channels,
        channel: 'pushplus',
        endpoint: '',
        token,
        secret: '',
    };
}
