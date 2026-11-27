export {};
const crypto = require('node:crypto');
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { getEnvAdminCredentials, isEnvAdminManaged } = require('../config/deploy-env');
const security = require('./auth-security');

const ADMIN_FILE: string = getDataFile('admin.json');

interface AdminRecord {
    username: string;
    password: string;
    createdAt: number;
    mustChangePassword?: boolean;
}

let admin: AdminRecord | null = null;

function normalizeAdmin(raw: any): AdminRecord | null {
    if (!raw || typeof raw !== 'object' || !String(raw.password || '').trim()) return null;
    return {
        username: String(raw.username || 'admin').trim() || 'admin',
        password: String(raw.password),
        createdAt: Number(raw.createdAt) || Date.now(),
        mustChangePassword: raw.mustChangePassword === true || undefined,
    };
}

function saveAdmin(): void {
    ensureDataDir();
    if (!admin) return;
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ admin }, null, 2), 'utf8');
}

function loadAdmin(): AdminRecord {
    ensureDataDir();
    if (admin) return admin;
    try {
        if (fs.existsSync(ADMIN_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
            admin = normalizeAdmin(data?.admin || data);
        }
    } catch {
        admin = null;
    }
    if (!admin) {
        admin = {
            username: 'admin',
            password: security.hashPassword('admin'),
            createdAt: Date.now(),
            mustChangePassword: true,
        };
        saveAdmin();
        console.log('[管理员] 已创建默认账号 admin，默认密码 admin');
    }
    return admin;
}

/**
 * 环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 优先于 data/admin.json。
 * 只覆盖内存中的记录，不写盘；删除变量后恢复本地账号。
 */
function applyEnvAdminOverride(record: AdminRecord): AdminRecord {
    const env = getEnvAdminCredentials();
    if (!env) return record;
    if (record.username === env.username && security.verifyPassword(env.password, record.password)) {
        return record.mustChangePassword ? { ...record, mustChangePassword: undefined } : record;
    }
    return {
        username: env.username,
        password: security.hashPassword(env.password),
        createdAt: record.createdAt,
        mustChangePassword: undefined,
    };
}

function getAdminInfo(): { username: string; role: 'admin'; mustChangePassword: boolean } {
    const current = loadAdmin();
    return { username: current.username, role: 'admin', mustChangePassword: current.mustChangePassword === true };
}

function getCredentialFingerprint(): string {
    const current = loadAdmin();
    return crypto.createHash('sha256').update(`${current.username}:${current.password}`).digest('hex');
}

function validateAdmin(username: string, password: string, ip: string = 'unknown'): any {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed) return { error: 'rate_limit', ...rateLimit };
    const lockout = security.checkAdminLockout();
    if (lockout.locked) return { error: 'locked', ...lockout };

    const current = loadAdmin();
    if (username !== current.username || !security.verifyPassword(password, current.password)) {
        const attempt = security.recordFailedAttempt();
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }

    security.clearFailedAttempts();
    if (security.needsRehash(current.password)) {
        current.password = security.hashPassword(password);
        saveAdmin();
    }
    return getAdminInfo();
}

function changePassword(oldPassword: string, newPassword: string): { ok: boolean; error?: string; message?: string } {
    if (isEnvAdminManaged()) {
        return { ok: false, error: '管理员密码由环境变量 ADMIN_PASSWORD 管理，请在部署平台修改变量后重启服务' };
    }
    const current = loadAdmin();
    if (!security.verifyPassword(oldPassword, current.password)) return { ok: false, error: '当前密码错误' };
    const validation = security.validatePasswordStrength(newPassword);
    if (!validation.valid) return { ok: false, error: validation.errors.join('；') };
    current.password = security.hashPassword(newPassword);
    delete current.mustChangePassword;
    saveAdmin();
    return { ok: true, message: '密码修改成功' };
}

const initialAdmin = loadAdmin();
const envAdmin = applyEnvAdminOverride(initialAdmin);
if (envAdmin !== initialAdmin) {
    admin = envAdmin;
    console.log('[管理员] 已从环境变量读取 ADMIN_USERNAME / ADMIN_PASSWORD');
}

module.exports = { getAdminInfo, getCredentialFingerprint, validateAdmin, changePassword, isEnvAdminManaged };
