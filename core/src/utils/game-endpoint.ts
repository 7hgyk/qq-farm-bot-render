import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import net from 'node:net';

export {};

/**
 * 游戏网关域名解析。
 *
 * 海外机器（Render 新加坡等）直接交给系统 DNS 时，可能拿到绕路或不可达的
 * A 记录，表现为握手/心跳/AntiData 超时。这里对域名做 IPv4 解析，并对每个
 * 地址做一次 TCP 连接测速，优先使用延迟最低的地址，结果缓存 5 分钟。
 * TLS 的 SNI 仍然是原域名，不影响证书校验。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1500;
const cache = new Map<string, { address: string; at: number }>();
// 海外机器优先 IPv4，避免 IPv6 绕路。
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 老 Node 不支持时忽略 */ }

function isIpLiteral(host: string): boolean {
    return net.isIP(host) !== 0;
}

function probe(ip: string, port: number): Promise<number> {
    return new Promise(resolve => {
        const started = Date.now();
        const socket = net.connect({ host: ip, port });
        let settled = false;
        const finish = (latency: number) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(latency);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(Number.POSITIVE_INFINITY));
        socket.once('connect', () => finish(Date.now() - started));
        socket.once('error', () => finish(Number.POSITIVE_INFINITY));
    });
}

async function fastestAddress(host: string, port: number): Promise<string | null> {
    if (isIpLiteral(host)) return host;
    const key = `${host}:${port}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.address;

    let addresses: string[] = [];
    try {
        addresses = await dnsPromises.resolve4(host);
    } catch {
        return null;
    }
    addresses = [...new Set(addresses)].filter(Boolean);
    if (!addresses.length) return null;
    if (addresses.length === 1) {
        cache.set(key, { address: addresses[0], at: Date.now() });
        return addresses[0];
    }
    const measured = await Promise.all(addresses.map(async address => ({ address, latency: await probe(address, port) })));
    measured.sort((a, b) => a.latency - b.latency);
    const best = measured[0].address;
    cache.set(key, { address: best, at: Date.now() });
    return best;
}

/** ws 的自定义 lookup：返回测速后最快的 IPv4，失败时回退系统解析。 */
export function createGameLookup(serverUrl: string) {
    const url = new URL(serverUrl);
    const port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
    return (hostname: string, options: any, callback: any): void => {
        fastestAddress(hostname, port)
            .then(address => {
                if (!address) {
                    dns.lookup(hostname, options, callback);
                    return;
                }
                if (options && options.all) callback(null, [{ address, family: 4 }]);
                else callback(null, address, 4);
            })
            .catch(() => dns.lookup(hostname, options, callback));
    };
}

export function clearGameEndpointCache(): void {
    cache.clear();
}
