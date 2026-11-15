import marketApi from "./api";
import { esc } from "./presentation";
import { CHANGED_EVENT, setOwnPrice } from "./prices";
import { breakdownHtml, differenceHtml, resolveEntries, sideHtml, sideOf, type Entry } from "./tradeFacts";
import template from "../../components/marketTrade.html";
import type { SkinFacts } from "./types";

const POLL_MS = 1200;

type Snapshot = {give:Entry[], get:Entry[], giveKr:number, getKr:number, anchor:Element, slot?:HTMLElement|null, key:string};

class TradeWindows {
    timer: number | undefined = undefined;
    lastKey = "";
    retryAt = 0;
    failures = 0;
    generation = 0;
    busy = false;
    expanded = false;
    resolved: { give: Entry[]; get: Entry[]; facts: Record<string, SkinFacts>; } | null = null;
    resolvedKey = "";
    dismiss = (event: Event): void => {
        const details = this.box?.shadowRoot?.querySelector("details");
        if (!details?.open) return;
        if (event instanceof KeyboardEvent){
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            details.querySelector("summary")?.focus();
        }
        else if (event.target instanceof Node && this.box?.contains(event.target)) return;
        details.open = false;
        this.expanded = false;
    };
    onPrices = (): void => {
        this.lastKey = "";
    };
    onChange = (event: Event): void => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.dataset.ownSkin) return;
        const value = Number(input.value);
        setOwnPrice({ skin: Number(input.dataset.ownSkin), name: input.dataset.ownName ?? "" }, value > 0 ? value : null);
    };
    box: HTMLDivElement | null = null;
    chatList: HTMLElement | null = null;

    placed(snapshot: Snapshot): boolean{
        return snapshot.slot ? snapshot.slot.firstElementChild === this.box : this.box?.nextElementSibling === snapshot.anchor;
    }

    start(): void{
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
        window.addEventListener("pointerdown", this.dismiss, true);
        window.addEventListener("keydown", this.dismiss, true);
        window.addEventListener(CHANGED_EVENT, this.onPrices);
    }

    stop(): void{
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        window.removeEventListener("pointerdown", this.dismiss, true);
        window.removeEventListener("keydown", this.dismiss, true);
        window.removeEventListener(CHANGED_EVENT, this.onPrices);
        this.clear();
    }

    clear(): void{
        this.box?.remove();
        this.box = null;
        if (this.chatList) this.chatList.style.maxHeight = "";
        this.chatList = null;
        this.lastKey = "";
        this.resolved = null;
        this.expanded = false;
    }

    static kr(text: string): number{
        const match = /([\d,.]+)/.exec(text.replace(/[~\s]/g, ""));
        return match ? Number(match[1].replace(/,/g, "")) || 0 : 0;
    }

    static row(first: Element, second: Element): HTMLElement | null{
        let parent = first.parentElement;
        while (parent && !parent.contains(second)) parent = parent.parentElement;
        return parent && parent !== document.body ? parent : null;
    }

    snapshot(): Snapshot | null{
        const sides = [...document.querySelectorAll(".trade-window .trade-side")].filter((side) => side.getClientRects().length);
        if (sides.length >= 2){
            const anchor = TradeWindows.row(sides[0], sides[1]);
            if (!anchor) return null;
            const items = (side: Element): Entry[] => [...side.querySelectorAll(".trade-offer-scroll .trade-inv-item")].map((node) => {
                const raw = node.getAttribute("data-index");
                const skin = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
                const src = node.querySelector("img")?.getAttribute("src") ?? "";
                const entry: Entry = { skin, count: TradeWindows.kr(node.querySelector(".trade-item-count")?.textContent ?? "1") || 1 };
                if (skin < 0) entry.path = /\/textures\/previews\/([^?#]+)/.exec(src)?.[1] ?? "";
                for (const [key, attr] of [["serial", "data-serial"], ["wear", "data-wear-float"], ["style", "data-style"]] as const){
                    const value = node.getAttribute(attr);
                    if (value !== null && value !== "" && Number.isFinite(Number(value))) entry[key] = Number(value);
                }
                return entry;
            });
            const give = items(sides[0]);
            const get = items(sides[1]);
            return { give, get, giveKr: 0, getKr: 0, anchor, key: JSON.stringify([give, get]) };
        }
        const lists = [document.getElementById("tradeList0"), document.getElementById("tradeList1")];
        if (!lists[0]?.getClientRects().length || !lists[1]?.getClientRects().length) return null;
        const anchor = TradeWindows.row(lists[0], lists[1]);
        if (!anchor) return null;
        const items = (list: Element): { skin: number, count: number }[] => [...list.querySelectorAll("[id^='trd_']")].flatMap((node) => {
            const match = /^trd_(?:sel_)?\d+_(\d+)(?:_\d+)?$/.exec(node.id);
            return match ? [{ skin: Number(match[1]), count: TradeWindows.kr(node.querySelector(".tItemCnt")?.textContent ?? "1") || 1 }] : [];
        });
        const kr = (side: number): number => Math.max(0, TradeWindows.kr(document.getElementById(`currency_item_${side}_1`)?.querySelector(".tCurrencyAmount")?.textContent ?? "0"));
        const give = items(lists[0]);
        const get = items(lists[1]);
        const giveKr = kr(0);
        const getKr = kr(1);
        const chat = document.getElementById("tradeChatHolder");
        const slot = chat?.getClientRects().length ? chat : null;
        return { give, get, giveKr, getKr, anchor, slot, key: JSON.stringify([give, get, giveKr, getKr]) };
    }

    current(snapshot: Snapshot, generation: number): boolean{
        if (this.timer === undefined || generation !== this.generation || document.pointerLockElement || document.hidden) return false;
        const now = this.snapshot();
        return now?.anchor === snapshot.anchor && now.key === snapshot.key;
    }

    async tick(): Promise<void>{
        if (this.busy || this.timer === undefined || document.pointerLockElement || document.hidden) return;
        this.busy = true;
        const {generation} = this;
        try {
            const snapshot = this.snapshot();
            if (!snapshot){ this.clear(); return; }
            if (Date.now() < this.retryAt) return;
            if (snapshot.key === this.lastKey && this.box?.isConnected && this.placed(snapshot)) return;
            const sameTrade = this.resolved && snapshot.key === this.resolvedKey;
            this.lastKey = snapshot.key;
            const empty = !snapshot.give.length && !snapshot.get.length && !snapshot.giveKr && !snapshot.getKr;
            if (sameTrade){
                this.render(snapshot, this.resolved, "");
                return;
            }
            this.render(snapshot, null, empty ? "Add items on both sides to see what they sold and list for." : "Looking up the items...");
            if (empty) return;
            const lookup = (paths: string[]): Promise<Record<string, SkinFacts>> => marketApi.valuesByThumbnails(paths);
            const give = await resolveEntries(snapshot.give, lookup);
            const get = await resolveEntries(snapshot.get, lookup);
            if (!this.current(snapshot, generation)) return;
            if (!give || !get){
                this.render(snapshot, null, "An item could not be identified.");
                return;
            }
            const facts = await marketApi.values([...give, ...get].map((e) => e.skin));
            if (!this.current(snapshot, generation)) return;
            const got = Object.keys(facts).length > 0 || ![...give, ...get].length;
            if (got){
                this.failures = 0;
                this.retryAt = 0;
                this.resolved = { give, get, facts };
                this.resolvedKey = snapshot.key;
                this.render(snapshot, this.resolved, "");
            }
            else {
                this.failures++;
                this.retryAt = marketApi.retryAt > Date.now() ? marketApi.retryAt : Date.now() + Math.min(60_000, 5000 * 2 ** (this.failures - 1));
                this.lastKey = "";
                this.render(snapshot, null, marketApi.lastError || "Item stats unavailable. Retrying with a longer delay.");
            }
        }
        finally {
            this.busy = false;
        }
    }

    render(snapshot: Snapshot, resolved: { give: Entry[]; get: Entry[]; facts: Record<string, SkinFacts>; } | null, fallback: string): void{
        if (!this.box){
            this.box = document.createElement("div");
            this.box.className = "kuteTradeBox";
            this.box.style.cssText = "all:initial;display:block;box-sizing:border-box;width:100%;min-width:0;margin:0 0 10px;container-type:inline-size;";
            const shadow = this.box.attachShadow({ mode: "open" });
            shadow.innerHTML = template;
            shadow.addEventListener("change", this.onChange);
        }
        const panel = this.box.shadowRoot?.querySelector(".panel");
        if (!panel) return;
        panel.className = `panel${snapshot.give.length || snapshot.get.length || snapshot.giveKr || snapshot.getKr ? " filled" : ""}`;
        this.expanded = panel.querySelector("details")?.open ?? this.expanded;
        let html = '<header><span class="brand">Kute item stats</span>';
        if (!resolved) html += `</header><p class="empty" role="status">${esc(fallback)}</p>`;
        else {
            const give = sideOf(resolved.give, snapshot.giveKr, resolved.facts);
            const get = sideOf(resolved.get, snapshot.getKr, resolved.facts);
            html += '<span class="status">Last sales and asks on file, totals only from your own prices</span></header>';
            html += `<div class="comparison">${sideHtml(give, "You give")}<div class="difference">${differenceHtml(give, get)}</div>${sideHtml(get, "You receive")}</div>`;
            html += `<details${this.expanded ? " open" : ""}><summary><span class="show">Items, facts &amp; your prices</span><span class="hide">Hide items</span></summary><div class="detailBody"><div class="breakdown">${breakdownHtml(give, "You give")}${breakdownHtml(get, "You receive")}</div></div></details>`;
        }
        panel.innerHTML = html;
        if (snapshot.slot){
            if (!this.placed(snapshot)) snapshot.slot.prepend(this.box);
            this.chatList = document.getElementById("tradeChatList");
            const input = document.getElementById("tradeChatInput");
            if (this.chatList) this.chatList.style.maxHeight = `${Math.max(80, snapshot.slot.clientHeight - this.box.offsetHeight - (input?.offsetHeight ?? 0) - 20)}px`;
        }
        else if (!this.placed(snapshot)) snapshot.anchor.before(this.box);
    }
}

const trade = new TradeWindows();
export default trade;
