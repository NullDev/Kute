import { kute } from "../../client";
import marketApi from "./api";
import { formatKr, type SkinFacts } from "./types";

const POLL_MS = 1500;
const MARK = "data-kute-market";
const STYLE_ID = "kuteMarketCardStyle";
const CSS = ".kuteDetailBtn .kuteMark{color:#f5479b;font-weight:900;margin-right:2px}";
const DETAIL_SELECTOR = ".item-detail-container, .items-detail-root";
const DETAIL_BTN_CLASS = "kuteDetailBtn";

const PICK_MS = 5000;

class Cards {
    timer: number | undefined = undefined;
    busy = false;
    pick: { skin: number, name: string, at: number } | null = null;
    onPick = (event: Event): void => {
        if (document.pointerLockElement || !(event.target instanceof Element)) return;
        const node = event.target.closest("[id^='trd_'], .trade-inv-item[data-index]");
        if (!node) return;
        const match = /^trd_(?:sel_|inv_)?\d+_(\d+)/.exec(node.id);
        const raw = match ? match[1] : node.getAttribute("data-index");
        if (raw === null || !/^\d+$/.test(raw)) return;
        const name = node.querySelector(".tItemN")?.textContent?.trim() ?? "";
        this.pick = { skin: Number(raw), name, at: Date.now() };
    };

    start(): void{
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

    stop(): void{
        clearInterval(this.timer);
        this.timer = undefined;
        document.removeEventListener("pointerdown", this.onPick, true);
        this.pick = null;
        for (const button of document.querySelectorAll(`.${DETAIL_BTN_CLASS}`)) button.remove();
        for (const node of document.querySelectorAll(`[${MARK}]`)) node.removeAttribute(MARK);
    }

    static thumbPath(src: string): string | null{
        const match = /\/textures\/previews\/([^?#]+)/.exec(src);
        return match ? match[1] : null;
    }

    async tick(): Promise<void>{
        if (this.busy || document.pointerLockElement) return;
        const detail = document.querySelector(DETAIL_SELECTOR);
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

    async detailFacts(detail: Element, label: string): Promise<SkinFacts | null>{
        const { pick } = this;
        if (pick && Date.now() - pick.at < PICK_MS && (!pick.name || pick.name === label)){
            const values = await marketApi.values([pick.skin]);
            if (values[pick.skin]) return values[pick.skin];
        }
        const img = detail.querySelector(".market-card img, .items-detail-preview-panel img, img");
        let src = img instanceof HTMLImageElement ? img.currentSrc || img.src : "";
        if (!src) src = /url\("?([^")]+)"?\)/.exec(detail.querySelector(".items-detail-image")?.getAttribute("style") ?? "")?.[1] ?? "";
        const path = Cards.thumbPath(src);
        if (path){
            const values = await marketApi.valuesByThumbnails([path]);
            if (values[path]) return values[path];
        }
        if (!label || label === "1") return null;
        const reply = await marketApi.search(label);
        const exact = reply?.items.filter((item) => item.name.toLowerCase() === label.toLowerCase()) ?? [];
        return exact.length === 1 ? exact[0] : null;
    }

    async detailButton(detail: Element, label: string): Promise<void>{
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
