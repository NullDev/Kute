import { existsSync } from "node:fs";
import path from "node:path";
import Log from "./util/log";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

// the market engine (the collector of krunker's public market data) is not part of this repository:
// src/market/ is a gitignored checkout of a private repository. the public server runs complete without it,
// the market routes then answer "unavailable". this file is the whole contract between the two: what the
// engine exports and the shapes the routes hand to clients. every number in them is an observation with a
// time next to it, nothing is a valuation (the fact-only cut of 2026-11-08)

export type MarketJobStatus = {
    name: string;
    running: boolean;
    lastRun: number | null;
    lastOk: number | null;
    lastMs: number | null;
    runs: number;
    failures: number;
    resumable: boolean;
    note: string | null;
};

export type MarketStatus = {
    collector: boolean;
    jobs: MarketJobStatus[];
    counts: Record<string, number>;
    /** in memory only: sources with a watchlist, skins watched, skins seen listed in the last hour */
    watch?: { sources: number; skins: number; seen: number };
};

/** what every row, card and trade line shows about a skin */
export type SkinFacts = {
    skin: number;
    name: string;
    rarity: number;
    type: number;
    season: number | null;
    thumbnail: string | null;
    tradable: boolean;
    /** cheapest live listing, null without listings */
    lowest: number | null;
    highest: number | null;
    /** live listings in the book sample */
    listed: number;
    /** krunker's own on sale count and circulation */
    onS: number;
    inC: number;
    /** krunker's own flat estimate (the "~" on its cards), null when it has none */
    krunker: number | null;
    /** what the game pays on quick sell, 0 when it cannot be quick sold */
    floor: number;
    /** krunker's daily sale counts summed */
    sales7d: number;
    sales30d: number;
    sales90d: number;
    /** volume weighted mean of krunker's daily averages over 30 days, null without sales */
    avg30d: number | null;
    lastSaleDay: string | null;
    lastSaleAvg: number | null;
    /** the newest listing the book saw sold, with its price */
    lastSoldPrice: number | null;
    lastSoldAt: number | null;
    /** confirmed individual sales in 30 days */
    sold30d: number;
    bookAt: number | null;
    statsAt: number | null;
    asOf: number;
};

export type SearchSort = "sales" | "lowest" | "name";
export type SearchQuery = { q?: string; rarity?: number; type?: number; season?: number; sort?: SearchSort; page?: number; budget?: number; minSales?: number };
export type SearchReply = { total: number; page: number; perPage: number; items: SkinFacts[]; asOf: number };

export type SoldRow = { price: number; at: number; wear: number | null; serial: number | null };
export type OwnerInfo = { name: string; count: number };
export type Supply = { inC: number; onS: number; top1Share: number | null; top10Share: number | null; top100Share: number | null; topOwners: OwnerInfo[]; at: number | null };

export type ItemPage = {
    skin: SkinFacts & { stackable: boolean | null; wearable: boolean | null; limType: string | null; noSpin: boolean };
    /** newest confirmed sales first */
    sold: SoldRow[];
    supply: Supply | null;
    /** first day of krunker's daily series we hold */
    historySince: string | null;
    asOf: number;
};

export type HistoryRange = "1D" | "7D" | "1M" | "3M" | "1Y" | "ALL";
export type HistoryPoint = {
    /** start of the bucket, unix ms */
    t: number;
    /** our sampled lowest ask at the close of the bucket */
    lowest: number | null;
    median: number | null;
    /** krunker's daily sale count and kr volume, 0 on hourly points */
    sales: number;
    volume: number;
    /** krunker's daily average sale price, null without sales or on hourly points */
    avg: number | null;
    salesObserved: boolean;
    krunker: number | null;
    onS: number | null;
    ask?: { open: number; high: number; low: number; close: number; samples: number } | null;
};
export type HistoryReply = { skin: number; range: HistoryRange; resolution: "hour" | "day"; points: HistoryPoint[]; asOf: number };

export type ListingRow = { uid: number; price: number; listedAt: number | null; ageMs: number | null; seller: string | null; sellerListings: number; wear: number | null; serial: number | null };
export type ListingsReply = { skin: number; total: number; listings: ListingRow[]; asOf: number; observedAt: number | null; observedTotal: number; highest: number | null };

export type ItemDeskReply = { item: ItemPage; history: HistoryReply | null; listings: ListingsReply | null };

export type ValueReply = { values: Record<string, SkinFacts>; asOf: number };

export type ObservedSale = { marketid: number; type: "sell" | "buy"; skinindex: number; amount: number; date: string };
/** seen: skins the game listed for the player, a hint to read their books sooner */
export type ObserveBody = { sales?: ObservedSale[]; seen?: unknown[] };
export type ObserveResult = { accepted: number; rejected: number };

export type MarketQuery = {
    search(query: SearchQuery): SearchReply;
    item(skin: number): Promise<ItemPage | null>;
    history(skin: number, range: HistoryRange): HistoryReply | null;
    listings(skin: number): ListingsReply | null;
    value(skins: number[]): ValueReply;
    /** the same by the preview image path the game draws a card with (unique per skin), keyed by that path */
    valueByThumbnails(paths: string[]): ValueReply;
    /** session is an opaque report source, never a player identity */
    observe(session: string, body: ObserveBody): ObserveResult;
    /** the skins a source watches, read more often */
    watch(source: string, body: unknown): { watched: number };
};

export type MarketEngine = {
    /** opens the market database and, where enabled, schedules the collector */
    start(): void;
    status(): MarketStatus;
    query: MarketQuery;
};

/** the engine when its checkout is present, else null; the path is a variable so the compiler does not look for it */
export async function loadMarketEngine(): Promise<MarketEngine | null> {
    const entry = path.join(import.meta.dir, "market", "index.ts");
    if (!existsSync(entry)){
        Log.info("Market engine is not checked out (src/market), the market routes answer unavailable.");
        return null;
    }
    const specifier = "./market/index.ts";
    try {
        const engine = await import(specifier) as MarketEngine;
        if (typeof engine.start !== "function" || typeof engine.status !== "function" || typeof engine.query !== "object") throw new Error("the module does not export start, status and query");
        return engine;
    }
    catch (err){
        Log.error("Market engine failed to load: " + (err as Error).message, err as Error);
        return null;
    }
}
