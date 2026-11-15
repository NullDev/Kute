import { kute } from "../../client";
import api from "../api";
import type { ItemDeskReply, SkinFacts, SearchReply } from "./types";

const SESSION_KEY = "kute_market_session";
const SESSION_HEADER = "x-kute-session";
const ATTEST_TIMEOUT_MS = 3000;
const SESSION_MARGIN_MS = 60 * 60 * 1000;

type StoredSession = { session: string, expiresAt: number };

type AttestReply = { marketAttest?: { challenge: string, sig: string | null, version: string, loggedIn: boolean, keyed: boolean } };

class MarketApi {
    sessionPromise: Promise<string | null> | null = null;
    memorySession: StoredSession | null = null;
    cache: Map<string, { at: number, ttl: number, value: Promise<any> }> = new Map();
    lastError = "";
    retryAt = 0;

    loggedIn(): boolean{
        try { return localStorage.getItem("krunker_token") !== null; }
        catch { return false; }
    }

    hostSupported(): boolean{
        return kute.hostFeatures?.includes("market-attest") === true;
    }

    stored(): StoredSession | null{
        if (this.memorySession && Date.now() < this.memorySession.expiresAt - SESSION_MARGIN_MS) return this.memorySession;
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as StoredSession;
            if (typeof parsed.session !== "string" || Date.now() > parsed.expiresAt - SESSION_MARGIN_MS) return null;
            return parsed;
        }
        catch {
            return null;
        }
    }

    forget(session: string): void{
        if (this.stored()?.session !== session) return;
        try { localStorage.removeItem(SESSION_KEY); }
        catch {}
        this.memorySession = null;
    }

    attest(challenge: string): Promise<AttestReply["marketAttest"] | null>{
        return new Promise((resolve) => {
            let timer = 0;
            const listener = (event: MessageEvent<AttestReply>): void => {
                let data: AttestReply | null = null;
                try {
                    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
                }
                catch {
                    return;
                }
                const reply = data?.marketAttest;
                if (!reply || reply.challenge !== challenge) return;
                clearTimeout(timer);
                window.chrome.webview.removeEventListener("message", listener);
                resolve(reply);
            };
            timer = window.setTimeout(() => {
                window.chrome.webview.removeEventListener("message", listener);
                resolve(null);
            }, ATTEST_TIMEOUT_MS);
            window.chrome.webview.addEventListener("message", listener);
            window.chrome.webview.postMessage(`market-attest, ${challenge}, ${this.loggedIn()}`);
        });
    }

    session(): Promise<string | null>{
        const stored = this.stored();
        if (stored) return Promise.resolve(stored.session);
        this.sessionPromise ??= this.newSession().finally(() => {
            this.sessionPromise = null;
        });
        return this.sessionPromise;
    }

    async newSession(): Promise<string | null>{
        this.lastError = "";
        if (!this.loggedIn()){
            this.lastError = "log in to Krunker to see item stats";
            return null;
        }
        if (!this.hostSupported()){
            this.lastError = "this Kute version cannot sign in for item stats, update Kute";
            return null;
        }
        const challenge = await api.requestStatus("/market/session", { method: "POST" });
        if (!challenge.data?.challenge){
            this.lastError = challenge.status === 503 ? "item stats are not available right now" : "could not reach the item stats server";
            if (challenge.status === 429) this.limited(challenge.retryAt);
            return null;
        }
        const signed = await this.attest(challenge.data.challenge);
        if (!signed){
            this.lastError = "Kute did not answer the sign in";
            return null;
        }
        const confirm = await api.requestStatus("/market/session/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: signed.challenge, sig: signed.sig, version: signed.version, loggedIn: signed.loggedIn }),
        });
        if (!confirm.data?.session){
            this.lastError = typeof confirm.error?.error === "string" ? confirm.error.error : "the server refused the sign in";
            if (confirm.status === 429) this.limited(confirm.retryAt);
            return null;
        }
        this.memorySession = { session: confirm.data.session, expiresAt: confirm.data.expiresAt };
        try {
            localStorage.setItem(SESSION_KEY, JSON.stringify(this.memorySession));
        }
        catch {}
        return confirm.data.session;
    }

    async request(path: string, init: RequestInit = {}, retried = false): Promise<any>{
        return (await this.requestStatus(path, init, retried)).data;
    }

    async requestStatus(path: string, init: RequestInit = {}, retried = false): Promise<{ status: number, data: any, retryAt?: number }>{
        if (Date.now() < this.retryAt) return { status: 429, data: null, retryAt: this.retryAt };
        const session = await this.session();
        if (!session) return { status: 0, data: null };
        const headers = { ...(init.headers ?? {}), [SESSION_HEADER]: session };
        const result = await api.requestStatus(path, { ...init, headers, cache: "no-store" });
        if (result.status === 401 && !retried){
            this.forget(session);
            return this.requestStatus(path, init, true);
        }
        if (result.status === 429){
            this.limited(result.retryAt);
        }
        else this.lastError = result.data === null && result.status !== 404 ? "Item stats are temporarily unavailable. Please try again shortly." : "";
        return result;
    }

    limited(retryAt?: number): void{
        this.retryAt = retryAt ?? Date.now() + 60_000;
        this.lastError = `Request limit reached. Try again after ${new Date(this.retryAt).toLocaleTimeString()}.`;
    }

    cached(path: string, ttlMs: number, read: () => Promise<any> = () => this.request(path)): Promise<any>{
        const now = Date.now();
        const hit = this.cache.get(path);
        if (hit && now - hit.at < hit.ttl) return hit.value;
        const value = read().then((data) => {
            if (data === null) this.cache.delete(path);
            return data;
        });
        this.cache.set(path, { at: now, ttl: ttlMs, value });
        if (this.cache.size > 500){
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        return value;
    }

    retry(): Promise<boolean>{
        if (Date.now() < this.retryAt) return Promise.resolve(false);
        this.cache.clear();
        return api.retry();
    }

    itemDesk(skin: number, range: string): Promise<ItemDeskReply | null>{
        return this.cached(`/market/item/${skin}/desk?range=${range}`, 60_000);
    }

    async values(skins: number[]): Promise<Record<string, SkinFacts>>{
        const ids = [...new Set(skins)].sort((a, b) => a - b);
        const out: Record<string, SkinFacts> = {};
        for (let i = 0; i < ids.length; i += 100){
            const reply = await this.cached(`/market/value?ids=${ids.slice(i, i + 100).join(",")}`, 5 * 60 * 1000);
            Object.assign(out, reply?.values ?? {});
        }
        return out;
    }

    async valuesByThumbnails(paths: string[]): Promise<Record<string, SkinFacts>>{
        const unique = [...new Set(paths)].sort();
        const out: Record<string, SkinFacts> = {};
        for (let i = 0; i < unique.length; i += 100){
            const reply = await this.cached(`/market/value?thumbs=${encodeURIComponent(unique.slice(i, i + 100).join(","))}`, 5 * 60 * 1000);
            Object.assign(out, reply?.values ?? {});
        }
        return out;
    }

    search(q: string): Promise<SearchReply | null>{
        return this.cached(`/market/search?q=${encodeURIComponent(q)}&sort=sales&page=1`, 60_000);
    }

    observe(body: object, signal?: AbortSignal): Promise<any>{
        return this.request("/market/observe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    }

    watch(skins: number[]): Promise<{ watched: number } | null>{
        return this.request("/market/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skins }) });
    }
}

const marketApi = new MarketApi();
export default marketApi;
