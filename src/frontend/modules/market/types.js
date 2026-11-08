// the shapes the kute server answers with, mirrored from server/src/marketEngine.ts for checkJs. every number
// is an observation with a time next to it, nothing here is a valuation

/**
 * @typedef {object} SkinFacts
 * @property {number} skin
 * @property {string} name
 * @property {number} rarity
 * @property {number} type
 * @property {number|null} season
 * @property {string|null} thumbnail
 * @property {boolean} tradable
 * @property {number|null} lowest cheapest live listing
 * @property {number|null} highest
 * @property {number} listed live listings in the book sample
 * @property {number} onS krunker's own on sale count
 * @property {number} inC circulation
 * @property {number|null} krunker krunker's own flat estimate
 * @property {number} floor what the game pays on quick sell, 0 when it cannot be quick sold
 * @property {number} sales7d krunker's daily sale counts summed
 * @property {number} sales30d
 * @property {number} sales90d
 * @property {number|null} avg30d volume weighted mean of krunker's daily averages over 30 days
 * @property {string|null} lastSaleDay
 * @property {number|null} lastSaleAvg
 * @property {number|null} lastSoldPrice the newest listing the book saw sold
 * @property {number|null} lastSoldAt
 * @property {number} sold30d confirmed individual sales in 30 days
 * @property {number|null} bookAt
 * @property {number|null} statsAt
 * @property {number} asOf
 *
 * @typedef {{total: number, page: number, perPage: number, items: SkinFacts[], asOf: number}} SearchReply
 * @typedef {{price: number, at: number, wear: number|null, serial: number|null}} SoldRow
 * @typedef {{inC: number, onS: number, top1Share: number|null, top10Share: number|null, top100Share: number|null, topOwners: {name: string, count: number}[], at: number|null}} Supply
 * @typedef {{skin: SkinFacts & {stackable: boolean|null, wearable: boolean|null, limType: string|null, noSpin: boolean}, sold: SoldRow[], supply: Supply|null, historySince: string|null, asOf: number}} ItemPage
 * @typedef {{t: number, lowest: number|null, median: number|null, sales: number, volume: number, avg: number|null, salesObserved: boolean, krunker: number|null, onS: number|null, ask?: {open:number,high:number,low:number,close:number,samples:number}|null}} HistoryPoint
 * @typedef {{skin: number, range: string, resolution: "hour"|"day", points: HistoryPoint[], asOf: number}} HistoryReply
 * @typedef {{uid: number, price: number, listedAt: number|null, ageMs: number|null, seller: string|null, sellerListings: number, wear: number|null, serial: number|null}} ListingRow
 * @typedef {{skin: number, total: number, listings: ListingRow[], asOf: number, observedAt: number|null, observedTotal: number, highest: number|null}} ListingsReply
 * @typedef {{item: ItemPage, history: HistoryReply|null, listings: ListingsReply|null}} ItemDeskReply
 *
 * @typedef {{skin: number, count: number, serial?: number, wear?: number, style?: number}} TradeItem
 */

/** the game's rarity names and colors, from its rarity table */
export const RARITIES = [
    { name: "Uncommon", color: "#b2f252" },
    { name: "Rare", color: "#2196F3" },
    { name: "Epic", color: "#E040FB" },
    { name: "Legendary", color: "#FBC02D" },
    { name: "Relic", color: "#ff5722" },
    { name: "Contraband", color: "#f44336" },
    { name: "Unobtainable", color: "#ffffff" },
    { name: "NFT", color: "#9e9e9e" },
];

/**
 * @param {number} kr
 * @return {string} 12,345 or 1.2M
 */
export function formatKr(kr){
    if (!Number.isFinite(kr)) return "?";
    if (Math.abs(kr) >= 1_000_000) return `${(kr / 1_000_000).toFixed(kr % 1_000_000 === 0 ? 0 : 1)}M`;
    return Math.round(kr).toLocaleString("en-US");
}

/**
 * @param {number} ms
 * @return {string} 3 h, 2 d
 */
export function formatAge(ms){
    if (!Number.isFinite(ms) || ms < 0) return "–";
    const minutes = ms / 60_000;
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
    const hours = minutes / 60;
    if (hours < 48) return `${Math.round(hours)} h`;
    return `${Math.round(hours / 24)} d`;
}

/**
 * @param {number|string|null|undefined} at unix ms or a YYYY-MM-DD day
 * @return {string} Nov 3 or Nov 3, 14:05
 */
export function formatWhen(at){
    if (at === null || at === undefined) return "–";
    const date = typeof at === "string" ? new Date(at + "T00:00:00Z") : new Date(at);
    if (Number.isNaN(date.getTime())) return "–";
    const options = /** @type {Intl.DateTimeFormatOptions} */ ({ month: "short", day: "numeric", timeZone: "UTC" });
    if (typeof at === "number") Object.assign(options, { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleString("en-US", options);
}
