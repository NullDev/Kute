import marketApi from "./api.js";
import { formatKr } from "./types.js";
import { esc } from "./presentation.js";
import { CHANGED_EVENT, setOwnPrice } from "./prices.js";
import { breakdownHtml, resolveEntries, sideOf } from "./tradeFacts.js";
import template from "../../components/marketOffer.html";

const POLL_MS = 1200;
/** facts are cached for five minutes by the api module, a redraw is free; lookups stay spaced */
const SPACING_MS = 2000;
const REFRESH_MS = 10 * 60 * 1000;
const KEEP = 200;

/**
 * @typedef {import("./tradeFacts.js").Entry} Entry
 * @typedef {{give:Entry[],get:Entry[],giveKr:number,getKr:number,unvalued:string[],key:string}} Offer
 * @typedef {{give:Entry[]|null,get:Entry[]|null,facts:Record<string, import("./types.js").SkinFacts>,message:string,at:number}} Result
 */

class TradeOffers {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.busy = false;
        this.nextAt = 0;
        this.failures = 0;
        this.waiting = "";
        this.generation = 0;
        this.revision = 0;
        /** @type {Map<string, Result>} */
        this.results = new Map();
        /** @type {WeakMap<Element, HTMLDivElement>} */
        this.boxes = new WeakMap();
        /** @type {WeakMap<HTMLDivElement, string>} */
        this.shown = new WeakMap();
        this.onPrices = () => {
            this.revision++;
        };
        this.onChange = (/** @type {Event} */ event) => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement) || !input.dataset.ownSkin) return;
            const value = Number(input.value);
            setOwnPrice({ skin: Number(input.dataset.ownSkin), name: input.dataset.ownName ?? "" }, value > 0 ? value : null);
        };
    }

    start(){
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
        window.addEventListener(CHANGED_EVENT, this.onPrices);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        window.removeEventListener(CHANGED_EVENT, this.onPrices);
        for (const box of document.querySelectorAll(".kuteOfferBox")) box.remove();
        this.boxes = new WeakMap();
    }

    /**
     * the first column is always the player's own side, in incoming, outgoing and history alike
     *
     * @param {Element} holder
     * @return {Offer|null}
     */
    static read(holder){
        const contents = holder.querySelectorAll(":scope > .offer-items-row > .offer-contents");
        if (contents.length !== 2) return null;
        /** @type {Set<string>} */
        const unvalued = new Set();
        /** @param {Element} content */
        const side = (content) => {
            const items = [...content.querySelectorAll(".trade-item:not(.trade-item-empty)")].map((node) => {
                const raw = node.getAttribute("data-index");
                const skin = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
                /** @type {Entry} */
                const entry = { skin, count: 1 };
                if (skin < 0) entry.path = /\/textures\/previews\/([^?#]+)/.exec(node.querySelector("img")?.getAttribute("src") ?? "")?.[1] ?? "";
                for (const [key, attr] of /** @type {const} */ ([["serial", "data-serial"], ["wear", "data-wear-float"], ["style", "data-style"]])){
                    const value = node.getAttribute(attr);
                    if (value !== null && value !== "" && Number.isFinite(Number(value))) entry[key] = Number(value);
                }
                return entry;
            });
            let kr = 0;
            // "+1,234 KR" from toLocaleString, so the separator follows the player's locale
            for (const node of content.querySelectorAll(".trade-currency-item")){
                const match = /^\+?\s*(.*?)\s*([A-Za-z]+)$/.exec(node.textContent?.trim() ?? "");
                const digits = match?.[1].replace(/\D/g, "") ?? "";
                if (match?.[2] === "KR" && digits) kr += Number(digits);
                else unvalued.add(match?.[2] ?? "?");
            }
            return { items, kr };
        };
        const give = side(contents[0]);
        const get = side(contents[1]);
        const offer = { give: give.items, get: get.items, giveKr: give.kr, getKr: get.kr, unvalued: [...unvalued].sort() };
        return { ...offer, key: JSON.stringify(offer) };
    }

    /** @param {Element} holder */
    box(holder){
        let box = this.boxes.get(holder);
        if (!box?.isConnected){
            box = document.createElement("div");
            box.className = "kuteOfferBox";
            box.style.cssText = "all:initial;display:block;box-sizing:border-box;width:100%;min-width:0;";
            const shadow = box.attachShadow({ mode: "open" });
            shadow.innerHTML = template;
            shadow.addEventListener("change", this.onChange);
            // svelte inserts before its own anchors, so the end of the holder stays ours
            holder.append(box);
            this.boxes.set(holder, box);
        }
        return box;
    }

    tick(){
        if (this.timer === undefined || document.pointerLockElement || document.hidden) return;
        const holders = document.querySelectorAll(".offer-holder");
        if (!holders.length) return;
        const now = Date.now();
        /** @type {Offer|null} */
        let pending = null;
        for (const holder of holders){
            if (!holder.getClientRects().length) continue;
            const offer = TradeOffers.read(holder);
            if (!offer) continue;
            const result = this.results.get(offer.key) ?? null;
            const box = this.box(holder);
            const waiting = this.waiting && now < this.nextAt ? this.waiting : "Looking up the items...";
            const state = `${offer.key}|${result?.at ?? waiting}|${this.revision}`;
            if (this.shown.get(box) !== state){
                this.shown.set(box, state);
                TradeOffers.render(box, offer, result, waiting);
            }
            if (pending || (result && now - result.at < REFRESH_MS)) continue;
            const rect = holder.getBoundingClientRect();
            if (rect.bottom > 0 && rect.top < window.innerHeight) pending = offer;
        }
        if (pending && !this.busy && now >= this.nextAt) this.lookup(pending);
    }

    /** @param {Offer} offer */
    async lookup(offer){
        this.busy = true;
        const {generation} = this;
        try {
            const result = await this.evaluate(offer);
            if (generation !== this.generation || !result) return;
            this.results.delete(offer.key);
            this.results.set(offer.key, result);
            if (this.results.size > KEEP) this.results.delete(/** @type {string} */ (this.results.keys().next().value));
        }
        finally {
            this.busy = false;
        }
        this.tick();
    }

    /** @param {Offer} offer @return {Promise<Result|null>} */
    async evaluate(offer){
        if (!offer.give.length && !offer.get.length && !offer.giveKr && !offer.getKr) return { give: null, get: null, facts: {}, message: "This offer has nothing in it.", at: Date.now() };
        this.nextAt = Date.now() + SPACING_MS;
        const lookup = (/** @type {string[]} */ paths) => marketApi.valuesByThumbnails(paths);
        const give = await resolveEntries(offer.give, lookup);
        const get = await resolveEntries(offer.get, lookup);
        if (!give || !get) return { give: null, get: null, facts: {}, message: "An item could not be identified.", at: Date.now() };
        const skins = [...give, ...get].map((e) => e.skin);
        const facts = skins.length ? await marketApi.values(skins) : {};
        if (!skins.length || Object.keys(facts).length){
            this.failures = 0;
            this.waiting = "";
            return { give, get, facts, message: "", at: Date.now() };
        }
        this.failures++;
        this.nextAt = marketApi.retryAt > Date.now() ? marketApi.retryAt : Date.now() + Math.min(60_000, 5000 * 2 ** (this.failures - 1));
        this.waiting = marketApi.lastError || "Item stats unavailable. Retrying with a longer delay.";
        return null;
    }

    /** @param {HTMLDivElement} box @param {Offer} offer @param {Result|null} result @param {string} waiting */
    static render(box, offer, result, waiting){
        const panel = box.shadowRoot?.querySelector(".panel");
        if (!panel) return;
        const open = panel.querySelector("details")?.open ?? false;
        if (!result || !result.give || !result.get){
            panel.innerHTML = `<div class="row"><span class="brand">Kute</span><span class="empty" role="status">${esc(result?.message || waiting)}</span></div>`;
            return;
        }
        const give = sideOf(result.give, offer.giveKr, result.facts);
        const get = sideOf(result.get, offer.getKr, result.facts);
        /** @param {import("./tradeFacts.js").Side} side */
        const total = (side) => side.total === null ? `<b>–</b> <small>${side.priced}/${side.lines.length} priced</small>` : `<b>${formatKr(side.total)}</b> KR`;
        let difference = "";
        if (give.total !== null && get.total !== null && (give.lines.length || give.kr) && (get.lines.length || get.kr)){
            const d = get.total - give.total;
            difference = `<span class="diff">${d > 0 ? "+" : ""}${formatKr(d)} KR <small>by your prices</small></span>`;
        }
        const note = offer.unvalued.length ? `<small class="meta">${esc(offer.unvalued.join(", "))} in this offer ${offer.unvalued.length === 1 ? "is" : "are"} not KR</small>` : "";
        panel.innerHTML = `<div class="row"><span class="brand">Kute</span><span class="sides">You give ${total(give)} &middot; You receive ${total(get)}</span>${difference}${note}</div>`
            + `<details${open ? " open" : ""}><summary><span class="show">Items, facts &amp; your prices</span><span class="hide">Hide items</span></summary><div class="breakdown">${breakdownHtml(give, "You give")}${breakdownHtml(get, "You receive")}</div></details>`;
    }
}

const offers = new TradeOffers();
export default offers;
