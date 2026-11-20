import { kute, ready } from "../client";

const HEALTH_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_FAILURES = 3;

class Api {
    base = typeof kute.apiBase === "string" ? kute.apiBase : "https://kute.lol/api";
    health: Promise<boolean> | null = null;
    down = false;
    failures = 0;
    listeners: Set<(online: boolean) => void> = new Set();

    constructor(){
        kute.settings.toggleDisableOnlineFeatures = (disabled): void => this.setOffline(disabled);
    }

    offline(): boolean{
        return kute.settings?.data?.disableOnlineFeatures === true;
    }

    setOffline(offline: boolean): void{
        this.health = offline ? Promise.resolve(false) : null;
        this.down = offline;
        this.failures = 0;
        for (const listener of this.listeners) listener(!offline);
    }

    available(): Promise<boolean>{
        this.health ??= this.check();
        return this.health;
    }

    retry(): Promise<boolean>{
        this.health = null;
        this.down = false;
        this.failures = 0;
        return this.available();
    }

    async check(): Promise<boolean>{
        await ready;
        if (this.offline()){
            this.down = true;
            return false;
        }
        try {
            const response = await fetch(`${this.base}/health`, { cache: "no-store", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            const health = response.ok ? await response.json() : null;
            this.down = health?.ok !== true;
        }
        catch {
            this.down = true;
        }
        return !this.down;
    }

    async request(path: string, init: RequestInit = {}): Promise<any>{
        const { data } = await this.requestStatus(path, init);
        return data;
    }

    async requestStatus(path: string, init: RequestInit = {}): Promise<{ status: number, data: any, error?: any, retryAt?: number }>{
        if (!await this.available() || this.down || this.offline()) return { status: 0, data: null };
        try {
            const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
            const response = await fetch(this.base + path, { ...init, signal });
            if (response.status >= 500) this.failed();
            else if (response.ok) this.failures = 0;
            const data = await response.json().catch(() => null);
            const retry = response.headers.get("Retry-After");
            let after = 0;
            if (retry !== null) after = /^\d+(\.\d+)?$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
            const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1000;
            const deadline = Math.max(after || 0, reset || 0, Number(data?.resetAt) || 0);
            const retryAt = response.status === 429 ? Math.max(Date.now() + 1000, deadline || Date.now() + 60_000) : undefined;
            return { status: response.status, data: response.ok ? data : null, error: response.ok ? null : data, retryAt };
        }
        catch {
            if (!init.signal?.aborted) this.failed();
            return { status: 0, data: null };
        }
    }

    failed(): void{
        this.failures++;
        if (this.failures >= MAX_FAILURES) this.down = true;
    }
}

const api = new Api();
kute.api = api;
export default api;
