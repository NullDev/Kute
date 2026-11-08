import { formatKr, formatWhen } from "./types.js";
import { esc, money } from "./presentation.js";
import { readPrices } from "./prices.js";

// what both trade panels (the trade window and the offer list) show for one side of a trade: every item with
// the facts on file and the player's own price, and a total only from the player's own prices. nobody else's
// number is summed, so there is no verdict to be wrong

/**
 * @typedef {{skin:number,count:number,serial?:number,wear?:number,style?:number,path?:string}} Entry
 * @typedef {{entry:Entry,facts:import("./types.js").SkinFacts|null,own:number|null}} Line
 * @typedef {{lines:Line[],kr:number,items:number,priced:number,total:number|null}} Side
 */

/**
 * items the game shows without a skin index carry their preview path; the server knows the skin of a path
 *
 * @param {Entry[]} entries
 * @param {(paths: string[]) => Promise<Record<string, {skin: number}>>} lookup
 * @return {Promise<Entry[]|null>} null when an item stays unknown
 */
export async function resolveEntries(entries, lookup){
    const paths = entries.filter((e) => e.skin < 0 && e.path).map((e) => /** @type {string} */ (e.path));
    const byPath = paths.length ? await lookup(paths) : {};
    const out = entries.map(({ path, ...entry }) => ({ ...entry, skin: entry.skin < 0 ? byPath[path ?? ""]?.skin ?? -1 : entry.skin }));
    return out.some((e) => e.skin < 0) ? null : out;
}

/**
 * @param {Entry[]} items
 * @param {number} kr
 * @param {Record<string, import("./types.js").SkinFacts>} facts
 * @return {Side}
 */
export function sideOf(items, kr, facts){
    const prices = readPrices();
    const lines = items.map((entry) => ({ entry, facts: facts[entry.skin] ?? null, own: prices[entry.skin]?.price ?? null }));
    const priced = lines.filter((l) => l.own !== null);
    const complete = priced.length === lines.length;
    return {
        lines,
        kr,
        items: lines.reduce((sum, l) => sum + l.entry.count, 0),
        priced: priced.length,
        total: complete ? priced.reduce((sum, l) => sum + /** @type {number} */ (l.own) * l.entry.count, 0) + kr : null,
    };
}

/** @param {Side} side @param {string} label */
export function sideHtml(side, label){
    const empty = !side.lines.length && !side.kr;
    let value = '<span class="muted">–</span>';
    if (side.total !== null && !empty) value = `${formatKr(side.total)} <span class="unit">KR</span>`;
    let meta = "Nothing added";
    if (!empty){
        meta = `${side.items} ${side.items === 1 ? "item" : "items"}${side.kr ? ` + ${formatKr(side.kr)} KR` : ""}`;
        if (side.lines.length) meta += side.total === null ? ` &middot; ${side.priced} of ${side.lines.length} priced by you` : " &middot; your prices";
    }
    return `<div class="side"><span class="label">${label}</span><strong>${value}</strong><span class="meta">${meta}</span></div>`;
}

/** @param {Side} give @param {Side} get */
export function differenceHtml(give, get){
    const oneSided = (!give.lines.length && !give.kr) || (!get.lines.length && !get.kr);
    if (oneSided) return '<span class="verdict">Add both sides</span><span class="meta">Items on both sides, then your prices total them</span>';
    if (give.total === null || get.total === null) return '<span class="verdict">Set your prices</span><span class="meta">Every item needs your price before the sides are compared</span>';
    const difference = get.total - give.total;
    const larger = Math.max(give.total, get.total, 1);
    return `<span class="verdict">By your prices</span><strong>${difference > 0 ? "+" : ""}${formatKr(difference)} <span class="unit">KR</span></strong><span class="meta">${Math.round(Math.abs(difference) / larger * 100)} % of the larger side</span>`;
}

/** @param {import("./types.js").SkinFacts|null} f @return {string} the facts on file, one line */
export function factsLine(f){
    if (!f) return "Not on file";
    const parts = [];
    if (f.lastSoldPrice !== null && f.lastSoldAt !== null) parts.push(`sold ${money(f.lastSoldPrice)} on ${formatWhen(f.lastSoldAt)}`);
    else if (f.lastSaleAvg !== null && f.lastSaleDay !== null) parts.push(`avg ${money(f.lastSaleAvg)} on ${formatWhen(f.lastSaleDay)}`);
    parts.push(f.lowest === null ? "not listed" : `ask ${money(f.lowest)}`);
    parts.push(`${f.sales30d} sold / 30D`);
    if (f.krunker !== null) parts.push(`Krunker ~${money(f.krunker)}`);
    return parts.join(" &middot; ");
}

/** @param {Side} side @param {string} label */
export function breakdownHtml(side, label){
    const lines = side.lines.map(({ entry, facts, own }) => {
        const name = facts?.name ?? `Item #${entry.skin}`;
        const attributes = `${entry.serial !== undefined ? ` #${esc(entry.serial)}` : ""}${entry.wear !== undefined ? ` &middot; wear ${entry.wear.toFixed(4)}` : ""}`;
        return `<div class="line"><span class="name"><b>${entry.count > 1 ? `${entry.count} &times; ` : ""}${esc(name)}</b>${attributes}<small>${factsLine(facts)}</small></span>`
            + `<label class="own"><span>Yours</span><input type="number" min="1" placeholder="–" value="${own ?? ""}" data-own-skin="${entry.skin}" data-own-name="${esc(name)}" aria-label="Your price for ${esc(name)}"></label></div>`;
    });
    if (side.kr) lines.push(`<div class="line"><span class="name"><b>Added KR</b></span><span class="amount">${formatKr(side.kr)} KR</span></div>`);
    if (!lines.length) lines.push('<span class="meta">No items added</span>');
    return `<div><h3>${label}</h3>${lines.join("")}</div>`;
}
