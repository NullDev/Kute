import { kute } from "../../client.js";
import marketApi from "./api.js";
import { formatKr } from "./types.js";

// an "Item Stats" button in krunker's item detail header, labeled with the lowest ask and the last sale the
// collector saw. the menu is polled at a slow rate, never a body wide observer, and nothing runs while the
// pointer is locked

const POLL_MS = 1500;
const MARK = "data-kute-market";
const STYLE_ID = "kuteMarketCardStyle";
const CSS = ".kuteDetailBtn .kuteMark{color:#f5479b;font-weight:900;margin-right:2px}";
const DETAIL_SELECTOR = ".item-detail-container, .items-detail-root";
const DETAIL_BTN_CLASS = "kuteDetailBtn";

/** a pick older than this cannot be the item a detail view opened for */
const PICK_MS = 5000;

class Cards {
    constructor(){
        /** @type {number|undefined} */
        this.timer = undefined;
        this.busy = false;
        /** @type {{skin:number,name:string,at:number}|null} */
        this.pick = null;
        // trade lists carry the skin in their ids, their detail view only shows a name and a background image
        this.onPick = (/** @type {Event} */ event) => {
            if (document.pointerLockElement || !(event.target instanceof Element)) return;
            const node = event.target.closest("[id^='trd_'], .trade-inv-item[data-index]");
            if (!node) return;
            const match = /^trd_(?:sel_|inv_)?\d+_(\d+)/.exec(node.id);
            const raw = match ? match[1] : node.getAttribute("data-index");
            if (raw === null || !/^\d+$/.test(raw)) return;
            const name = node.querySelector(".tItemN")?.textContent?.trim() ?? "";
            this.pick = { skin: Number(raw), name, at: Date.now() };
        };
    }

    start(){
        if (this.timer !== undefined) return;
        if (!document.getElementById(STYLE_ID)){
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.append(style);
        }
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
        document.addEventListener("pointerdown", this.onPick, true);
    }

    stop(){
        clearInterval(this.timer);
        this.timer = undefined;
        document.removeEventListener("pointerdown", this.onPick, true);
        this.pick = null;
        for (const button of document.querySelectorAll(`.${DETAIL_BTN_CLASS}`)) button.remove();
        for (const node of document.querySelectorAll(`[${MARK}]`)) node.removeAttribute(MARK);
    }

    /**
     * @param {string} src
     * @return {string|null} the path after textures/previews/
     */
    static thumbPath(src){
        const match = /\/textures\/previews\/([^?#]+)/.exec(src);
        return match ? match[1] : null;
    }

    async tick(){
        if (this.busy || document.pointerLockElement) return;
        const detail = document.querySelector(DETAIL_SELECTOR);
        // the catalog view stays mounted and swaps its item, its label tells them apart
        const label = detail?.getAttribute("aria-label") ?? "1";
        if (!detail || detail.getAttribute(MARK) === label) return;
        this.busy = true;
        try {
            detail.setAttribute(MARK, label);
            detail.querySelector(`.${DETAIL_BTN_CLASS}`)?.remove();
            await this.detailButton(detail, label);
        }
        finally {
            this.busy = false;
        }
    }

    /**
     * the skin a detail view shows: the item just clicked in a trade list, its preview image, or an exact name
     *
     * @param {Element} detail
     * @param {string} label the view's item name
     * @return {Promise<import("./types.js").SkinFacts|null>}
     */
    async detailFacts(detail, label){
        const { pick } = this;
        if (pick && Date.now() - pick.at < PICK_MS && (!pick.name || pick.name === label)){
            const values = await marketApi.values([pick.skin]);
            if (values[pick.skin]) return values[pick.skin];
        }
        const img = detail.querySelector(".market-card img, .items-detail-preview-panel img, img");
        let src = img instanceof HTMLImageElement ? img.currentSrc || img.src : "";
        // the catalog page paints its preview as a css background
        if (!src) src = /url\("?([^")]+)"?\)/.exec(detail.querySelector(".items-detail-image")?.getAttribute("style") ?? "")?.[1] ?? "";
        const path = Cards.thumbPath(src);
        if (path){
            const values = await marketApi.valuesByThumbnails([path]);
            if (values[path]) return values[path];
        }
        if (!label || label === "1") return null;
        const reply = await marketApi.search(label);
        // names repeat across skins (several Cherry Blossoms), only a unique exact match is safe
        const exact = reply?.items.filter((item) => item.name.toLowerCase() === label.toLowerCase()) ?? [];
        return exact.length === 1 ? exact[0] : null;
    }

    /**
     * @param {Element} detail
     * @param {string} label
     */
    async detailButton(detail, label){
        // the market's "Listing Details" (next to Item Info) and the catalog's item page (header actions)
        const actions = detail.querySelector(".full-details-container, .items-detail-header-actions");
        if (!actions) return;
        const button = document.createElement("button");
        button.type = "button";
        const sibling = actions.querySelector("button");
        button.className = `${sibling?.className ?? ""} ${DETAIL_BTN_CLASS}`.trim();
        const icon = sibling?.querySelector("i")?.className ?? "material-icons";
        button.innerHTML = `<i class="${icon}">query_stats</i> <span>Item Stats</span>`;
        button.title = "Last sales, asking prices and supply Kute has on file for this item";
        actions.append(button);
        const facts = await this.detailFacts(detail, label);
        // the view may have switched items while we waited
        if (!facts || detail.getAttribute(MARK) !== label){
            button.remove();
            return;
        }
        const text = button.querySelector("span");
        if (text){
            const parts = [];
            if (facts.lastSoldPrice !== null) parts.push(`sold ${formatKr(facts.lastSoldPrice)}`);
            else if (facts.lastSaleAvg !== null) parts.push(`avg ${formatKr(facts.lastSaleAvg)}`);
            if (facts.lowest !== null) parts.push(`ask ${formatKr(facts.lowest)}`);
            text.textContent = parts.length ? `Item Stats · ${parts.join(" · ")}` : "Item Stats · nothing seen yet";
        }
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            kute.market?.open("item", facts.skin);
        });
    }
}

const cards = new Cards();
export default cards;
