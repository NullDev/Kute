import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";
import { esc } from "../src/frontend/modules/market/presentation.js";
import { breakdownHtml, differenceHtml, resolveEntries, sideHtml, sideOf } from "../src/frontend/modules/market/tradeFacts.js";

const source = fs.readFileSync(new URL("../src/frontend/modules/market/trade.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export default trade;", "globalThis.trade = trade;");

/** a facts row with only what the panel reads */
const facts = (skin, name, extra = {}) => ({ skin, name, lastSoldPrice: 140, lastSoldAt: 1_700_000_000_000, lastSaleAvg: null, lastSaleDay: null, lowest: 150, sales30d: 12, krunker: 80, ...extra });

function fixture(){
    let time = 1_000_000;
    class Clock extends Date { static now(){ return time; } }
    /** ids of every facts request, and the answers queued for them (an empty object when none is queued) */
    const requests = []; const answers = []; const lookups = [];
    let prices = {};
    const panel = { innerHTML: "", querySelector: () => null };
    const shadow = { querySelector: () => panel, addEventListener(){} };
    const box = { style: {}, isConnected: false, nextElementSibling: null, shadowRoot: shadow, attachShadow(){ return shadow; }, remove(){ this.isConnected = false; } };
    const anchor = { before(el){ el.nextElementSibling = this; el.isConnected = true; }, contains: () => true };
    const offers = [[], []];
    const sides = offers.map((items) => ({ parentElement: anchor, getClientRects: () => [{}], querySelectorAll: (selector) => selector === ".trade-offer-scroll .trade-inv-item" ? items : [] }));
    const document = { body: {}, hidden: false, pointerLockElement: null, querySelectorAll: () => sides, getElementById: () => null, createElement: () => box };
    const marketApi = {
        retryAt: 0,
        lastError: "",
        values: async(ids) => { requests.push(ids); return answers.shift() ?? {}; },
        valuesByThumbnails: async(paths) => { lookups.push(paths); return {}; },
    };
    const context = vm.createContext({ Date: Clock, document, window: { setInterval: () => 1, addEventListener(){}, removeEventListener(){} }, clearInterval(){}, HTMLInputElement: class {}, esc, template: "",
        marketApi, CHANGED_EVENT: "changed", setOwnPrice(){}, resolveEntries,
        // the real side builder, with a controllable price store in place of localStorage
        sideOf: (items, kr, f) => {
            const lines = items.map((entry) => ({ entry, facts: f[entry.skin] ?? null, own: prices[entry.skin] ?? null }));
            const priced = lines.filter((l) => l.own !== null);
            return { lines, kr, items: lines.reduce((s, l) => s + l.entry.count, 0), priced: priced.length, total: priced.length === lines.length ? priced.reduce((s, l) => s + l.own * l.entry.count, 0) + kr : null };
        },
        sideHtml, differenceHtml, breakdownHtml,
    });
    vm.runInContext(source, context);
    context.trade.start();
    const add = (side, skin, count = 1, extra = {}) => {
        const attributes = { "data-index": String(skin), ...extra };
        const item = { count, getAttribute: (key) => attributes[key] ?? null, querySelector: (selector) => selector === ".trade-item-count" ? { textContent: `x${item.count}` } : { getAttribute: () => "https://assets.krunker.io/textures/paints/paint_black.webp" } };
        offers[side].push(item);
        return item;
    };
    return { trade: context.trade, context, document, requests, lookups, box, panel, anchor, sides, offers, add, marketApi, answer: (data) => answers.push(data), setPrices: (p) => { prices = p; }, advance: (ms) => { time += ms; }, now: () => time };
}

describe("trade panel facts", () => {
    test("legacy offers keep quantities and added KR without reading inventory entries", () => {
        const f = fixture(); f.sides.length = 0;
        const item = (id, count) => ({ id, querySelector: () => ({ textContent: `x${count}` }) });
        const lists = [
            { parentElement: f.anchor, getClientRects: () => [{}], querySelectorAll: () => [item("trd_sel_0_12", 3), item("trd_inv_0_99", 5)] },
            { parentElement: f.anchor, getClientRects: () => [{}], querySelectorAll: () => [item("trd_1_32_1234", 1)] },
        ];
        const currency = (text) => ({ querySelector: (selector) => selector === ".tCurrencyAmount" ? { textContent: text } : null });
        // offerVal holds the game's estimate on the plaza, it must never become offered KR
        f.document.getElementById = (id) => ({ tradeList0: lists[0], tradeList1: lists[1], offerVal0: { textContent: "Est. Value 999 KR" }, offerVal1: { textContent: "Est. Value 328 KR" }, currency_item_0_1: currency("1,500 KR"), currency_item_1_2: currency("7 JNK") })[id];
        const snapshot = f.trade.snapshot();
        expect(snapshot.give).toEqual([{ skin: 12, count: 3 }]);
        expect(snapshot.get).toEqual([{ skin: 32, count: 1 }]);
        expect(snapshot.giveKr).toBe(1500);
        expect(snapshot.getKr).toBe(0);
    });

    test("an item without an index is looked up by its preview path", async() => {
        const f = fixture();
        const item = f.add(0, "invalid", 4);
        const original = item.querySelector;
        item.querySelector = (selector) => selector === "img" ? { getAttribute: () => "https://assets.krunker.io/textures/previews/weapons/test.png?v=1" } : original(selector);
        f.marketApi.valuesByThumbnails = async() => ({ "weapons/test.png": { skin: 123 } });
        f.answer({ 123: facts(123, "Test") });
        await f.trade.tick();
        expect(f.requests[0]).toEqual([123]);
        expect(f.panel.innerHTML).toContain("4 &times; Test");
    });

    test("hidden pages and gameplay never start lookups", async() => {
        const f = fixture(); f.add(0, 7018);
        f.document.hidden = true; await f.trade.tick();
        f.document.hidden = false; f.document.pointerLockElement = {}; await f.trade.tick();
        f.document.pointerLockElement = null; f.trade.stop(); await f.trade.tick();
        expect(f.requests).toHaveLength(0);
    });

    test("shows facts with dates and totals only the player's own prices, never a verdict", async() => {
        const f = fixture();
        f.add(0, 7779, 2);
        f.add(1, 7886, 1, { "data-serial": "45", "data-wear-float": "0.9533" });
        f.setPrices({ 7779: 100 });
        f.answer({ 7779: facts(7779, "Paint <b>Black</b>"), 7886: facts(7886, "Knife", { lastSoldPrice: null, lastSoldAt: null, lowest: null }) });
        await f.trade.tick();
        expect(f.requests[0]).toEqual([7779, 7886]);
        expect(f.lookups).toHaveLength(0);
        const html = f.panel.innerHTML;
        expect(html).toContain("Paint &lt;b&gt;Black&lt;/b&gt;");
        expect(html).toContain("sold 140 on");
        expect(html).toContain("ask 150");
        expect(html).toContain("12 sold / 30D");
        expect(html).toContain("not listed");
        expect(html).toContain("#45");
        // the given side is fully priced: 2 x 100, the other side is not
        expect(html).toContain('200 <span class="unit">KR</span>');
        expect(html).toContain("0 of 1 priced by you");
        expect(html).toContain("Set your prices");
        for (const word of ["favorable", "fair trade", "estimate", "grade", "verdict\">fair"]) expect(html.toLowerCase()).not.toContain(word);
        expect(f.box.nextElementSibling).toBe(f.anchor);
    });

    test("with every item priced the difference is by the player's prices", async() => {
        const f = fixture();
        f.add(0, 1); f.add(1, 2);
        f.setPrices({ 1: 1000, 2: 1500 });
        f.answer({ 1: facts(1, "A"), 2: facts(2, "B") });
        await f.trade.tick();
        expect(f.panel.innerHTML).toContain("By your prices");
        expect(f.panel.innerHTML).toContain('+500 <span class="unit">KR</span>');
        expect(f.panel.innerHTML).toContain("33 % of the larger side");
    });

    test("a price change redraws from the kept facts without a new request", async() => {
        const f = fixture(); f.add(0, 1);
        f.answer({ 1: facts(1, "A") });
        await f.trade.tick();
        expect(f.panel.innerHTML).toContain("0 of 1 priced");
        f.setPrices({ 1: 777 });
        f.trade.onPrices();
        await f.trade.tick();
        expect(f.requests).toHaveLength(1);
        expect(f.panel.innerHTML).toContain('value="777"');
    });

    test("late results cannot resurrect a stopped, replaced or closed trade", async() => {
        for (const action of ["stop", "close", "replace", "gameplay"]){
            const f = fixture(); f.add(0, 7018);
            let release = () => {};
            f.marketApi.values = async(ids) => { f.requests.push(ids); await new Promise((resolve) => { release = resolve; }); return { 7018: facts(7018, "X") }; };
            const work = f.trade.tick();
            while (!f.requests.length) await Promise.resolve();
            if (action === "stop") f.trade.stop();
            if (action === "close") f.sides.length = 0;
            if (action === "replace") f.sides.forEach((s) => { s.parentElement = { contains: () => true }; });
            if (action === "gameplay") f.document.pointerLockElement = {};
            release(); await work;
            expect(f.panel.innerHTML).not.toContain("Items, facts");
            if (action === "stop") expect(f.box.isConnected).toBe(false);
        }
    });

    test("unidentified items never disappear into a total", async() => {
        const f = fixture(); f.add(0, "invalid");
        await f.trade.tick();
        expect(f.requests).toHaveLength(0);
        expect(f.panel.innerHTML).toContain("could not be identified");
    });

    test("an empty answer backs off exponentially even while the offer changes", async() => {
        const f = fixture(); f.add(0, 7018);
        await f.trade.tick();
        expect(f.requests).toHaveLength(1);
        expect(f.panel.innerHTML).toContain("unavailable");
        for (let i = 0; i < 4; i++){ f.advance(1200); await f.trade.tick(); }
        expect(f.requests).toHaveLength(1);
        f.add(1, 42); await f.trade.tick();
        expect(f.requests).toHaveLength(1);
        f.advance(200);
        await f.trade.tick();
        expect(f.requests).toHaveLength(2);
        f.advance(9999); await f.trade.tick();
        expect(f.requests).toHaveLength(2);
        f.advance(1);
        f.answer({ 7018: facts(7018, "X"), 42: facts(42, "Y") });
        await f.trade.tick();
        expect(f.requests).toHaveLength(3);
        expect(f.panel.innerHTML).toContain("Items, facts");
    });
});

describe("trade side helpers", () => {
    test("sides total only the player's prices and say how many are missing", () => {
        const side = sideOf([{ skin: 1, count: 2 }, { skin: 2, count: 1 }], 500, { 1: facts(1, "A") });
        expect(side.total).toBeNull();
        expect(sideHtml(side, "You give")).toContain("0 of 2 priced by you");
        expect(breakdownHtml(side, "You give")).toContain("Not on file");
        expect(breakdownHtml(side, "You give")).toContain('data-own-skin="2"');
        expect(differenceHtml(side, side)).toContain("Set your prices");
    });

    test("unknown preview paths leave the trade unresolved", async() => {
        expect(await resolveEntries([{ skin: -1, count: 1, path: "x.png" }], async() => ({}))).toBeNull();
        expect(await resolveEntries([{ skin: -1, count: 1, path: "x.png" }, { skin: 5, count: 2 }], async() => ({ "x.png": { skin: 9 } }))).toEqual([{ skin: 9, count: 1 }, { skin: 5, count: 2 }]);
    });
});
