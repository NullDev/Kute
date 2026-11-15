import { kute } from "../../client";
import { choose, IMPORTANT_SHARE, screen, summarize, TARGET_REFRESH_MULTIPLE, type Reading, type Metric } from "./policy";

const ALL_SPREADS: Metric[] = ["fps", "taskP99", "p99"];

export const PIPELINE: { setting: string; key: string; label: string; }[] = [
    { setting: "hardFlip", key: "hook", label: "DXGI Swapchain Hook" },
    { setting: "patchFramePacing", key: "pacing", label: "Frame Pacing" },
    { setting: "patchCanvasBufferCache", key: "canvas", label: "WebGL Buffer Cache" },
    { setting: "patchHighQoS", key: "qos", label: "Game Process at High QoS" },
].filter((entry) => kute.platform !== "linux" || (entry.setting !== "hardFlip" && entry.setting !== "patchHighQoS"));
const MIRRORED = [
    { setting: "patchInputPriority", key: "inprio", fallback: true },
    { setting: "patchRawInputMovement", key: "rawinput", fallback: true },
    { setting: "patchAudioParamCoalesce", key: "coalesce", fallback: true },
    { setting: "audioFix", key: "panner", fallback: false },
    { setting: "uncapFps", key: "uncap", fallback: true },
];
const PROCESS_TIMEOUT_MS = 20000;
const CAP_CYCLE_TIMEOUT_MS = 70000;
const CAP_SAMPLE_MS = 1500;
const LOAD_RANGE = [0.25, 16];
const SCREENED = { contender: "better", same: "not better", worse: "worse", failed: "failed" };

export type Pipeline = Record<string, boolean>;

export function currentPipeline(): Pipeline{
    return Object.fromEntries(PIPELINE.map((entry) => [entry.setting, (kute.running?.[entry.setting] ?? kute.settings.data[entry.setting]) !== false]));
}

function keptFor(setting: string, current: Pipeline): string | null{
    if (setting !== "hardFlip" || !current.hardFlip) return null;
    if (kute.settings.data.obsCapturePlugin === true) return "kept, OBS capture needs it";
    return null;
}

function configFor(pipeline: Pipeline, common: string): string{
    const flips = PIPELINE.map((entry) => `${entry.key}=${pipeline[entry.setting] ? 1 : 0}`);
    const mirrored = MIRRORED.map((entry) => `${entry.key}=${(kute.settings.data[entry.setting] ?? entry.fallback) ? 1 : 0}`);
    const limiter = `limiter=${kute.settings.data.patchFrameLimiter === false ? "hook" : "viz"}`;
    return [...flips, ...mirrored, limiter, common].filter((part) => part !== "").join(",");
}

function readingOf(stats: any, otherTasks: any, present?: any): Reading{
    const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
        fps: number(stats?.fps),
        p50: number(stats?.p50),
        p99: number(stats?.p99),
        maxMs: number(stats?.maxMs),
        stallMs: number(stats?.stallMs),
        taskP99: number(otherTasks?.p99),
        inputP99: null,
        presentMs: number(present?.p50),
        invalid: !stats || !(stats.fps > 0),
    };
}

let lastRun = 0;

function matrix(configs: string[], timeoutMs: number): Promise<any[] | null>{
    const run = Date.now() * 100 + (++lastRun % 100);
    return new Promise((resolve) => {
        const pending = { timer: 0 };
        const handler = (event: MessageEvent): void => {
            if (event.data?.benchMatrix === undefined || event.data.benchRun !== run) return;
            clearTimeout(pending.timer);
            window.chrome.webview.removeEventListener("message", handler);
            resolve(event.data.cancelled ? null : event.data.benchMatrix);
        };
        pending.timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", handler);
            window.chrome.webview.postMessage("bench-cancel");
            resolve(null);
        }, timeoutMs);
        window.chrome.webview.addEventListener("message", handler);
        window.chrome.webview.postMessage(`run-bench-matrix ${run} ${JSON.stringify(configs)}`);
    });
}

export function cancel(): void{
    window.chrome.webview.postMessage("bench-cancel");
}

export interface PipelineRow {
    id: string;
    label: string;
    pipeline: Pipeline;
    readings: Reading[];
    outcome: string;
}

export interface PipelineSearch {
    winner: Pipeline;
    changed: boolean;
    decidedBy: Metric|null;
    rows: PipelineRow[];
    common: string;
    capacity: number|null;
}

export async function searchPipeline({ hz, progress, cancelled }: { hz: number; hybrid: boolean; progress: (text: string, share: number) => void; cancelled: () => boolean; }): Promise<PipelineSearch | null>{
    const current = currentPipeline();
    progress("Testing the client (1 of 4)", 0);
    const calibration = await matrix([configFor(current, `hz=${hz}`)], PROCESS_TIMEOUT_MS);
    const calibrated = readingOf(calibration?.[0]?.page?.stats, calibration?.[0]?.page?.otherTasks);
    if (cancelled() || calibrated.invalid || calibrated.fps === null) return null;
    const load = calibration?.[0]?.page?.load;
    const factor = Math.min(LOAD_RANGE[1], Math.max(LOAD_RANGE[0], calibrated.fps / (hz * TARGET_REFRESH_MULTIPLE)));
    const common = `hz=${hz},draws=${Math.round(load.draws * factor)},cpu=${Math.round(load.cpuIterations * factor)}`;

    const flips = PIPELINE.filter((entry) => keptFor(entry.setting, current) === null).map((entry) => ({ entry, pipeline: { ...current, [entry.setting]: !current[entry.setting] } }));
    progress("Testing the client (2 of 4)", 0.15);
    const first = await matrix([configFor(current, common), ...flips.map((flip) => configFor(flip.pipeline, common)), configFor(current, common)], PROCESS_TIMEOUT_MS * (flips.length + 2));
    if (cancelled() || first === null) return null;
    const read = (result: any): Reading => readingOf(result?.page?.stats, result?.page?.otherTasks, result?.present);
    const incumbentReadings = [read(first[0]), read(first[first.length - 1])];
    const base = summarize(incumbentReadings);
    const noisy = ALL_SPREADS.some((metric) => {
        const { median, spread } = base[metric];
        return median !== null && spread !== null && spread > Math.abs(median) * IMPORTANT_SHARE;
    });

    const rows: PipelineRow[] = [{ id: "current", label: "As you had it", pipeline: current, readings: incumbentReadings, outcome: "current" }];
    for (const entry of PIPELINE){
        const kept = keptFor(entry.setting, current);
        if (kept !== null) rows.push({ id: entry.setting, label: `${entry.label} off`, pipeline: current, readings: [], outcome: kept });
    }
    const contenders = [];
    for (const [index, flip] of flips.entries()){
        const reading = read(first[index + 1]);
        let verdict: keyof typeof SCREENED = reading.invalid ? "failed" : screen(reading, base);
        if (noisy && !reading.invalid) verdict = "contender";
        const label = `${flip.entry.label} ${flip.pipeline[flip.entry.setting] ? "on" : "off"}`;
        const row: PipelineRow = { id: flip.entry.setting, label, pipeline: flip.pipeline, readings: [reading], outcome: SCREENED[verdict] };
        rows.push(row);
        if (verdict === "contender") contenders.push(row);
    }
    if (contenders.length === 0) return { winner: current, changed: false, decidedBy: null, rows, common, capacity: base.fps.median };

    progress("Testing the client (3 of 4)", 0.55);
    const second = await matrix([...contenders.map((row) => configFor(row.pipeline, common)), configFor(current, common)], PROCESS_TIMEOUT_MS * (contenders.length + 1));
    if (cancelled() || second === null) return null;
    for (const [index, row] of contenders.entries()) row.readings.push(read(second[index]));
    incumbentReadings.push(read(second[second.length - 1]));

    let choice = choose({ id: "current", readings: incumbentReadings }, contenders.map((row) => ({ id: row.id, readings: row.readings })));
    for (const row of contenders){
        const judged = choice.judged.find((entry) => entry.id === row.id);
        row.outcome = "not better";
        if (judged?.rejected) row.outcome = "worse";
        else if (judged?.decidedBy) row.outcome = "better";
    }
    const improving = contenders.filter((row) => row.outcome === "better");
    let winner = rows.find((row) => row.id === choice.winner) ?? rows[0];

    if (improving.length > 1){
        progress("Testing the client (4 of 4)", 0.8);
        const pipeline = { ...current };
        for (const row of improving) pipeline[row.id] = row.pipeline[row.id];
        const combined = await matrix([configFor(pipeline, common), configFor(current, common), configFor(pipeline, common)], PROCESS_TIMEOUT_MS * 3);
        if (cancelled() || combined === null) return null;
        incumbentReadings.push(read(combined[1]));
        const row: PipelineRow = { id: "combined", label: improving.map((entry) => entry.label).join(" and "), pipeline, readings: [read(combined[0]), read(combined[2])], outcome: "not better" };
        rows.push(row);
        const together = choose({ id: winner.id, readings: winner.readings }, [{ id: row.id, readings: row.readings }]);
        const againstCurrent = choose({ id: "current", readings: incumbentReadings }, [{ id: row.id, readings: row.readings }]);
        if (together.changed && againstCurrent.changed){
            row.outcome = "better";
            winner = row;
            choice = againstCurrent;
        }
    }
    const changed = winner.id !== "current";
    return {
        winner: winner.pipeline,
        changed,
        decidedBy: changed ? choice.decidedBy : null,
        rows,
        common,
        capacity: summarize(winner.readings).fps.median,
    };
}

export async function measureCaps({ pipeline, common, caps, cancelled }: { pipeline: Pipeline; common: string; caps: number[]; cancelled: () => boolean; }): Promise<Map<number, Reading[]> | null>{
    const config = `${configFor(pipeline, common)},caps=${caps.join(".")},rounds=2,ms=${CAP_SAMPLE_MS}`;
    const result = await matrix([config], CAP_CYCLE_TIMEOUT_MS);
    const samples = result?.[0]?.page?.caps;
    if (cancelled() || !Array.isArray(samples)) return null;
    const readings: Map<number, Reading[]> = new Map(caps.map((cap) => [cap, []]));
    for (const sample of samples) readings.get(Number(sample.cap))?.push(readingOf(sample.stats, sample.otherTasks));
    return readings;
}
