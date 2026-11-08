// the player's own prices: what they think an item is worth, on this device only, never sent anywhere.
// traders keep their own sheets and disagree with every public number, so this is the only reference the
// trade panel totals against

const KEY = "kute_item_prices";
const MAX_ITEMS = 500;
export const CHANGED_EVENT = "kute-item-prices-changed";

/** @typedef {{name:string,price:number,at:number}} OwnPrice */

/** @return {Record<string, OwnPrice>} by skin */
export function readPrices(){
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        /** @type {Record<string, OwnPrice>} */
        const out = {};
        for (const [skin, entry] of Object.entries(raw)){
            if (!/^\d+$/.test(skin) || !entry || typeof entry !== "object") continue;
            const { name, price, at } = /** @type {Record<string, unknown>} */ (entry);
            if (typeof name !== "string" || typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
            out[skin] = { name, price: Math.round(price), at: typeof at === "number" ? at : 0 };
        }
        return out;
    }
    catch {
        return {};
    }
}

/** @param {Record<string, OwnPrice>} prices @return {boolean} */
export function savePrices(prices){
    try {
        const entries = Object.entries(prices).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ITEMS);
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
        window.dispatchEvent(new Event(CHANGED_EVENT));
        return true;
    }
    catch {
        return false;
    }
}

/** @param {number} skin @return {number|null} */
export function ownPrice(skin){
    return readPrices()[skin]?.price ?? null;
}

/**
 * @param {{skin:number,name:string}} item
 * @param {number|null} price null removes it
 * @return {boolean}
 */
export function setOwnPrice(item, price){
    const prices = readPrices();
    if (price === null || !Number.isFinite(price) || price <= 0) delete prices[item.skin];
    else {
        if (!prices[item.skin] && Object.keys(prices).length >= MAX_ITEMS) return false;
        prices[item.skin] = { name: item.name, price: Math.round(price), at: Date.now() };
    }
    return savePrices(prices);
}

/** @param {Record<string, OwnPrice>} prices @return {string} one line per item, `name (#skin) = price` */
export function exportPrices(prices){
    return Object.entries(prices)
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([skin, p]) => `${p.name.replace(/[()=]/g, " ").replace(/\s+/g, " ").trim()} (#${skin}) = ${p.price}`)
        .join("\n");
}

/**
 * @typedef {{skin:number|null,name:string,price:number,line:string}} ImportLine
 * @param {string} text
 * @return {ImportLine[]} every line with a price; a line without an id keeps its name for a lookup
 */
export function parsePrices(text){
    /** @type {ImportLine[]} */
    const out = [];
    for (const raw of text.split(/\r?\n/)){
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("//")) continue;
        // "Name (#123) = 50000", "Name = 50k", "Name: 50,000", "Name 50000"
        const match = /^(.*?)(?:\(#(\d+)\))?\s*(?:[=:]|\s)\s*([\d.,]+)\s*([kKmM])?\s*(?:kr)?$/i.exec(line);
        if (!match) continue;
        const name = match[1].trim();
        const skin = match[2] ? Number(match[2]) : null;
        let price = Number(match[3].replace(/,/g, ""));
        if (match[4]) price *= match[4].toLowerCase() === "k" ? 1000 : 1_000_000;
        if ((!name && skin === null) || !Number.isFinite(price) || price <= 0) continue;
        out.push({ skin, name, price: Math.round(price), line });
    }
    return out;
}
