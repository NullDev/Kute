import marketApi from "./api";
import { formatKr, type SkinFacts } from "./types";
import { esc } from "./presentation";
import { CHANGED_EVENT, setOwnPrice } from "./prices";
import { breakdownHtml, resolveEntries, sideOf, type Entry, type Side } from "./tradeFacts";
import template from "../../components/marketOffer.html";

const POLL_MS = 1200;
const SPACING_MS = 2000;
const REFRESH_MS = 10 * 60 * 1000;
const KEEP = 200;

type Offer = {give:Entry[], get:Entry[], giveKr:number, getKr:number, unvalued:string[], key:string};

type Result = {give:Entry[]|null, get:Entry[]|null, facts:Record<string, SkinFacts>, message:string, at:number};

class TradeOffers {
    timer: number | undefined = undefined;
    busy = false;
    nextAt = 0;
    failures = 0;
    waiting = "";
    generation = 0;
    revision = 0;
    results: Map<string, Result> = new Map();
    boxes: WeakMap<Element, HTMLDivElement> = new WeakMap();
    shown: WeakMap<HTMLDivElement, string> = new WeakMap();
    onPrices = (): void => {
        this.revision++;
    };
    onChange = (event: Event): void => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.dataset.ownSkin) return;
        const value = Number(input.value);
        setOwnPrice({ skin: Number(input.dataset.ownSkin), name: input.dataset.ownName ?? "" }, value > 0 ? value : null);
    };

    start(): void{
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => this.tick(), POLL_MS);
        window.addEventListener(CHANGED_EVENT, this.onPrices);
    }

    stop(): void{
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        window.removeEventListener(CHANGED_EVENT, this.onPrices);
        for (const box of document.querySelectorAll(".kuteOfferBox")) box.remove();
        this.boxes = new WeakMap();
    }

    static read(holder: Element): Offer | null{
        const contents = holder.querySelectorAll(":scope > .offer-items-row > .offer-contents");
        if (contents.length !== 2) return null;
        const unvalued: Set<string> = new Set();
        const side = (content: Element): { items: Entry[], kr: number } => {
            const items = [...content.querySelectorAll(".trade-item:not(.trade-item-empty)")].map((node) => {
                const raw = node.getAttribute("data-index");
                const skin = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
                const entry: Entry = { skin, count: 1 };
                if (skin < 0) entry.path = /\/textures\/previews\/([^?#]+)/.exec(node.querySelector("img")?.getAttribute("src") ?? "")?.[1] ?? "";
                for (const [key, attr] of [["serial", "data-serial"], ["wear", "data-wear-float"], ["style", "data-style"]] as const){
                    const value = node.getAttribute(attr);
                    if (value !== null && value !== "" && Number.isFinite(Number(value))) entry[key] = Number(value);
                }
                return entry;
            });
            let kr = 0;
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

    box(holder: Element): HTMLDivElement{
        let box = this.boxes.get(holder);
        if (!box?.isConnected){
            box = document.createElement("div");
            box.className = "kuteOfferBox";
            box.style.cssText = "all:initial;display:block;box-sizing:border-box;width:100%;min-width:0;";
            const shadow = box.attachShadow({ mode: "open" });
            shadow.innerHTML = template;
            shadow.addEventListener("change", this.onChange);
            holder.append(box);
            this.boxes.set(holder, box);
        }
        return box;
    }

    tick(): void{
        if (this.timer === undefined || document.pointerLockElement || document.hidden) return;
        const holders = document.querySelectorAll(".offer-holder");
        if (!holders.length) return;
        const now = Date.now();
        let pending: Offer | null = null;
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

    async lookup(offer: Offer): Promise<void>{
        this.busy = true;
        const {generation} = this;
        try {
            const result = await this.evaluate(offer);
            if (generation !== this.generation || !result) return;
            this.results.delete(offer.key);
            this.results.set(offer.key, result);
            if (this.results.size > KEEP) this.results.delete(this.results.keys().next().value as string);
        }
        finally {
            this.busy = false;
        }
        this.tick();
    }

    async evaluate(offer: Offer): Promise<Result | null>{
        if (!offer.give.length && !offer.get.length && !offer.giveKr && !offer.getKr) return { give: null, get: null, facts: {}, message: "This offer has nothing in it.", at: Date.now() };
        this.nextAt = Date.now() + SPACING_MS;
        const lookup = (paths: string[]): Promise<Record<string, SkinFacts>> => marketApi.valuesByThumbnails(paths);
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

    static render(box: HTMLDivElement, offer: Offer, result: Result | null, waiting: string): void{
        const panel = box.shadowRoot?.querySelector(".panel");
        if (!panel) return;
        const open = panel.querySelector("details")?.open ?? false;
        if (!result || !result.give || !result.get){
            panel.innerHTML = `<div class="row"><span class="brand">Kute</span><span class="empty" role="status">${esc(result?.message || waiting)}</span></div>`;
            return;
        }
        const give = sideOf(result.give, offer.giveKr, result.facts);
        const get = sideOf(result.get, offer.getKr, result.facts);
        const total = (side: Side): string => side.total === null ? `<b>–</b> <small>${side.priced}/${side.lines.length} priced</small>` : `<b>${formatKr(side.total)}</b> KR`;
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
