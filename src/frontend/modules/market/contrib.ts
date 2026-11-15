import { kute } from "../../client";
import api from "../api";
import marketApi from "./api";
import { contributedSale } from "./contributionData";

const SENT_KEY = "kute_market_sent";
const MAX_SENT = 2000;

function shortHash(text: string): string{
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    for (let i = 0; i < text.length; i++){
        a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
        b = Math.imul(b ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return a.toString(36) + b.toString(36);
}

function loadSent(): Set<string>{
    try {
        const saved = JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]");
        return new Set(Array.isArray(saved) ? saved.filter((h) => typeof h === "string").slice(-MAX_SENT) : []);
    }
    catch {
        return new Set();
    }
}

type Capture = { method?: unknown, path?: unknown, request?: any, data?: any };

class Contributions {
    running = false;
    generation = 0;
    nextPostAt = 0;
    failures = 0;
    account = "";
    queue: Map<string, object> = new Map();
    sent = loadSent();
    timer: number | undefined = undefined;
    controller: AbortController | null = null;
    listings: Map<number, { skin: number, price: number }> = new Map();
    seen: Set<number> = new Set();
    listener = (event: MessageEvent): void => this.receive(event);

    start(): void{
        if (this.running || !kute.hostFeatures?.includes("history-capture")) return;
        this.running = true;
        this.generation++;
        window.chrome.webview.addEventListener("message", this.listener);
    }

    stop(): void{
        if (this.running) window.chrome.webview.removeEventListener("message", this.listener);
        this.running = false;
        this.generation++;
        clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
        this.queue.clear();
        this.forgetCaptured();
    }

    useAccount(account: string): void{
        if (this.account === account) return;
        this.queue.clear();
        this.forgetCaptured();
        this.account = account;
    }

    forgetCaptured(): void{
        this.listings.clear();
        this.seen.clear();
    }

    active(): boolean{
        return this.running && !document.hidden && !document.pointerLockElement && !api.down && !api.offline() && marketApi.loggedIn();
    }

    currentAccount(): string{
        try { return localStorage.getItem("krunker_username") ?? ""; }
        catch { return ""; }
    }

    receive(event: MessageEvent): void{
        let message: { marketHistory?: { kind?: unknown, data?: unknown }, marketCapture?: Capture } | null = null;
        try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
        catch { return; }
        if (kute.hostFeatures?.includes("market-capture")){
            if (message?.marketCapture) this.captured(message.marketCapture);
            return;
        }
        const history = message?.marketHistory;
        if (history?.kind === "sales") this.capture(history.data);
    }

    captured(reply: Capture): void{
        if (typeof reply.path !== "string" || reply.data?.error) return;
        const path = reply.path.split(/[?#]/)[0];
        const data = reply.data?.data;
        if (reply.method === "GET"){
            if (path === "/market/history") this.capture(reply.data);
            else if (path === "/market/listings" && Array.isArray(data?.listings)) this.listed(data.listings);
            return;
        }
        if (reply.method !== "POST" || path !== "/market/purchase") return;
        const listing = this.listings.get(data?.mid);
        if (listing && listing.skin === data?.skn){
            const row = { marketid: data.mid, type: "buy", date: new Date().toISOString(), skinindex: data.skn, amount: listing.price, status: "completed" };
            this.capture({ history: [row] });
        }
    }

    listed(rows: any[]): void{
        if (!this.active()) return;
        this.useAccount(this.currentAccount());
        for (const row of rows.slice(0, 200)){
            if (!Number.isSafeInteger(row?.marketid) || !Number.isSafeInteger(row?.skinindex) || !Number.isSafeInteger(row?.funds)) continue;
            this.listings.delete(row.marketid);
            this.listings.set(row.marketid, { skin: row.skinindex, price: row.funds });
            if (this.seen.size < 200) this.seen.add(row.skinindex);
        }
        while (this.listings.size > 3000) this.listings.delete(this.listings.keys().next().value ?? 0);
        this.schedule();
    }

    capture(body: any): void{
        if (!this.active() || body?.error) return;
        const account = this.currentAccount();
        const data = body?.data ?? body;
        const rows = data?.history;
        if (!Array.isArray(rows)) return;
        this.useAccount(account);
        const now = Date.now();
        for (const raw of rows.slice(0, 500)){
            const row = contributedSale(raw, now);
            if (!row) continue;
            const key = "sales" + JSON.stringify(row);
            if (!this.sent.has(shortHash(`${account}\n${key}`))) this.queue.set(key, row);
        }
        while (this.queue.size > 300) this.queue.delete(this.queue.keys().next().value ?? "");
        this.schedule();
    }

    schedule(): void{
        clearTimeout(this.timer);
        if (!this.running || !this.queue.size && !this.seen.size) return;
        const delay = Math.max(100, this.nextPostAt - Date.now(), marketApi.retryAt - Date.now());
        this.timer = window.setTimeout(() => { void this.flush(); }, delay);
    }

    async flush(): Promise<void>{
        if (!this.running || this.controller || !this.queue.size && !this.seen.size) return;
        if (this.account !== this.currentAccount()){ this.queue.clear(); this.seen.clear(); return; }
        if (!this.active() || Date.now() < Math.max(this.nextPostAt, marketApi.retryAt)){
            this.nextPostAt = Math.max(this.nextPostAt, Date.now() + 10_000);
            this.schedule();
            return;
        }
        const {generation} = this; const {account} = this;
        const batch = [...this.queue].slice(0, 100);
        const seen = [...this.seen];
        const body = { sales: batch.map(([, row]) => row), seen };
        const controller = new AbortController();
        this.controller = controller;
        this.nextPostAt = Date.now() + 10_000;
        try {
            const result = await marketApi.observe(body, controller.signal);
            if (!result) throw new Error("contribution unavailable");
            if (generation !== this.generation || account !== this.currentAccount()) return;
            for (const [key] of batch){ this.queue.delete(key); this.sent.add(shortHash(`${account}\n${key}`)); }
            for (const skin of seen) this.seen.delete(skin);
            while (this.sent.size > MAX_SENT) this.sent.delete(this.sent.values().next().value ?? "");
            try { localStorage.setItem(SENT_KEY, JSON.stringify([...this.sent])); }
            catch {}
            this.failures = 0;
        }
        catch {
            if (generation === this.generation){
                this.failures++;
                this.nextPostAt = Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(this.failures - 1, 4));
            }
        }
        finally {
            if (this.controller === controller){
                this.controller = null;
                this.schedule();
            }
        }
    }
}

const contrib = new Contributions();
export default contrib;
