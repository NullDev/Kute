const LIMIT = 1_000_000_000;
const integer = (/** @type {unknown} */ n, min = 0, max = LIMIT) => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
// history times come as "YYYY-MM-DD HH:MM:SS" in utc; Date.parse reads that in local time and two traders disagreed by their offset
const gameTime = (/** @type {unknown} */ value) => typeof value === "string" ? Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value) : NaN;

/** @param {unknown} value @return {Record<string,any>|null} */
function object(value){
    let parsed = value;
    if (typeof parsed === "string"){
        try { parsed = JSON.parse(parsed); }
        catch { return null; }
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

/** @param {unknown} value @param {number} now */
export function contributedSale(value, now){
    const row = object(value);
    if (!row || row.status !== "completed" || !integer(row.marketid, 1, Number.MAX_SAFE_INTEGER) || !integer(row.skinindex) || !integer(row.amount, 1)) return null;
    const at = gameTime(row.date);
    if (!Number.isFinite(at) || at < now - 48 * 3_600_000 || at > now || !["buy", "sell"].includes(row.type)) return null;
    return { marketid: row.marketid, type: row.type, skinindex: row.skinindex, amount: row.amount, date: new Date(at).toISOString() };
}
