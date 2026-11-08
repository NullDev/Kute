import marketApi from "./api.js";
import { esc } from "./presentation.js";
import { CHANGED_EVENT, setOwnPrice } from "./prices.js";
import { breakdownHtml, differenceHtml, resolveEntries, sideHtml, sideOf } from "./tradeFacts.js";
import template from "../../components/marketTrade.html";

const POLL_MS = 1200;

/**
 * @typedef {import("./tradeFacts.js").Entry} Entry
 * @typedef {{give:Entry[],get:Entry[],giveKr:number,getKr:number,anchor:Element,slot?:HTMLElement|null,key:string}} Snapshot
 */

class TradeWindows {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.lastKey = "";
        this.retryAt = 0;
        this.failures = 0;
        this.generation = 0;
        this.busy = false;
        this.expanded = false;
        /** @type {{give:Entry[],get:Entry[],facts:Record<string, import("./types.js").SkinFacts>}|null} the last resolved trade, redrawn when a price changes */
        this.resolved = null;
        this.resolvedKey = "";
        this.dismiss = (/** @type {Event} */ event) => {
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
        this.onPrices = () => {
            // the key forces a redraw from the kept facts on the next tick
            this.lastKey = "";
        };
        this.onChange = (/** @type {Event} */ event) => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement) || !input.dataset.ownSkin) return;
            const value = Number(input.value);
            setOwnPrice({ skin: Number(input.dataset.ownSkin), name: input.dataset.ownName ?? "" }, value > 0 ? value : null);
        };
        /** @type {HTMLDivElement|null} */
        this.box = null;
        /** @type {HTMLElement|null} */
        this.chatList = null;
    }

    /** @param {Snapshot} snapshot */
    placed(snapshot){
        return snapshot.slot ? snapshot.slot.firstElementChild === this.box : this.box?.nextElementSibling === snapshot.anchor;
    }

    start(){
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
        window.addEventListener("pointerdown", this.dismiss, true);
        window.addEventListener("keydown", this.dismiss, true);
        window.addEventListener(CHANGED_EVENT, this.onPrices);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        window.removeEventListener("pointerdown", this.dismiss, true);
        window.removeEventListener("keydown", this.dismiss, true);
        window.removeEventListener(CHANGED_EVENT, this.onPrices);
        this.clear();
    }

    clear(){
        this.box?.remove();
        this.box = null;
        if (this.chatList) this.chatList.style.maxHeight = "";
        this.chatList = null;
        this.lastKey = "";
        this.resolved = null;
        this.expanded = false;
    }

    /** @param {string} text */
    static kr(text){
        const match = /([\d,.]+)/.exec(text.replace(/[~\s]/g, ""));
        return match ? Number(match[1].replace(/,/g, "")) || 0 : 0;
    }

    /** @param {Element} first @param {Element} second */
    static row(first, second){
        let parent = first.parentElement;
        while (parent && !parent.contains(second)) parent = parent.parentElement;
        return parent && parent !== document.body ? parent : null;
    }

    /** @return {Snapshot|null} */
    snapshot(){
        const sides = [...document.querySelectorAll(".trade-window .trade-side")].filter((side) => side.getClientRects().length);
        if (sides.length >= 2){
            const anchor = TradeWindows.row(sides[0], sides[1]);
            if (!anchor) return null;
            /** @param {Element} side */
            const items = (side) => [...side.querySelectorAll(".trade-offer-scroll .trade-inv-item")].map((node) => {
                const raw = node.getAttribute("data-index");
                const skin = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
                const src = node.querySelector("img")?.getAttribute("src") ?? "";
                /** @type {Entry} */
                const entry = { skin, count: TradeWindows.kr(node.querySelector(".trade-item-count")?.textContent ?? "1") || 1 };
                if (skin < 0) entry.path = /\/textures\/previews\/([^?#]+)/.exec(src)?.[1] ?? "";
                for (const [key, attr] of /** @type {const} */ ([["serial", "data-serial"], ["wear", "data-wear-float"], ["style", "data-style"]])){
                    const value = node.getAttribute(attr);
                    if (value !== null && value !== "" && Number.isFinite(Number(value))) entry[key] = Number(value);
                }
                return entry;
            });
            const give = items(sides[0]);
            const get = items(sides[1]);
            // .trade-est is the game's estimate, never currency added to the offer
            return { give, get, giveKr: 0, getKr: 0, anchor, key: JSON.stringify([give, get]) };
        }
        const lists = [document.getElementById("tradeList0"), document.getElementById("tradeList1")];
        if (!lists[0]?.getClientRects().length || !lists[1]?.getClientRects().length) return null;
        const anchor = TradeWindows.row(lists[0], lists[1]);
        if (!anchor) return null;
        /** @param {Element} list */
        const items = (list) => [...list.querySelectorAll("[id^='trd_']")].flatMap((node) => {
            // the plaza names selected items trd_sel_<side>_<skin>, inventory entries trd_inv_* stay out
            const match = /^trd_(?:sel_)?\d+_(\d+)(?:_\d+)?$/.exec(node.id);
            return match ? [{ skin: Number(match[1]), count: TradeWindows.kr(node.querySelector(".tItemCnt")?.textContent ?? "1") || 1 }] : [];
        });
        // offered KR is currency 1 in the list; offerVal0/1 show the game's own estimate, never the offer
        /** @param {number} side */
        const kr = (side) => Math.max(0, TradeWindows.kr(document.getElementById(`currency_item_${side}_1`)?.querySelector(".tCurrencyAmount")?.textContent ?? "0"));
        const give = items(lists[0]);
        const get = items(lists[1]);
        const giveKr = kr(0);
        const getKr = kr(1);
        // #menuWindow caps its height, a panel above the lists pushed accept/decline out of view
        const chat = document.getElementById("tradeChatHolder");
        const slot = chat?.getClientRects().length ? chat : null;
        return { give, get, giveKr, getKr, anchor, slot, key: JSON.stringify([give, get, giveKr, getKr]) };
    }

    /** @param {Snapshot} snapshot @param {number} generation */
    current(snapshot, generation){
        if (this.timer === undefined || generation !== this.generation || document.pointerLockElement || document.hidden) return false;
        const now = this.snapshot();
        return now?.anchor === snapshot.anchor && now.key === snapshot.key;
    }

    async tick(){
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
            const lookup = (/** @type {string[]} */ paths) => marketApi.valuesByThumbnails(paths);
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

    /** @param {Snapshot} snapshot @param {{give:Entry[],get:Entry[],facts:Record<string, import("./types.js").SkinFacts>}|null} resolved @param {string} fallback */
    render(snapshot, resolved, fallback){
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
            // the chat is pinned to the column's bottom and would grow over the panel
            this.chatList = document.getElementById("tradeChatList");
            const input = document.getElementById("tradeChatInput");
            if (this.chatList) this.chatList.style.maxHeight = `${Math.max(80, snapshot.slot.clientHeight - this.box.offsetHeight - (input?.offsetHeight ?? 0) - 20)}px`;
        }
        // the game lays out the inventories as a flex row; our panel must be its sibling
        else if (!this.placed(snapshot)) snapshot.anchor.before(this.box);
    }
}

const trade = new TradeWindows();
export default trade;
