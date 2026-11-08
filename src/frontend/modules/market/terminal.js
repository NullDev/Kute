import { TITLES } from "./navigation.js";
import { searchView } from "./views/search.js";
import { itemView } from "./views/item.js";
import { watchlistView } from "./views/watchlist.js";
import { pricesView } from "./views/prices.js";
import { introView } from "./views/intro.js";
import { tableView } from "./views/table.js";
import { helpView } from "./views/help.js";
import marketApi from "./api.js";
import { formatAge } from "./types.js";
import { empty } from "./presentation.js";
import { readWatchlist, saveWatchlist, toggleWatch } from "./watchlist.js";
import { parsePrices, readPrices, savePrices, setOwnPrice } from "./prices.js";
import MarketChart from "./chart.js";
import ItemSearch from "./itemSearch.js";
const LAYOUT_KEY = "kute_market_layout";
const SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;

/**
 * @typedef {{q:string,rarity:string,type:string,sort:string,page:number,budget:string,minSales:string}} SearchState
 * @typedef {{skin:number,range:string}} ItemState
 * @typedef {{width:number,height:number,scale:number,maximized:boolean}} Layout
 * @typedef {{html:string,asOf?:number,asOfLabel?:string,points?:import("./chart.js").ChartPoint[],series?:import("./chart.js").Series[],chartOptions?:import("./chart.js").ChartOptions,item?:import("./types.js").ItemPage,listings?:import("./types.js").ListingsReply|null,exportText?:string}} View
 */

const defaultSearch = () => ({ q: "", rarity: "", type: "", sort: "sales", page: 1, budget: "", minSales: "" });

export class Terminal {
    constructor(){
        /** @type {HTMLDivElement|null} */
        this.overlay = null;
        /** @type {ShadowRoot|null} */
        this.shadow = null;
        /** @type {AbortController|null} */
        this.controller = null;
        /** @type {MarketChart|null} */
        this.chart = null;
        /** @type {HTMLElement|null} */
        this.returnFocus = null;
        this.tab = "search";
        /** @type {unknown} */
        this.arg = undefined;
        this.generation = 0;
        /** @type {View|null} */
        this.view = null;
        /** @type {Map<string,{arg:unknown,scroll:number}>} */
        this.saved = new Map();
        this.previous = "search";
        /** @type {ItemSearch|null} */
        this.itemSearch = null;
        /** @type {Layout} */
        this.layout = { width: 0, height: 0, scale: 1, maximized: false };
        try {
            const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
            if (Number.isFinite(saved.width)) this.layout.width = saved.width;
            if (Number.isFinite(saved.height)) this.layout.height = saved.height;
            if (SCALES.includes(saved.scale)) this.layout.scale = saved.scale;
            this.layout.maximized = saved.maximized === true;
        }
        catch { /* defaults */ }
    }

    /** @return {HTMLElement|null} */
    frame(){
        return this.shadow?.querySelector("#km") ?? null;
    }

    applyLayout(){
        const frame = this.frame();
        if (!frame) return;
        const { scale, maximized } = this.layout;
        const maxWidth = window.innerWidth - (maximized ? 0 : 16);
        const maxHeight = window.innerHeight - (maximized ? 0 : 16);
        const width = maximized ? maxWidth : Math.max(Math.min(MIN_WIDTH, maxWidth), Math.min(this.layout.width || Math.min(1180, window.innerWidth * 0.94), maxWidth));
        const height = maximized ? maxHeight : Math.max(Math.min(MIN_HEIGHT, maxHeight), Math.min(this.layout.height || Math.min(820, window.innerHeight * 0.9), maxHeight));
        // zoom scales the box too, so it gets the on-screen size divided back out
        frame.style.zoom = String(scale);
        frame.style.width = `${width / scale}px`;
        frame.style.height = `${height / scale}px`;
        frame.classList.toggle("maximized", maximized);
        const button = this.shadow?.querySelector("#kmMaximize");
        button?.setAttribute("aria-pressed", String(maximized));
        button?.setAttribute("title", maximized ? "Restore size (double-click the header)" : "Maximize (double-click the header)");
        const value = this.shadow?.querySelector("#kmScaleValue");
        if (value) value.textContent = `${Math.round(scale * 100)}%`;
    }

    saveLayout(){
        this.applyLayout();
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
        }
        catch { /* layout stays for this page load */ }
    }

    /** @param {number} step 0 resets */
    rescale(step){
        const index = SCALES.indexOf(this.layout.scale);
        this.layout.scale = step ? SCALES[Math.max(0, Math.min(SCALES.length - 1, index + step))] : 1;
        this.saveLayout();
    }

    toggleMaximized(){
        this.layout.maximized = !this.layout.maximized;
        this.saveLayout();
    }

    /** @param {PointerEvent} event */
    startResize(event){
        const { target } = event;
        const frame = this.frame();
        if (!(target instanceof HTMLElement) || !frame || event.button !== 0) return;
        const { grip } = target.dataset;
        if (!grip) return;
        event.preventDefault();
        target.setPointerCapture(event.pointerId);
        const start = frame.getBoundingClientRect();
        const { clientX, clientY } = event;
        const x = Number(grip.includes("e")) - Number(grip.includes("w"));
        const y = Number(grip.includes("s")) - Number(grip.includes("n"));
        frame.classList.add("resizing");
        /** @param {PointerEvent} move */
        const resize = (move) => {
            // the overlay keeps the window centered, so an edge moves half of what the size changes
            if (x) this.layout.width = Math.max(MIN_WIDTH, start.width + 2 * x * (move.clientX - clientX));
            if (y) this.layout.height = Math.max(MIN_HEIGHT, start.height + 2 * y * (move.clientY - clientY));
            this.applyLayout();
        };
        const end = () => {
            target.removeEventListener("pointermove", resize);
            frame.classList.remove("resizing");
            this.layout.width = Math.round(Math.min(this.layout.width, window.innerWidth - 16));
            this.layout.height = Math.round(Math.min(this.layout.height, window.innerHeight - 16));
            this.saveLayout();
        };
        target.addEventListener("pointermove", resize);
        target.addEventListener("lostpointercapture", end, { once: true });
    }

    /** @param {string} [tab] @param {unknown} [arg] */
    async open(tab, arg){
        if (document.pointerLockElement) return;
        if (!this.overlay){
            const html = await import("../../components/market.html").catch(() => null);
            if (!html || document.pointerLockElement) return;
            if (this.overlay){
                await this.show(tab ?? this.tab, arg);
                return;
            }
            this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const overlay = document.createElement("div");
            // krunker's item detail view stack sits at 2147483646 and the window opens from it
            overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(7,8,13,.78)";
            const host = document.createElement("div");
            overlay.append(host);
            this.shadow = host.attachShadow({ mode: "open" });
            this.shadow.innerHTML = html.default;
            this.overlay = overlay;
            this.controller = new AbortController();
            const { signal } = this.controller;
            document.body.append(overlay);
            this.applyLayout();
            window.addEventListener("resize", () => this.applyLayout(), { signal });
            this.shadow.addEventListener("pointerdown", (event) => this.startResize(/** @type {PointerEvent} */(event)), { signal });
            this.shadow.querySelector(".kmHead")?.addEventListener("dblclick", (event) => {
                if (event.target instanceof Element && !event.target.closest("button,input,label,form")) this.toggleMaximized();
            }, { signal });
            this.itemSearch = new ItemSearch(this.shadow, signal, (item) => this.show("item", item.skin), (q, context) => this.show("search", {
                ...(context === "discover" ? this.readFilters(1) : defaultSearch()),
                q,
                page: 1,
            }));
            this.shadow.addEventListener("click", (event) => this.click(event), { signal });
            this.shadow.addEventListener("change", (event) => this.changed(event), { signal });
            this.shadow.querySelector("#kmSearchForm")?.addEventListener("submit", (event) => {
                event.preventDefault();
                this.show("search", { ...defaultSearch(), q: this.value("#kmGlobalSearch") });
            }, { signal });
            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) this.close();
            }, { signal });
            document.addEventListener("pointerlockchange", () => {
                if (document.pointerLockElement) this.close();
            }, { signal });
            document.addEventListener("keydown", (event) => this.key(event), { signal, capture: true });
            /** @type {HTMLInputElement|null} */
            (this.shadow.querySelector("#kmGlobalSearch"))?.focus();
        }
        await this.show(tab ?? this.tab, arg);
    }

    close(){
        this.remember();
        this.controller?.abort();
        this.controller = null;
        this.itemSearch = null;
        this.chart?.destroy();
        this.chart = null;
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
        this.generation++;
        this.returnFocus?.focus({ preventScroll: true });
    }

    remember(){
        const body = this.shadow?.querySelector("#kmBody");
        if (this.tab === "item") this.arg = this.itemState();
        if (this.tab === "search" && this.shadow?.querySelector("#kmQ")) this.arg = this.readFilters(this.searchState().page);
        if (body) this.saved.set(this.tab, { arg: this.arg, scroll: body.scrollTop });
    }

    /** @param {string} selector */
    value(selector){
        return /** @type {HTMLInputElement|HTMLSelectElement|null} */(this.shadow?.querySelector(selector))?.value ?? "";
    }

    /** @return {SearchState} */
    searchState(){
        return { ...defaultSearch(), ...(typeof this.arg === "object" && this.arg ? this.arg : {}) };
    }

    /** @return {ItemState} */
    itemState(){
        return { skin: typeof this.arg === "number" ? this.arg : 0, range: "1M", ...(typeof this.arg === "object" && this.arg ? this.arg : {}) };
    }

    /** @param {string} tab @param {unknown} [arg] @param {boolean} [keepScroll] */
    async show(tab, arg, keepScroll = false){
        if (!this.shadow) return;
        this.remember();
        if (tab === "item" && this.tab !== "item") this.previous = this.tab;
        const previousScroll = this.saved.get(this.tab)?.scroll ?? 0;
        const stored = this.saved.get(tab);
        this.tab = tab;
        this.arg = arg === undefined ? stored?.arg : arg;
        const generation = ++this.generation;
        this.itemSearch?.dismiss();
        this.chart?.destroy();
        this.chart = null;
        const body = /** @type {HTMLElement} */(this.shadow.querySelector("#kmBody"));
        body.setAttribute("aria-busy", "true");
        body.innerHTML = empty("Loading", "Fetching what is on file.");
        const title = this.shadow.querySelector("#kmTitle");
        if (title) title.textContent = TITLES[/** @type {keyof typeof TITLES} */(tab)] ?? "Item Stats";
        const nav = tab === "item" ? this.previous : tab;
        for (const el of this.shadow.querySelectorAll("[data-nav]")){
            const active = /** @type {HTMLElement} */(el).dataset.nav === nav;
            el.classList.toggle("on", active);
            if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
        }
        this.updateCounts();
        try {
            const view = await this.render(tab);
            if (generation !== this.generation || !this.shadow) return;
            this.view = view;
            body.innerHTML = view.html;
            body.scrollTop = arg === undefined ? stored?.scroll ?? 0 : 0;
            if (keepScroll) body.scrollTop = previousScroll;
            const foot = this.shadow.querySelector("#kmFootRight");
            if (foot) foot.textContent = view.asOf ? `${view.asOfLabel ?? "Facts updated"} ${formatAge(Math.max(0, Date.now() - view.asOf))} ago` : "What the game reported and what Kute saw listed";
            const host = /** @type {HTMLElement|null} */(body.querySelector(".chart"));
            if (host && view.points && view.series) this.chart = new MarketChart(host, view.points, view.series, view.chartOptions);
        }
        catch {
            if (generation !== this.generation) return;
            body.innerHTML = empty("Item stats are unavailable", "Try again in a moment. Your watchlist and prices stay on this device.", '<button class="button" data-action="retry">Try again</button>');
        }
        finally {
            if (generation === this.generation) body.setAttribute("aria-busy", "false");
        }
    }

    updateCounts(){
        const watch = this.shadow?.querySelector("#kmWatchCount");
        if (watch) watch.textContent = String(readWatchlist().length);
        const prices = this.shadow?.querySelector("#kmPriceCount");
        if (prices) prices.textContent = String(Object.keys(readPrices()).length);
    }

    /** @param {string} tab @return {Promise<View>} */
    async render(tab){
        switch (tab){
            case "search":
                return searchView(this);
            case "item":
                return itemView(this);
            case "watchlist":
                return watchlistView(this);
            case "prices":
                return pricesView(this);
            default:
                return helpView(this);
        }
    }

    /** @return {View} */
    unavailable(){
        return {
            html: empty("Item stats are unavailable", marketApi.lastError || "The server could not be reached. Try again in a moment.", '<button class="button" data-action="retry">Try again</button>'),
        };
    }

    /** @param {string} title @param {string} subtitle @param {string} [actions] */
    intro(title, subtitle, actions = ""){
        return introView(this, title, subtitle, actions);
    }

    /** @param {import("./types.js").SkinFacts[]} items */
    table(items){
        return tableView(this, items);
    }

    /** @param {number} [page] */
    applyFilters(page = 1){
        this.show("search", this.readFilters(page));
    }

    /** @param {number} page @return {SearchState} */
    readFilters(page){
        return {
            q: this.value("#kmQ").trim(),
            rarity: this.value("#kmRarity"),
            type: this.value("#kmType"),
            sort: this.value("#kmSort"),
            budget: this.value("#kmBudget"),
            minSales: this.value("#kmSales"),
            page,
        };
    }

    /** @param {string} text */
    status(text){
        const foot = this.shadow?.querySelector("#kmFootRight");
        if (foot) foot.textContent = text;
        const status = this.shadow?.querySelector("#kmPricesStatus");
        if (status) status.textContent = text;
    }

    /** @param {"import"|"export"} mode */
    openSheet(mode){
        const sheet = /** @type {HTMLElement|null} */(this.shadow?.querySelector("#kmPricesSheet"));
        const text = /** @type {HTMLTextAreaElement|null} */(this.shadow?.querySelector("#kmPricesText"));
        const title = this.shadow?.querySelector("#kmPricesSheetTitle");
        if (!sheet || !text) return;
        sheet.hidden = false;
        if (title) title.textContent = mode === "export" ? "Your prices as text" : "Import prices";
        if (mode === "export"){
            text.value = this.view?.exportText ?? "";
            text.select();
            navigator.clipboard?.writeText(text.value).then(() => this.status("Copied to the clipboard.")).catch(() => this.status("Select the text and copy it."));
        }
        else {
            text.value = "";
            text.focus();
        }
    }

    async importPrices(){
        const text = this.value("#kmPricesText");
        const lines = parsePrices(text);
        if (!lines.length){
            this.status("No line with a price found.");
            return;
        }
        const { generation } = this;
        const prices = readPrices();
        const unmatched = [];
        let added = 0;
        for (const line of lines){
            let { skin, name } = line;
            if (skin === null){
                // a line without an id: the one skin of exactly that name, never a guess between two
                const reply = await marketApi.search(name);
                const exact = reply?.items.filter((item) => item.name.toLowerCase() === name.toLowerCase()) ?? [];
                if (exact.length !== 1){
                    unmatched.push(line.line);
                    continue;
                }
                ({ skin, name } = exact[0]);
            }
            if (!prices[skin] && Object.keys(prices).length >= 500){
                unmatched.push(line.line);
                continue;
            }
            prices[skin] = { name: name || prices[skin]?.name || `Item #${skin}`, price: line.price, at: Date.now() };
            added++;
        }
        if (generation !== this.generation) return;
        if (!savePrices(prices)){
            this.status("Could not save on this device.");
            return;
        }
        await this.show("prices", undefined, true);
        this.status(`${added} ${added === 1 ? "price" : "prices"} added${unmatched.length ? `, ${unmatched.length} not matched: ${unmatched.slice(0, 3).join("; ")}${unmatched.length > 3 ? "..." : ""}` : "."}`);
    }

    /** @param {Event} event */
    click(event){
        const el = event.target instanceof Element ? /** @type {HTMLElement|null} */(event.target.closest("button,tr[data-skin]")) : null;
        if (!el || el.hasAttribute("disabled")) return;
        const d = el.dataset;
        if (el.id === "kmClose"){
            this.close();
            return;
        }
        if (el.id === "kmMaximize"){
            this.toggleMaximized();
            return;
        }
        if (d.scale !== undefined){
            this.rescale(Number(d.scale));
            return;
        }
        if (d.nav){
            this.show(d.nav);
            return;
        }
        if (d.skin){
            this.show("item", Number(d.skin));
            return;
        }
        if (d.page){
            this.applyFilters(Number(d.page));
            return;
        }
        if (d.range){
            this.show("item", { ...this.itemState(), range: d.range }, true);
            return;
        }
        if (d.unwatch){
            if (!saveWatchlist(readWatchlist().filter((w) => w.skin !== Number(d.unwatch)))){
                this.storageError();
                return;
            }
            this.show("watchlist", this.arg, true);
            return;
        }
        if (d.ownRemove){
            setOwnPrice({ skin: Number(d.ownRemove), name: "" }, null);
            this.show("prices", undefined, true);
            return;
        }
        switch (d.action){
            case "discover":
                this.show("search", defaultSearch());
                break;
            case "reset-search":
                this.show("search", defaultSearch());
                break;
            case "back":
                this.show(this.previous);
                break;
            case "retry":
                this.retry();
                break;
            case "filters":
                this.applyFilters();
                break;
            case "watch":
                if (this.view?.item){
                    if (!toggleWatch(this.view.item.skin)){
                        this.storageError();
                        return;
                    }
                    this.show("item", this.arg, true);
                }
                break;
            case "prices-import":
                this.openSheet("import");
                break;
            case "prices-export":
                this.openSheet("export");
                break;
            case "prices-copy": {
                const text = /** @type {HTMLTextAreaElement|null} */(this.shadow?.querySelector("#kmPricesText"));
                text?.select();
                if (text) navigator.clipboard?.writeText(text.value).then(() => this.status("Copied to the clipboard.")).catch(() => this.status("Select the text and copy it."));
                break;
            }
            case "prices-apply":
                void this.importPrices();
                break;
            case "prices-close": {
                const sheet = /** @type {HTMLElement|null} */(this.shadow?.querySelector("#kmPricesSheet"));
                if (sheet) sheet.hidden = true;
                break;
            }
            default:
                break;
        }
    }

    storageError(){
        this.status("Could not save on this device. The watchlist holds up to 100 items, prices up to 500.");
    }

    async retry(){
        const { generation } = this;
        await marketApi.retry();
        if (generation === this.generation) await this.show(this.tab, this.arg);
    }

    /** @param {Event} event */
    changed(event){
        const el = event.target;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
        if (el.dataset.target){
            const value = Number(el.value);
            const watch = readWatchlist().map((w) => w.skin === Number(el.dataset.target) ? { ...w, target: value > 0 && Number.isFinite(value) ? value : null } : w);
            if (!saveWatchlist(watch)){
                this.storageError();
                return;
            }
            this.show("watchlist", this.arg, true);
        }
        else if (el.dataset.ownSkin){
            const value = Number(el.value);
            if (!setOwnPrice({ skin: Number(el.dataset.ownSkin), name: el.dataset.ownName ?? "" }, value > 0 && Number.isFinite(value) ? value : null)){
                this.storageError();
                return;
            }
            this.updateCounts();
            if (this.tab !== "item") this.show(this.tab, this.arg, true);
        }
        else if (el.closest("#kmFilters") && el instanceof HTMLSelectElement) this.applyFilters();
    }

    /** @param {KeyboardEvent} event */
    key(event){
        if (!this.shadow) return;
        event.stopImmediatePropagation();
        if (this.itemSearch?.key(event)) return;
        if (event.isComposing) return;
        if (event.key === "Escape"){
            event.preventDefault();
            this.close();
            return;
        }
        if (event.ctrlKey && !event.altKey && ["+", "=", "-", "0"].includes(event.key)){
            event.preventDefault();
            this.rescale({ "-": -1, 0: 0 }[event.key] ?? 1);
            return;
        }
        const active = /** @type {HTMLElement|null} */(this.shadow.activeElement);
        if (event.key === "Enter" && active){
            if (active.closest("#kmFilters")){
                event.preventDefault();
                this.applyFilters();
            }
            else if (active.matches("tr[data-skin]")){
                event.preventDefault();
                active.click();
            }
        }
        if (event.key !== "Tab") return;
        const focusable = [...this.shadow.querySelectorAll("button:not(:disabled):not([tabindex='-1']),input:not([type=hidden]),select,textarea,summary,[tabindex='0']")].filter((e) => e instanceof HTMLElement && e.getClientRects().length && !e.closest("[hidden]"));
        const first = /** @type {HTMLElement|undefined} */(focusable[0]);
        const last = /** @type {HTMLElement|undefined} */(focusable.at(-1));
        if (event.shiftKey && (active === first || !active)){
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && (active === last || !active)){
            event.preventDefault();
            first?.focus();
        }
    }
}
const terminal = new Terminal();
export default terminal;
