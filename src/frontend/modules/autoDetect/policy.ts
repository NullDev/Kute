export const IMPORTANT_SHARE = 0.1;
export const TARGET_REFRESH_MULTIPLE = 3;
export const CLOCK_MS = 0.1;

export interface Reading {
    fps: number | null;
    p50?: number | null;
    p99: number | null;
    maxMs: number | null;
    stallMs: number | null;
    taskP99: number | null;
    inputP99: number | null;
    presentMs?: number | null;
    invalid?: boolean;
    why?: string;
    load?: Load | null;
}

export interface Load {
    cpuSpeed: number | null;
    cpuBusy: number | null;
    cpuLimit: number | null;
    thermalLimit: number | null;
    temperature: number | null;
    gpu: Record<string, { render: number, copy: number }>;
    nvidia?: { clockMhz: number | null, temperature: number | null, heldBack: number | null }[] | null;
}

export type Metric = "fps" | "p99" | "maxMs" | "stallMs" | "taskP99" | "inputP99";

interface MetricSummary {
    n: number;
    median: number | null;
    spread: number | null;
    worst?: number | null;
    best?: number | null;
}

export type Summary = Record<Metric, MetricSummary>;

type Verdict = "better" | "worse" | "same" | "unknown";

export const EXPERIENCE = ["taskP99", "inputP99", "p99", "stallMs", "maxMs"] as Metric[];
const ALL_METRICS: Metric[] = [...EXPERIENCE, "fps"];
const HIGHER_IS_BETTER: Set<Metric> = new Set(["fps"]);

function median(values: number[]): number{
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(readings: Reading[]): Summary{
    const usable = readings.filter((reading) => !reading.invalid);
    const summary = {} as Summary;
    for (const metric of ALL_METRICS){
        const values = usable.map((reading) => reading[metric]).filter((value) => typeof value === "number" && Number.isFinite(value));
        const known = values as number[];
        const ends = [Math.min(...known), Math.max(...known)];
        const [worst, best] = HIGHER_IS_BETTER.has(metric) ? ends : ends.reverse();
        summary[metric] = {
            n: known.length,
            median: known.length > 0 ? median(known) : null,
            spread: known.length > 1 ? Math.abs(best - worst) : null,
            worst: known.length > 0 ? worst : null,
            best: known.length > 0 ? best : null,
        };
    }
    return summary;
}

function floorOf(metric: Metric): number{
    return metric === "fps" ? 0 : 2 * CLOCK_MS;
}

export function compare(metric: Metric, candidate: Summary, incumbent: Summary): Verdict{
    const a = candidate[metric];
    const b = incumbent[metric];
    if (a.median === null || b.median === null || a.spread === null || b.spread === null) return "unknown";
    const gain = HIGHER_IS_BETTER.has(metric) ? a.median - b.median : b.median - a.median;
    const noise = Math.max(a.spread, b.spread, floorOf(metric));
    const important = Math.max(Math.abs(a.median), Math.abs(b.median)) * IMPORTANT_SHARE;
    if (Math.abs(gain) <= noise || Math.abs(gain) < important) return "same";
    return gain > 0 ? "better" : "worse";
}

export function guard(metric: Metric, candidate: Summary, incumbent: Summary, floor: number = floorOf(metric)): "ok" | "worse" | "unknown"{
    const a = candidate[metric];
    const b = incumbent[metric];
    if (a.n < 2 || typeof a.worst !== "number" || b.median === null || b.spread === null) return "unknown";
    const loss = HIGHER_IS_BETTER.has(metric) ? b.median - a.worst : a.worst - b.median;
    const important = Math.max(Math.abs(a.worst), Math.abs(b.median)) * IMPORTANT_SHARE;
    return loss > Math.max(b.spread, floor) && loss >= important ? "worse" : "ok";
}

export function wins(metric: Metric, candidate: Summary, incumbent: Summary): boolean{
    const a = candidate[metric];
    const b = incumbent[metric];
    if (a.n < 2 || b.n < 2 || typeof a.worst !== "number" || typeof b.best !== "number") return false;
    const gain = HIGHER_IS_BETTER.has(metric) ? a.worst - b.best : b.best - a.worst;
    return gain > floorOf(metric) && gain >= Math.max(Math.abs(a.worst), Math.abs(b.best)) * IMPORTANT_SHARE;
}

export function screen(reading: Reading, incumbent: Summary): "contender" | "worse" | "same"{
    if (reading.invalid) return "same";
    let ahead = false;
    for (const metric of ALL_METRICS){
        const value = reading[metric];
        const base = incumbent[metric];
        if (typeof value !== "number" || base.median === null || base.spread === null) continue;
        const gain = HIGHER_IS_BETTER.has(metric) ? value - base.median : base.median - value;
        const important = Math.max(Math.abs(value), Math.abs(base.median)) * IMPORTANT_SHARE;
        if (Math.abs(gain) <= Math.max(base.spread, floorOf(metric)) || Math.abs(gain) < important) continue;
        if (gain < 0 && EXPERIENCE.includes(metric)) return "worse";
        if (gain > 0) ahead = true;
    }
    return ahead ? "contender" : "same";
}

interface Candidate {
    id: string;
    readings: Reading[];
}

interface Judged {
    id: string;
    summary: Summary;
    verdicts: Partial<Record<Metric, Verdict>>;
    rejected: boolean;
    decidedBy: Metric | null;
}

interface Choice {
    winner: string;
    changed: boolean;
    inconclusive: boolean;
    decidedBy: Metric | null;
    incumbent: Summary;
    judged: Judged[];
}

export function choose(incumbent: Candidate, candidates: Candidate[], options: { fpsCounts?: boolean } = {}): Choice{
    const base = summarize(incumbent.readings);
    const judged: Judged[] = candidates.map((candidate) => {
        const summary = summarize(candidate.readings);
        const verdicts: Partial<Record<Metric, Verdict>> = {};
        for (const metric of ALL_METRICS) verdicts[metric] = compare(metric, summary, base);
        const rejected = EXPERIENCE.some((metric) => guard(metric, summary, base) === "worse");
        let decidedBy: Metric | null = EXPERIENCE.find((metric) => wins(metric, summary, base)) ?? null;
        if (decidedBy === null && options.fpsCounts !== false && wins("fps", summary, base)) decidedBy = "fps";
        return { id: candidate.id, summary, verdicts, rejected, decidedBy };
    });

    const inconclusive = judged.length > 0 && judged.every((entry) => ALL_METRICS.every((metric) => entry.verdicts[metric] === "unknown"));
    const rank = (entry: Judged): number => (entry.decidedBy === null ? ALL_METRICS.length : ALL_METRICS.indexOf(entry.decidedBy));
    const improving = judged.filter((entry) => !entry.rejected && entry.decidedBy !== null).sort((a, b) => rank(a) - rank(b));
    const winner = improving[0] ?? null;

    return {
        winner: winner?.id ?? incumbent.id,
        changed: winner !== null,
        inconclusive,
        decidedBy: winner?.decidedBy ?? null,
        incumbent: base,
        judged,
    };
}

export function stalled(reading: Reading): boolean{
    return !reading.invalid && typeof reading.stallMs === "number" && reading.stallMs > 1000 * IMPORTANT_SHARE;
}

export function unsteady(readings: Reading[], cap: number): boolean{
    return readings.some((reading) => stalled(reading) || (!reading.invalid && cap > 0 && typeof reading.fps === "number" && reading.fps < cap * (1 - IMPORTANT_SHARE)));
}

export function steady(readings: Reading[], cap: number): boolean{
    return readings.filter((reading) => !reading.invalid).length >= 2 && !unsteady(readings, cap);
}

export function collapses(readings: Map<number, Reading[]>): boolean{
    return [...readings.values()].some((list) => list.filter(stalled).length >= 2);
}

export function steadyRungs(hz: number): number[]{
    return Array.from({ length: TARGET_REFRESH_MULTIPLE + 1 }, (_, index) => (index + 1) * hz);
}

export function steadyLimit(hz: number, readings: Map<number, Reading[]>): { cap: number | null, steadyUpTo: number | null }{
    let cap: number | null = null;
    let steadyUpTo: number | null = null;
    for (const rung of steadyRungs(hz)){
        if (!steady(readings.get(rung) ?? [], rung)) break;
        cap = steadyUpTo ?? rung;
        steadyUpTo = rung;
    }
    return { cap, steadyUpTo };
}

export function flooding(reading: Reading): boolean{
    const { presentMs, p50 } = reading;
    if (typeof presentMs !== "number" || typeof p50 !== "number") return false;
    return presentMs - p50 > Math.max(2 * CLOCK_MS, presentMs * IMPORTANT_SHARE);
}

export function atLimit(reading: Reading): Reading{
    const base = reading.p50;
    const beyond = (value: number | null): number | null => (typeof value === "number" && typeof base === "number" ? Math.max(0, value - base) : null);
    const unseen = flooding(reading) ? (reading.presentMs as number) - (base as number) : 0;
    const inputP99 = typeof reading.inputP99 === "number" ? reading.inputP99 + unseen : reading.inputP99;
    return { ...reading, fps: null, p99: beyond(reading.p99), maxMs: beyond(reading.maxMs), inputP99 };
}

const CAP_GUARDS = ["taskP99", "inputP99", "p99", "stallMs", "maxMs"] as Metric[];

function floorAtLimit(metric: Metric): number{
    return metric === "p99" || metric === "maxMs" ? 4 * CLOCK_MS : floorOf(metric);
}

interface CapJudged {
    cap: number;
    summary: Summary;
    frameMs: number | null;
    netMs: number | null;
    gains?: { task: number, input: number | null };
    outcome: "yours" | "better" | "not better" | "worse" | "not steady";
}

interface CapChoice {
    winner: number;
    changed: boolean;
    decidedBy: "net" | "tie" | null;
    judged: CapJudged[];
}

export function chooseCap(readings: Map<number, Reading[]>, incumbent: number, options: { prefer?: number, inputRequired?: boolean, trade?: boolean } = {}): CapChoice{
    const summaryOf = (cap: number): Summary => summarize((readings.get(cap) ?? []).map(atLimit));
    const frameOf = (cap: number): number | null => {
        const frames = (readings.get(cap) ?? []).filter((reading) => !reading.invalid).map((reading) => reading.p50).filter((value) => typeof value === "number");
        return frames.length > 0 ? median(frames as number[]) : null;
    };
    const base = summaryOf(incumbent);
    const baseFrame = frameOf(incumbent);

    const measured: Map<number, number> = new Map();
    const judged: CapJudged[] = [...readings.keys()].map((cap) => {
        const summary = summaryOf(cap);
        const frameMs = frameOf(cap);
        if (cap === incumbent) return { cap, summary, frameMs, netMs: null, outcome: "yours" as const };
        if (unsteady(readings.get(cap) ?? [], cap)){
            return { cap, summary, frameMs, netMs: null, outcome: "not steady" as const };
        }
        const verdicts = Object.fromEntries(CAP_GUARDS.map((metric) => [metric, compare(metric, summary, base)]));
        const fewer = incumbent === 0 || (cap > 0 && cap < incumbent);
        const unjudged = verdicts.taskP99 === "unknown" || (options.inputRequired === true && fewer && verdicts.inputP99 === "unknown");
        if (frameMs === null || baseFrame === null || unjudged){
            return { cap, summary, frameMs, netMs: null, outcome: "not better" as const };
        }
        const gainIn = (metric: Metric): number => (wins(metric, summary, base) ? (base[metric].median ?? 0) - (summary[metric].median ?? 0) : 0);
        const task = gainIn("taskP99");
        const inputLoss = options.trade === true && guard("inputP99", summary, base) === "worse" ? (summary.inputP99.median ?? 0) - (base.inputP99.median ?? 0) : 0;
        const input = verdicts.inputP99 === "unknown" ? null : gainIn("inputP99") - inputLoss;
        const netMs = task + (input ?? baseFrame - frameMs);
        measured.set(cap, task + (input ?? 0));
        const traded = inputLoss > 0 && task > inputLoss;
        let outcome: CapJudged["outcome"] = "not better";
        if (CAP_GUARDS.some((metric) => (metric !== "inputP99" || !traded) && guard(metric, summary, base, floorAtLimit(metric)) === "worse")) outcome = "worse";
        else if (netMs > 2 * CLOCK_MS) outcome = "better";
        return { cap, summary, frameMs, netMs, gains: { task, input }, outcome };
    });

    const better = judged.filter((entry) => entry.outcome === "better").sort((a, b) => (b.netMs ?? 0) - (a.netMs ?? 0));
    if (better.length > 0) return { winner: better[0].cap, changed: true, decidedBy: "net", judged };

    const preferred = judged.find((entry) => entry.cap === options.prefer && entry.cap !== incumbent);
    const fewerFrames = preferred !== undefined && (incumbent === 0 || preferred.cap < incumbent);
    if (preferred && preferred.outcome === "not better" && preferred.netMs !== null && measured.get(preferred.cap) === 0 && fewerFrames){
        return { winner: preferred.cap, changed: true, decidedBy: "tie", judged };
    }
    return { winner: incumbent, changed: false, decidedBy: null, judged };
}

interface Acceptance {
    keep: boolean;
    failed: "reference" | "result" | "unsteady" | "frame" | Metric | null;
    traded?: { task: number, input: number };
}

export function accept(reference: Reading[], result: Reading[], { capBefore, capAfter, trade = false }: { capBefore: number, capAfter: number, trade?: boolean }): Acceptance{
    const usable = (readings: Reading[]): Reading[] => readings.filter((reading) => !reading.invalid);
    if (usable(reference).length < 2) return { keep: false, failed: "reference" };
    if (usable(result).length < 2) return { keep: false, failed: "result" };
    const before = summarize(reference.map(atLimit));
    const after = summarize(result.map(atLimit));
    const slower = guard("fps", summarize(result), summarize(reference)) === "worse";

    if (unsteady(result, capAfter)){
        const improves = unsteady(reference, capBefore) && wins("stallMs", after, before) && !slower;
        if (!improves) return { keep: false, failed: "unsteady" };
    }
    let traded: Acceptance["traded"];
    for (const metric of CAP_GUARDS){
        const verdict = guard(metric, after, before, floorAtLimit(metric));
        if (verdict === "worse" && metric === "inputP99" && trade && wins("taskP99", after, before)){
            const task = (before.taskP99.median ?? 0) - (after.taskP99.median ?? 0);
            const input = (after.inputP99.median ?? 0) - (before.inputP99.median ?? 0);
            if (task > input){
                traded = { task, input };
                continue;
            }
        }
        if (verdict === "worse") return { keep: false, failed: metric };
        if (verdict === "unknown" && metric !== "inputP99") return { keep: false, failed: "reference" };
    }
    if (guard("inputP99", after, before) === "unknown"){
        const frame = (readings: Reading[]): number => median(usable(readings).map((reading) => reading.p50 ?? 0));
        const longer = frame(result) - frame(reference);
        if (longer > Math.max(2 * CLOCK_MS, frame(result) * IMPORTANT_SHARE)) return { keep: false, failed: "frame" };
    }
    if (capBefore === capAfter && slower) return { keep: false, failed: "fps" };
    return { keep: true, failed: null, ...(traded ? { traded } : {}) };
}

export function headroom(drift: number, noise: number): number{
    return 1 + Math.max(2 * Math.abs(1 - drift), noise);
}

export function experienceHolds(summary: Summary, hz: number): boolean{
    const refreshMs = 1000 / hz;
    const p99 = summary.p99.median;
    const stall = summary.stallMs.median;
    return (p99 === null || p99 <= refreshMs) && (stall === null || stall <= refreshMs);
}

export function capCandidates({ hz, capacity, current }: { hz: number, capacity: number | null, current: number }): number[]{
    const reachable = (cap: number): boolean => capacity === null || cap <= capacity;
    const caps = [TARGET_REFRESH_MULTIPLE * hz, 2 * hz, hz].filter(reachable);
    if (capacity !== null) caps.push(Math.round(capacity * 0.9));
    if (current > 0) caps.push(current);
    const unique = [...new Set(caps.map((cap) => Math.round(cap)).filter((cap) => cap > 0))].sort((a, b) => b - a);
    return [0, ...unique];
}

export function refineCaps(measured: number[], best: number, capacity: number | null, hz: number): number[]{
    const value = (cap: number): number => (cap === 0 ? capacity ?? Infinity : cap);
    const sorted = [...new Set(measured)].sort((a, b) => value(a) - value(b));
    const index = sorted.indexOf(best);
    const between: number[] = [];
    for (const neighbour of [sorted[index - 1], sorted[index + 1]]){
        if (neighbour === undefined) continue;
        const middle = (value(best) + value(neighbour)) / 2;
        if (Number.isFinite(middle)) between.push(Math.round(middle / hz) * hz);
    }
    return [...new Set(between)].filter((cap) => cap > 0 && cap !== best && !measured.includes(cap));
}
