/**
 * wx-login 网络层：带真实错误码、重试和 IP 直连兜底的 HTTP 客户端。
 *
 * 海外机器（Render 新加坡等）访问微信/应用宝域名时有三个坑：
 *  1. system resolver 抖动，或 GeoDNS 返回了当前机器到不了的节点；
 *  2. TCP/TLS 被中途重置时，undici 只抛 `TypeError: fetch failed`，
 *     真正的原因在 error.cause 里（ENOTFOUND / ECONNRESET / ETIMEDOUT），
 *     调用方只打印 error.message 就全丢了，日志里只剩 “fetch failed”；
 *  3. 单次失败就让整个扫码流程作废。
 *
 * 所以这里：保留 cause 里的 code/syscall/host、失败重试、然后按
 * DNS → DoH → 固定 IP 的顺序直连兜底（SNI 和 Host 头保持域名）。
 */
import dns from 'node:dns';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';

export interface NetRequest {
    method?: string;
    headers?: HeadersInit;
    body?: string | Buffer;
    timeoutMs?: number;
    retries?: number;
}

export interface NetResponse {
    status: number;
    headers: Headers;
    body: Buffer;
    /** fetch = undici 正常路径；ip = 直连兜底路径 */
    via: 'fetch' | 'ip';
    address?: string;
}

const DNS_TIMEOUT_MS = 3000;
const DOH_TIMEOUT_MS = 5000;

/** 海外机器解析不到时用的兜底地址（2026-11 实测，国内外都能连通）。 */
const FALLBACK_IPS: Record<string, string[]> = {
    'yybadaccess.3g.qq.com': ['129.226.102.75', '111.30.178.55'],
    'aedns.weixin.qq.com': ['117.185.247.73', '183.192.196.31'],
    'open.weixin.qq.com': ['203.205.239.154', '203.205.232.110'],
    'long.open.weixin.qq.com': ['221.181.99.29', '221.181.99.44'],
};

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

/** 把 undici / socket 错误压成一行可读文本，保留真实原因。 */
export function describeError(error: any): string {
    if (!error) return 'unknown error';
    const cause = error.cause || error;
    const parts: string[] = [];
    const code = cause?.code || error?.code;
    if (code) parts.push(String(code));
    if (cause?.syscall) parts.push(`syscall=${cause.syscall}`);
    if (cause?.hostname) parts.push(`host=${cause.hostname}`);
    if (cause?.address) parts.push(`addr=${cause.address}`);
    if (cause?.port) parts.push(`port=${cause.port}`);
    if (!parts.length) return String(error?.message || error);
    const message = String(error?.message || '').trim();
    return message && message !== 'fetch failed' ? `${message}（${parts.join(' ')}）` : parts.join(' ');
}

/** 解析 IPv4：系统解析 → DoH → 固定兜底地址。 */
export async function resolveIPv4(hostname: string): Promise<string[]> {
    const out: string[] = [];
    try {
        const rows = await withTimeout(dns.promises.resolve4(hostname), DNS_TIMEOUT_MS, 'dns');
        out.push(...rows);
    } catch {
        // 落到 DoH
    }
    if (!out.length) {
        const resolvers = [
            'https://dns.google/resolve',
            'https://cloudflare-dns.com/dns-query',
        ];
        for (const base of resolvers) {
            try {
                const response = await fetch(`${base}?name=${encodeURIComponent(hostname)}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
                });
                const data: any = await response.json();
                const ips = (data?.Answer || [])
                    .filter((item: any) => Number(item?.type) === 1)
                    .map((item: any) => String(item?.data || ''))
                    .filter(Boolean);
                if (ips.length) {
                    out.push(...ips);
                    break;
                }
            } catch {
                // 换下一个 DoH
            }
        }
    }
    for (const ip of FALLBACK_IPS[hostname] || []) {
        if (!out.includes(ip)) out.push(ip);
    }
    return out;
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    new Headers(headers as any).forEach((value, key) => {
        out[key.toLowerCase()] = value;
    });
    return out;
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(raw)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
            for (const item of value) headers.append(key, String(item));
        } else {
            headers.set(key, String(value));
        }
    }
    return headers;
}

async function fetchOnce(url: string, request: NetRequest, timeoutMs: number): Promise<NetResponse> {
    const response = await fetch(url, {
        method: request.method || 'GET',
        headers: request.headers,
        body: request.body as any,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
    });
    return {
        status: response.status,
        headers: response.headers,
        body: Buffer.from(await response.arrayBuffer()),
        via: 'fetch',
    };
}

function rawOnce(target: URL, request: NetRequest, ip: string, timeoutMs: number): Promise<NetResponse> {
    const secure = target.protocol === 'https:';
    const body = request.body == null ? undefined : (Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body)));
    const headers = headersToObject(request.headers);
    headers.host = target.host;
    if (body) headers['content-length'] = String(body.length);

    return new Promise<NetResponse>((resolve, reject) => {
        const options: https.RequestOptions = {
            protocol: target.protocol,
            host: ip,
            port: target.port || (secure ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: request.method || 'GET',
            headers,
            agent: false,
            timeout: timeoutMs,
        };
        if (secure) options.servername = target.hostname;
        const client = secure ? https : http;
        const req = client.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('error', reject);
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: toHeaders(res.headers),
                    body: Buffer.concat(chunks),
                    via: 'ip',
                    address: ip,
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error(`socket timeout after ${timeoutMs}ms`)));
        if (body) req.write(body);
        req.end();
    });
}

/**
 * 请求一个域名并返回原始响应。
 * 正常走 fetch；网络层失败先重试，再逐个用解析出来的 IP 直连（保持 SNI / Host）。
 * 全部失败时抛出的错误信息里带有每次尝试的真实错误码。
 */
export async function requestWithFallback(url: string, request: NetRequest = {}): Promise<NetResponse> {
    const timeoutMs = request.timeoutMs ?? 35_000;
    const retries = Math.max(1, request.retries ?? 2);
    const errors: string[] = [];
    let firstError: any;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fetchOnce(url, request, timeoutMs);
        } catch (error: any) {
            firstError = firstError || error;
            errors.push(`fetch#${attempt + 1}:${describeError(error)}`);
            if (attempt + 1 < retries) await sleep(300 * (attempt + 1));
        }
    }

    const target = new URL(url);
    const ips = await resolveIPv4(target.hostname);
    for (const ip of ips) {
        try {
            return await rawOnce(target, request, ip, timeoutMs);
        } catch (error: any) {
            errors.push(`${ip}:${describeError(error)}`);
        }
    }

    const failure = new Error(`网络请求失败 ${target.hostname} [${errors.join(' | ')}]`);
    (failure as any).cause = firstError;
    throw failure;
}
