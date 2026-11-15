import { formatKr, formatWhen, RARITIES, type SkinFacts } from "./types";

export const TYPE_NAMES = ["Weapons", "Hats", "Bodies", "Melee", "Sprays", "Dyes", "Waists", "Faces", "Charms", "Emotes", "Stickers", "Skydomes", "Poses", "Spin tickets", "Capes", "Heads", "Paints", "Backs", "Consumables"];

export const esc = (text: unknown): string => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export const money = (value: number | null | undefined): string => value === null || value === undefined ? "–" : formatKr(value);

export const lastSale = (f: SkinFacts | null | undefined): string => {
    if (!f) return '<span class="muted">–</span>';
    if (f.lastSoldPrice !== null && f.lastSoldAt !== null) return `${money(f.lastSoldPrice)} <small>${esc(formatWhen(f.lastSoldAt))}</small>`;
    if (f.lastSaleAvg !== null && f.lastSaleDay !== null) return `${money(f.lastSaleAvg)} <small>avg ${esc(formatWhen(f.lastSaleDay))}</small>`;
    return '<span class="muted">No sale seen</span>';
};

export const lowestAsk = (f: SkinFacts | null | undefined): string => {
    if (!f) return '<span class="muted">–</span>';
    if (f.lowest === null) return '<span class="muted">Not listed</span>';
    return `${money(f.lowest)} <small>${f.listed} listed</small>`;
};

export const soldMonth = (f: SkinFacts | null | undefined): string => {
    if (!f) return '<span class="muted">–</span>';
    return `${f.sales30d} <small>${f.sales30d === 1 ? "sale" : "sales"} / 30D</small>`;
};

export const identity = (item: { thumbnail?: string | null, name: string, rarity?: number }): string => `<span class="itemIdentity">${item.thumbnail ? `<img src="${esc(item.thumbnail)}" loading="lazy" alt="">` : "<span class=\"itemPlaceholder\">K</span>"}<span><b>${esc(item.name)}</b><small>${esc(RARITIES[item.rarity ?? -1]?.name ?? "Item")}</small></span></span>`;

export const empty = (title: string, description: string, action = ""): string => `<div class="empty"><span class="emptyMark">&#9671;</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;

export const stat = (title: string, value: string, detail: string): string => `<div class="metric"><span>${esc(title)}</span><strong>${value}</strong><small>${detail}</small></div>`;
