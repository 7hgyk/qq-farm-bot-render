export {};

// 海外到国内网关延迟/丢包更明显，给心跳留更长的恢复窗口。
const HEARTBEAT_STALE_AFTER_MS = 45000;
const MAX_HEARTBEAT_MISSES = 5;

function shouldTerminateForHeartbeat(missCount: number, inboundSilenceMs: number): boolean {
    return Number(missCount) >= MAX_HEARTBEAT_MISSES
        && Number(inboundSilenceMs) > HEARTBEAT_STALE_AFTER_MS;
}

module.exports = {
    HEARTBEAT_STALE_AFTER_MS,
    MAX_HEARTBEAT_MISSES,
    shouldTerminateForHeartbeat,
};
