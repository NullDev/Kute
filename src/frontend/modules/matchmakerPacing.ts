export const SEARCH_INTERVAL_MS = 10000;
export const COOLDOWN_MS = 60000;
export const FIRST_RETRY_MS = 2000;
export const MAX_RETRY_MS = 30000;

const RETRY_GROWTH = 1.8;

export function retryAfterMs(header: string | null, now: number): number | null{
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function cooldownMs(status: number, retryAfter: number | null): number{
    if (status !== 429 && (status < 500 || status > 599)) return 0;
    return Math.max(COOLDOWN_MS, retryAfter ?? 0);
}

export function nextRetryMs(previous: number): number{
    return previous <= 0 ? FIRST_RETRY_MS : Math.min(MAX_RETRY_MS, Math.round(previous * RETRY_GROWTH));
}
