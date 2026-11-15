const LIMIT = 1_000_000_000;
const integer = (n: unknown, min = 0, max = LIMIT): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const gameTime = (value: unknown): number => typeof value === "string" ? Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value) : NaN;

function object(value: unknown): Record<string, any> | null{
    let parsed = value;
    if (typeof parsed === "string"){
        try { parsed = JSON.parse(parsed); }
        catch { return null; }
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

type Sale = { marketid: number, type: "buy" | "sell", skinindex: number, amount: number, date: string };

export function contributedSale(value: unknown, now: number): Sale | null{
    const row = object(value);
    if (!row || row.status !== "completed" || !integer(row.marketid, 1, Number.MAX_SAFE_INTEGER) || !integer(row.skinindex) || !integer(row.amount, 1)) return null;
    const at = gameTime(row.date);
    if (!Number.isFinite(at) || at < now - 48 * 3_600_000 || at > now || !["buy", "sell"].includes(row.type)) return null;
    return { marketid: row.marketid, type: row.type, skinindex: row.skinindex, amount: row.amount, date: new Date(at).toISOString() };
}
