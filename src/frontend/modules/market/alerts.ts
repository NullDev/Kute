import { kute } from "../../client";
import api from "../api";
import marketApi from "./api";
import { readWatchlist } from "./watchlist";
import { formatKr } from "./types";

const INTERVAL = 5 * 60_000;
const MAX_AGE = 3 * 3_600_000;
const STATE_KEY = "kute_market_alerts";
const REPORT_KEY = "kute_market_watch_report";
const UNREAD_KEY = "kute_market_alerts_unread";
export const UNREAD_EVENT = "kute-market-alerts-unread";
const REPORT_EVERY = 2 * 3_600_000;

class WatchAlerts {
    timer = 0;
    busy = false;
    seen: Map<number, { target: number, reached: boolean }> = new Map();
    unread: Set<number>;
    onChange: () => void;

    constructor(){
        try {
            const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? "[]");
            if (Array.isArray(saved)){
                for (const [skin, state] of saved.slice(0, 100)){
                    if (Number.isInteger(skin) && Number.isFinite(state?.target) && typeof state?.reached === "boolean") this.seen.set(skin, state);
                }
            }
        }
        catch {
            this.seen.clear();
        }
        this.unread = new Set();
        try {
            const saved = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "[]");
            if (Array.isArray(saved)) for (const skin of saved.slice(0, 100)) if (Number.isInteger(skin)) this.unread.add(skin);
        }
        catch {
            this.unread.clear();
        }
        this.onChange = (): void => {
            void this.check();
            void this.report();
        };
    }

    start(): void{
        if (this.timer) return;
        this.timer = window.setInterval(() => { void this.check(); }, INTERVAL);
        window.addEventListener("kute-market-watch-changed", this.onChange);
        void this.check();
        void this.report();
    }

    async report(): Promise<void>{
        if (!this.active()) return;
        const skins = readWatchlist().map((w) => w.skin).sort((a, b) => a - b);
        const key = skins.join(",");
        let last: { key?: string, at?: number } = {};
        try { last = JSON.parse(localStorage.getItem(REPORT_KEY) ?? "{}") ?? {}; }
        catch {}
        if (last.key === key && Date.now() - (last.at ?? 0) < REPORT_EVERY) return;
        if (!skins.length && last.key === undefined) return;
        if (!await marketApi.watch(skins)) return;
        try { localStorage.setItem(REPORT_KEY, JSON.stringify({ key, at: Date.now() })); }
        catch {}
    }

    stop(): void{
        clearInterval(this.timer);
        this.timer = 0;
        window.removeEventListener("kute-market-watch-changed", this.onChange);
    }

    active(): boolean{
        return !!this.timer && !document.pointerLockElement && !document.hidden && !api.offline() && marketApi.loggedIn();
    }

    save(): void{
        try { localStorage.setItem(STATE_KEY, JSON.stringify([...this.seen])); }
        catch {}
    }

    saveUnread(): void{
        try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...this.unread])); }
        catch {}
        window.dispatchEvent(new Event(UNREAD_EVENT));
    }

    markRead(): void{
        if (!this.unread.size) return;
        this.unread.clear();
        this.saveUnread();
    }

    async check(): Promise<void>{
        if (this.busy || !this.active()) return;
        const watch = readWatchlist().filter((w) => w.target !== null);
        for (const skin of this.seen.keys()) if (!watch.some((w) => w.skin === skin)) this.seen.delete(skin);
        this.save();
        const unread = this.unread.size;
        for (const skin of this.unread) if (!watch.some((w) => w.skin === skin)) this.unread.delete(skin);
        if (this.unread.size !== unread) this.saveUnread();
        if (!watch.length) return;
        this.busy = true;
        try {
            const values = await marketApi.values(watch.map((w) => w.skin));
            if (!this.active()) return;
            const latest = readWatchlist();
            const hits = [];
            for (const w of watch){
                if (w.target === null || !latest.some((i) => i.skin === w.skin && i.target === w.target)) continue;
                const v = values[w.skin];
                if (!v || !v.bookAt || Date.now() - v.bookAt > MAX_AGE || v.lowest === null) continue;
                const reached = v.lowest <= w.target;
                const previous = this.seen.get(w.skin);
                if (reached && (!previous?.reached || previous.target !== w.target)){
                    hits.push({ name: w.name, price: v.lowest });
                    this.unread.add(w.skin);
                }
                this.seen.set(w.skin, { target: w.target, reached });
            }
            if (hits.length){
                this.saveUnread();
                const first = hits[0];
                const more = hits.length > 1 ? ` and ${hits.length - 1} more` : "";
                kute.showNotification(`Watchlist: ${first.name} at ${formatKr(first.price)} KR${more}. Observed ask reached your target.`, false, 8);
            }
            this.save();
        }
        catch {}
        finally {
            this.busy = false;
        }
    }
}

const alerts = new WatchAlerts();
export default alerts;
