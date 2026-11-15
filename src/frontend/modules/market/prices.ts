const KEY = "kute_item_prices";
const MAX_ITEMS = 500;
export const CHANGED_EVENT = "kute-item-prices-changed";

type OwnPrice = { name: string, price: number, at: number };

export function readPrices(): Record<string, OwnPrice>{
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const out: Record<string, OwnPrice> = {};
        for (const [skin, entry] of Object.entries(raw)){
            if (!/^\d+$/.test(skin) || !entry || typeof entry !== "object") continue;
            const { name, price, at } = entry as Record<string, unknown>;
            if (typeof name !== "string" || typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
            out[skin] = { name, price: Math.round(price), at: typeof at === "number" ? at : 0 };
        }
        return out;
    }
    catch {
        return {};
    }
}

export function savePrices(prices: Record<string, OwnPrice>): boolean{
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

export function ownPrice(skin: number): number | null{
    return readPrices()[skin]?.price ?? null;
}

export function setOwnPrice(item: { skin: number, name: string }, price: number | null): boolean{
    const prices = readPrices();
    if (price === null || !Number.isFinite(price) || price <= 0) delete prices[item.skin];
    else {
        if (!prices[item.skin] && Object.keys(prices).length >= MAX_ITEMS) return false;
        prices[item.skin] = { name: item.name, price: Math.round(price), at: Date.now() };
    }
    return savePrices(prices);
}

export function exportPrices(prices: Record<string, OwnPrice>): string{
    return Object.entries(prices)
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([skin, p]) => `${p.name.replace(/[()=]/g, " ").replace(/\s+/g, " ").trim()} (#${skin}) = ${p.price}`)
        .join("\n");
}

type ImportLine = { skin: number | null, name: string, price: number, line: string };

export function parsePrices(text: string): ImportLine[]{
    const out: ImportLine[] = [];
    for (const raw of text.split(/\r?\n/)){
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("//")) continue;
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
