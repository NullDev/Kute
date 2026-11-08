import { formatKr, formatWhen, RARITIES } from "./types.js";

export const TYPE_NAMES = ["Weapons", "Hats", "Bodies", "Melee", "Sprays", "Dyes", "Waists", "Faces", "Charms", "Emotes", "Stickers", "Skydomes", "Poses", "Spin tickets", "Capes", "Heads", "Paints", "Backs", "Consumables"];

/** @param {unknown} text */
export const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** @param {number|null|undefined} value */
export const money = (value) => value === null || value === undefined ? "–" : formatKr(value);

/**
 * @param {import("./types.js").SkinFacts|null|undefined} f
 * @return {string} "140 KR · Nov 3" from the newest confirmed sale, else krunker's last daily average, else a dash
 */
export const lastSale = (f) => {
    if (!f) return '<span class="muted">–</span>';
    if (f.lastSoldPrice !== null && f.lastSoldAt !== null) return `${money(f.lastSoldPrice)} <small>${esc(formatWhen(f.lastSoldAt))}</small>`;
    if (f.lastSaleAvg !== null && f.lastSaleDay !== null) return `${money(f.lastSaleAvg)} <small>avg ${esc(formatWhen(f.lastSaleDay))}</small>`;
    return '<span class="muted">No sale seen</span>';
};

/** @param {import("./types.js").SkinFacts|null|undefined} f */
export const lowestAsk = (f) => {
    if (!f) return '<span class="muted">–</span>';
    if (f.lowest === null) return '<span class="muted">Not listed</span>';
    return `${money(f.lowest)} <small>${f.listed} listed</small>`;
};

/** @param {import("./types.js").SkinFacts|null|undefined} f */
export const soldMonth = (f) => {
    if (!f) return '<span class="muted">–</span>';
    return `${f.sales30d} <small>${f.sales30d === 1 ? "sale" : "sales"} / 30D</small>`;
};

/** @param {{thumbnail?:string|null,name:string,rarity?:number}} item */
export const identity = (item) => `<span class="itemIdentity">${item.thumbnail ? `<img src="${esc(item.thumbnail)}" loading="lazy" alt="">` : "<span class=\"itemPlaceholder\">K</span>"}<span><b>${esc(item.name)}</b><small>${esc(RARITIES[item.rarity ?? -1]?.name ?? "Item")}</small></span></span>`;

/** @param {string} title @param {string} description @param {string} [action] */
export const empty = (title, description, action = "") => `<div class="empty"><span class="emptyMark">&#9671;</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;

/** @param {string} title @param {string} value @param {string} detail */
export const stat = (title, value, detail) => `<div class="metric"><span>${esc(title)}</span><strong>${value}</strong><small>${detail}</small></div>`;
