export interface SkinFacts {
    skin: number;
    name: string;
    rarity: number;
    type: number;
    season: number|null;
    thumbnail: string|null;
    tradable: boolean;
    lowest: number|null;
    highest: number|null;
    listed: number;
    onS: number;
    inC: number;
    krunker: number|null;
    floor: number;
    sales7d: number;
    sales30d: number;
    sales90d: number;
    avg30d: number|null;
    lastSaleDay: string|null;
    lastSaleAvg: number|null;
    lastSoldPrice: number|null;
    lastSoldAt: number|null;
    sold30d: number;
    bookAt: number|null;
    statsAt: number|null;
    asOf: number;
}

export type SearchReply = {total: number, page: number, perPage: number, items: SkinFacts[], asOf: number};

type SoldRow = {price: number, at: number, wear: number|null, serial: number|null};

type Supply = {inC: number, onS: number, top1Share: number|null, top10Share: number|null, top100Share: number|null, topOwners: {name: string, count: number}[], at: number|null};

export type ItemPage = {skin: SkinFacts & {stackable: boolean|null, wearable: boolean|null, limType: string|null, noSpin: boolean}, sold: SoldRow[], supply: Supply|null, historySince: string|null, asOf: number};

type HistoryPoint = {t: number, lowest: number|null, median: number|null, sales: number, volume: number, avg: number|null, salesObserved: boolean, krunker: number|null, onS: number|null, ask?: {open:number, high:number, low:number, close:number, samples:number}|null};

type HistoryReply = {skin: number, range: string, resolution: "hour"|"day", points: HistoryPoint[], asOf: number};

type ListingRow = {uid: number, price: number, listedAt: number|null, ageMs: number|null, seller: string|null, sellerListings: number, wear: number|null, serial: number|null};

export type ListingsReply = {skin: number, total: number, listings: ListingRow[], asOf: number, observedAt: number|null, observedTotal: number, highest: number|null};

export type ItemDeskReply = {item: ItemPage, history: HistoryReply|null, listings: ListingsReply|null};


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

export function formatKr(kr: number): string{
    if (!Number.isFinite(kr)) return "?";
    if (Math.abs(kr) >= 1_000_000) return `${(kr / 1_000_000).toFixed(kr % 1_000_000 === 0 ? 0 : 1)}M`;
    return Math.round(kr).toLocaleString("en-US");
}

export function formatAge(ms: number): string{
    if (!Number.isFinite(ms) || ms < 0) return "–";
    const minutes = ms / 60_000;
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
    const hours = minutes / 60;
    if (hours < 48) return `${Math.round(hours)} h`;
    return `${Math.round(hours / 24)} d`;
}

export function formatWhen(at: number | string | null | undefined): string{
    if (at === null || at === undefined) return "–";
    const date = typeof at === "string" ? new Date(at + "T00:00:00Z") : new Date(at);
    if (Number.isNaN(date.getTime())) return "–";
    const options = { month: "short", day: "numeric", timeZone: "UTC" } as Intl.DateTimeFormatOptions;
    if (typeof at === "number") Object.assign(options, { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleString("en-US", options);
}
