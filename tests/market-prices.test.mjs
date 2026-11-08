import { beforeEach, expect, test } from "bun:test";
import { TITLES } from "../src/frontend/modules/market/navigation.js";

const storage = new Map();
let events = 0;
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
globalThis.window = { dispatchEvent: () => { events++; } };
globalThis.Event = class { constructor(type){ this.type = type; } };

const { exportPrices, ownPrice, parsePrices, readPrices, setOwnPrice } = await import("../src/frontend/modules/market/prices.js");

beforeEach(() => { storage.clear(); events = 0; });

test("own prices round trip through storage and remove on null", () => {
    expect(setOwnPrice({ skin: 3239, name: "Wires" }, 1200.4)).toBe(true);
    expect(ownPrice(3239)).toBe(1200);
    expect(events).toBe(1);
    setOwnPrice({ skin: 3239, name: "Wires" }, null);
    expect(ownPrice(3239)).toBeNull();
    expect(readPrices()).toEqual({});
});

test("junk in storage is dropped instead of thrown", () => {
    storage.set("kute_item_prices", JSON.stringify({ 1: { name: "A", price: -5 }, b: { name: "B", price: 1 }, 2: { name: 3, price: 1 }, 3: { name: "C", price: 50, at: 7 } }));
    expect(readPrices()).toEqual({ 3: { name: "C", price: 50, at: 7 } });
    storage.set("kute_item_prices", "{nope");
    expect(readPrices()).toEqual({});
});

test("the text format carries the id and reads every common way of writing a price", () => {
    setOwnPrice({ skin: 7962, name: "Bow (Tie) = Fancy" }, 350);
    setOwnPrice({ skin: 1, name: "Arctaurus" }, 250_000);
    const text = exportPrices(readPrices());
    expect(text.split("\n")).toEqual(["Arctaurus (#1) = 250000", "Bow Tie Fancy (#7962) = 350"]);
    expect(parsePrices(text)).toEqual([
        { skin: 1, name: "Arctaurus", price: 250_000, line: "Arctaurus (#1) = 250000" },
        { skin: 7962, name: "Bow Tie Fancy", price: 350, line: "Bow Tie Fancy (#7962) = 350" },
    ]);
    expect(parsePrices("# a comment\nRayn AK: 230k\nInter 130,000 kr\n\nBad line\nFree = 0\n(#5) = 2.5M")).toEqual([
        { skin: null, name: "Rayn AK", price: 230_000, line: "Rayn AK: 230k" },
        { skin: null, name: "Inter", price: 130_000, line: "Inter 130,000 kr" },
        { skin: 5, name: "", price: 2_500_000, line: "(#5) = 2.5M" },
    ]);
});

test("the window has no tab for anything but facts", () => {
    expect(Object.keys(TITLES).sort()).toEqual(["help", "item", "prices", "search", "watchlist"]);
});
