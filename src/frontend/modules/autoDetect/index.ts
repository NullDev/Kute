import panelHtml from "../../components/autoDetect.html";
import { kute } from "../../client";
import { hostLobby, inRoom, spawn } from "../privateMatch";
import { checkCompMode, request } from "../../utils";
import { cancel as cancelBench, currentPipeline, measureCaps, PIPELINE, searchPipeline, type Pipeline, type PipelineRow, type PipelineSearch } from "./clientBench";
import { decide, MIN_RESOLUTION, SIGNIFICANT_SETTING, type MeasuredSetting, type QualityPlan } from "./decide";
import { accept, atLimit, capCandidates, chooseCap, collapses, flooding, headroom, IMPORTANT_SHARE, refineCaps, stalled, steady, steadyLimit, steadyRungs, summarize, TARGET_REFRESH_MULTIPLE, unsteady, type Reading, type Summary as MetricSummary, type Metric, type Load } from "./policy";
import { REPLAY_CIRCLE_MS, takeInputDiagnostics, takeReading, type InputDiagnostics } from "./sample";
import * as game from "./gameSettings";

const STORAGE_KEY = "kute_autodetect";
const ASKED_KEY = "kute_autodetect_asked";
const OFFER_DELAY_MS = 250;
const RESUME_RUN_DELAY_MS = 1500;
const LOGIN_TIMEOUT_MS = 300000;
const SIGN_IN_WAIT_MS = 20000;
const READ_MS = 3 * REPLAY_CIRCLE_MS;
const SETTING_READ_MS = 2 * REPLAY_CIRCLE_MS;
const PUSHED_READ_MS = 6 * REPLAY_CIRCLE_MS;
const LIMIT_WAIT_MS = 6000;
const SETTLE_MS = 450;
const CAP_SETTLE_MS = 700;
const STEADY_SPREAD = 0.08;
const CLIENT_KEYS = ["gameFpsLimit", "throttle", ...PIPELINE.map((entry) => entry.setting)];
const HOST_FEATURE = "autodetect-v2";
const HOME = "https://krunker.io/";
const STOPPED_KEY = "kute_autodetect_stopped";
const WORSE: Record<string, string> = {
    taskP99: "the game reacted later",
    inputP99: "the mouse waited longer",
    p99: "slow frames came later",
    stallMs: "more stutter",
    maxMs: "a longer freeze",
    frame: "frames took longer, and the mouse wait could not be measured",
    unsteady: "it did not run steadily",
};

interface CapRow {
    cap: number;
    where: "client test"|"test match";
    summary: MetricSummary;
    frameMs: number|null;
    netMs: number|null;
    outcome: string;
    readings?: Reading[];
}

interface Report {
    version: 2;
    gpu: string;
    cpu: string;
    hz: number;
    laptop: boolean;
    hybrid: boolean|null;
    powerOverlay: string|null;
    capacity: number;
    pushed?: {stoodStill: number, steadyUpTo: number|null, limit: number|null};
    unlimited?: Reading[];
    played?: Reading[];
    recheck?: Reading[];
    trace?: {ms: number, fps: number, load: Load|null}[];
    client?: Record<string, any>;
    hybridSource?: string|null;
    adapters?: {render: string|null, display: string|null};
    noise: number;
    drift: number;
    headroom: number;
    beforeCap: number;
    before: MetricSummary;
    afterCap: number;
    after: MetricSummary|null;
    pipeline: PipelineRow[];
    caps: CapRow[];
    halfResolutionGain: number|null;
    settings: MeasuredSetting[];
    plan: QualityPlan;
    input?: InputDiagnostics;
    rolledBack: string|null;
    pipelineRefused?: string|null;
    seconds: number;
}

interface Summary {
    title: string;
    line: string;
    details: string[];
    changed: boolean;
    needsRestart?: boolean;
}

interface Carry {
    asPlayed: Reading[];
    uncapped: Reading[];
    playedCap: number;
    pipelineBefore: Pipeline;
    pipelineAfter: Pipeline;
    pipelineChanged: boolean;
    decidedBy: Metric|null;
    rows: PipelineRow[];
    benchCaps: CapRow[];
    capOrder: number[];
    elapsedMs: number;
    resumed?: boolean;
    pipelineRefused?: string;
    recheck?: Reading[];
}

interface RunState {
    status: "running"|"done"|"prompted";
    at: number;
    snapshot: {client: Record<string, any>, game: Record<string, string|null>};
    baseline?: {client: Record<string, any>, game: Record<string, string|null>};
    carry?: Carry;
    details?: string[];
    summary?: Summary;
    report?: Report;
    showSummary?: boolean;
    undoable?: boolean;
    previous?: RunState|null;
    wizard?: WizardStage;
    wizardDetails?: string[];
}

type WizardStage = "later"|"declined"|"login"|"settings"|"import"|"run";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

function readState(): RunState | null{
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    }
    catch {
        return null;
    }
}

function writeState(state: RunState): void{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loggedIn(): boolean{
    return document.querySelector("#signedInHeaderBar") !== null;
}

function applyClient(id: string, value: string | number | boolean): void{
    kute.settings.data[id] = value;
    window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);
    for (const selector of [`#${id}`, `#slid_input_${id}`]){
        const input = document.querySelector(selector) as HTMLInputElement|null;
        if (!input) continue;
        if (input.type === "checkbox") input.checked = value === true;
        else input.value = String(value);
    }
}

function readable(value: string | number | boolean | null | undefined): string{
    if (value === null || value === undefined) return "default";
    if (String(value) === "true") return "on";
    if (String(value) === "false") return "off";
    return String(value);
}

function devOverrides(): { hz?: number; battery?: boolean; laptop?: boolean; force?: string; collapse?: number; }{
    const match = /--autodetect-dev=(\S+)/.exec(kute.launchArgs ?? "");
    const overrides: { hz?: number; battery?: boolean; laptop?: boolean; force?: string; collapse?: number; } = {};
    for (const part of match?.[1].split(",") ?? []){
        const [key, value] = part.split(":");
        if (key === "hz") overrides.hz = Number(value);
        if (key === "battery") overrides.battery = true;
        if (key === "laptop") overrides.laptop = true;
        if (key === "force") overrides.force = value;
        if (key === "collapse") overrides.collapse = Number(value);
    }
    return overrides;
}

function percent(ratio: number): string{
    const value = Math.round((ratio - 1) * 100);
    return `${value > 0 ? "+" : ""}${value} %`;
}

function shown(value: number | null, digits = 1): string{
    return value === null ? "?" : value.toFixed(digits);
}

function capName(cap: number): string{
    return cap > 0 ? `${cap} FPS` : "no limit";
}

function because(metric: Metric | null, before: MetricSummary, after: MetricSummary): string{
    if (metric === null) return "measured as smooth, with fewer frames to draw";
    const change = `${shown(before[metric].median)} to ${shown(after[metric].median)}`;
    return {
        taskP99: `the game reacts sooner: other work waited up to ${change} ms`,
        inputP99: `mouse input waits ${change} ms`,
        p99: `slowest frames ${change} ms`,
        stallMs: `stutter ${change} ms per second`,
        maxMs: `longest frame ${change} ms`,
        fps: `${shown(before.fps.median, 0)} to ${shown(after.fps.median, 0)} FPS`,
    }[metric];
}

function msText(value: number | null, sign = ""): string{
    return value === null ? "-" : `${sign}${value.toFixed(1)} ms`;
}

function msCell(value: number | null, sign = ""): string{
    return value === null ? "-" : `${sign}${value.toFixed(1)}`;
}

function metricCells(summary: MetricSummary): string{
    return `<td>${shown(summary.fps.median, 0)}</td><td>${msCell(summary.p99.median)}</td><td>${msCell(summary.taskP99.median)}</td><td>${msCell(summary.inputP99.median)}</td>`;
}

function middle(values: (number | null | undefined)[]): number | null{
    const known = (values.filter((value) => typeof value === "number") as number[]).sort((a, b) => a - b);
    if (known.length === 0) return null;
    const half = Math.floor(known.length / 2);
    return known.length % 2 === 1 ? known[half] : (known[half - 1] + known[half]) / 2;
}

function inputLine(input: InputDiagnostics | undefined): string{
    if (!input || input.readings === 0) return "";
    if (input.withInput > 0){
        return `<p>Input test: ${input.withInput} of ${input.readings} readings in the match had mouse input from Kute (${input.hostSteps} steps sent, ${input.pageEvents} seen by the game).</p>`;
    }
    const reasons = Object.entries(input.ended).filter(([reason]) => reason !== "done" && reason !== "stopped").map(([reason, count]) => `${reason}: ${count}x`).join(", ");
    let why = "the game did not hold the mouse when the readings started";
    if (input.asked > 0) why = reasons || `Kute sent ${input.hostSteps} steps, the game saw ${input.pageEvents} mouse events`;
    return `<p class="adWarn">The input test did not reach the game (${why}). Mouse wait and settings that only cost in a fight were not measured.</p>`;
}

function span(values: (number | null | undefined)[], unit: string): string{
    const known = (values.filter((value) => typeof value === "number") as number[]).map(Math.round);
    if (known.length === 0) return "-";
    const [low, high] = [Math.min(...known), Math.max(...known)];
    return low === high ? `${low} ${unit}` : `${low} to ${high} ${unit}`;
}

function loadHtml(report: Report): string{
    const sets: [string, Reading[]][] = [
        [`As you had it (${capName(report.beforeCap)})`, report.played ?? []],
        ["no limit, first readings", report.unlimited ?? []],
        ...report.caps.filter((row) => row.where === "test match").map((row) => ([capName(row.cap), row.readings ?? []] as [string, Reading[]])),
    ];
    const { render = null, display = null } = report.adapters ?? {};
    const two = render !== null && display !== null && render !== display;
    const clockOf = (load: Load | null | undefined): number | null => {
        const clocks = (load?.nvidia ?? []).map((gpu) => gpu.clockMhz).filter((clock) => typeof clock === "number");
        return clocks.length > 0 ? Math.max(...(clocks as number[])) : null;
    };
    const heldBack = (load: Load | null | undefined): string => {
        const bits = (load?.nvidia ?? []).reduce((all, gpu) => all | (gpu.heldBack ?? 0), 0);
        const reasons = [[1, "heat"], [2, "power limit"], [4, "battery"], [16, "weak power supply"]].filter(([bit]) => (bits & Number(bit)) !== 0).map(([, name]) => name);
        if (reasons.length > 0) return reasons.join(", ");
        return bits === 0 ? "no" : `yes (${bits})`;
    };
    const nvidia = [...(report.played ?? []), ...(report.unlimited ?? [])].some((reading) => (reading.load?.nvidia ?? []).length > 0);
    const rows = sets.filter(([, readings]) => readings.some((reading) => reading.load)).map(([label, readings]) => {
        const loads = readings.map((reading) => reading.load);
        const chip = (luid: string | null, kind: "render" | "copy"): string => span(loads.map((load) => (luid === null ? null : load?.gpu?.[luid]?.[kind])), "%");
        return `<tr><td>${label}</td><td>${span(readings.map((reading) => reading.fps), "")}</td><td>${span(loads.map((load) => load?.cpuBusy), "%")}</td>
            <td>${span(loads.map((load) => load?.cpuSpeed), "%")}</td><td>${chip(render, "render")}</td>${nvidia ? `<td>${span(loads.map(clockOf), "MHz")}</td>` : ""}
            ${two ? `<td>${chip(display, "render")}</td><td>${chip(display, "copy")}</td>` : ""}
            <td>${span(loads.map((load) => load?.temperature), "C")}</td><td>${span(loads.map((load) => load?.thermalLimit), "%")}</td></tr>`;
    });
    if (rows.length === 0) return "";
    const trace = (report.trace ?? []).map((step) => `<tr><td>${(step.ms / 1000).toFixed(1)} s</td><td>${step.fps}</td><td>${span([step.load?.cpuSpeed], "%")}</td>
        <td>${span([render === null ? null : step.load?.gpu?.[render]?.render], "%")}</td><td>${span([clockOf(step.load)], "MHz")}</td><td>${heldBack(step.load)}</td></tr>`);
    return `<div class="adScroll"><table class="adNum"><tr><th></th><th>FPS</th><th>Processor busy</th><th>Processor speed</th><th>Graphics card busy</th>${nvidia ? "<th>Graphics clock</th>" : ""}
        ${two ? "<th>Screen's chip busy</th><th>Screen's chip copying</th>" : ""}<th>Hottest</th><th>Heat limit</th></tr>${rows.join("")}</table></div>
        <p class="adNote">Processor speed is its share of the nominal clock: above 100 % with turbo, far below while the PC throttles it. A heat limit under 100 % means the firmware slows the PC down.
        A graphics clock that drops while the frame rate drops means the graphics driver is saving power.</p>
        ${trace.length > 0 ? `<h4>Without a limit, step by step</h4><div class="adScroll"><table class="adNum"><tr><th>Time</th><th>FPS</th><th>Processor speed</th><th>Graphics card busy</th><th>Graphics clock</th><th>Driver holds it back</th></tr>${trace.join("")}</table></div>` : ""}`;
}

function stoodStillNote(row: CapRow): string{
    if (row.outcome !== "not steady") return "";
    const worst = Math.max(0, ...(row.readings ?? []).map((reading) => reading.stallMs ?? 0));
    return worst > 0 ? ` (stood still ${Math.round(worst / 10)} % of the time)` : " (did not reach it)";
}

function outcomeCell(outcome: string, note = ""): string{
    const tone = { chosen: "adGood", better: "adGood", worse: "adBad", "not steady": "adBad", yours: "adMine", current: "adMine" }[outcome] ?? "";
    return `<td class="adResult ${tone}">${outcome}${note}</td>`;
}

function section(title: string, body: string, { wide = false, unit = "" }: { wide?: boolean; unit?: string; } = {}): string{
    return `<section class="adCard${wide ? " adSpan" : ""}"><h3>${title}${unit ? `<span class="adUnit">${unit}</span>` : ""}</h3>${body}</section>`;
}

function table(head: string, rows: string[], kind = "adNum"): string{
    return `<div class="adScroll"><table class="${kind}"><tr>${head}</tr>${rows.join("")}</table></div>`;
}

function overlayLine(client: Record<string, any> | undefined): string{
    const overlays = Array.isArray(client?.overlays) ? client.overlays.filter((o) => o && (o.coverage ?? 0) >= 0.05) : [];
    if (overlays.length === 0) return "";
    const names = [...new Set(overlays.map((o) => o.process || o.class))].join(", ");
    return `<p class="adWarn">A window from ${names} sits on top of the game. Windows composes every frame through the desktop then instead of flipping Kute's frames straight to the screen; closing that overlay lowers input lag.</p>`;
}

function advancedHtml(report: Report): string{
    const changed = new Set(report.plan.changes.map((change) => change.id));
    const skipped = (setting: MeasuredSetting): boolean => setting.gain === null && !changed.has(setting.id) && Boolean(setting.note);
    const settings = report.settings.filter((setting) => !skipped(setting)).map((setting) => {
        let measured = setting.note ?? "";
        if (setting.gain !== null) measured = setting.steady ? `${percent(setting.gain)} when ${readable(setting.cheap)}` : "unsteady, not used";
        const action = changed.has(setting.id) ? `<td class="adResult adGood">set to ${readable(setting.cheap)}</td>` : "<td class=\"adResult\">kept</td>";
        return `<tr><td>${setting.label}</td><td>${readable(setting.current)}</td><td>${measured}</td>${action}</tr>`;
    });
    const pipeline = report.pipeline.map((row) => `<tr><td>${row.label}</td>${metricCells(summarize(row.readings))}${outcomeCell(row.outcome)}</tr>`);
    const capsHead = "<th>Limit</th><th>Frame time</th><th>Slowest&nbsp;1&nbsp;%</th><th>Other work waits</th><th>Mouse waits</th><th>Gain</th><th class=\"adResult\">Result</th>";
    const capTables = (["client test", "test match"] as CapRow["where"][]).map((where) => {
        const rows = report.caps.filter((row) => row.where === where).map((row) => `<tr><td>${capName(row.cap)}</td><td>${msCell(row.frameMs)}</td>
            <td>${msCell(row.summary.p99.median, "+")}</td><td>${msCell(row.summary.taskP99.median)}</td><td>${msCell(row.summary.inputP99.median)}</td>
            <td>${row.netMs === null ? "" : msCell(row.netMs, row.netMs > 0 ? "+" : "")}</td>${outcomeCell(row.outcome, stoodStillNote(row))}</tr>`);
        return { where, html: rows.length > 0 ? table(capsHead, rows) : "" };
    }).filter((entry) => entry.html);
    const limited = { cpu: "the processor", gpu: "the graphics card", unknown: null }[report.plan.regime];
    let regime = "Not measured whether the processor or the graphics card holds the frame rate back.";
    if (limited) regime = `Limited by ${limited}${report.halfResolutionGain === null ? "" : ` (half the resolution: ${percent(report.halfResolutionGain)})`}.`;
    const byReason: Map<string, string[]> = new Map();
    for (const setting of report.settings.filter(skipped)){
        const reason = setting.note ?? "";
        byReason.set(reason, [...(byReason.get(reason) ?? []), `${setting.label} <span class="adWas">${readable(setting.current)}</span>`]);
    }
    const reasons = [...byReason].map(([reason, names]) => `<p><span class="adMine">${reason.charAt(0).toUpperCase()}${reason.slice(1)}</span>, kept as they were: ${names.join(", ")}.</p>`);
    const settingsHtml = (settings.length > 0 ? table("<th>Setting</th><th>Was</th><th>Measured</th><th class=\"adResult\">Result</th>", settings, "") : "") + reasons.join("");
    let graphics = "";
    if (report.hybrid === true) graphics = " Two graphics chips: frames get copied from one to the other.";
    else if (report.hybrid === null) graphics = " Could not tell which graphics chip drives the screen.";
    const metricsHead = "<th>FPS</th><th>Slowest&nbsp;1&nbsp;%</th><th>Other work waits</th><th>Mouse waits</th>";
    let capacity = `<p>Without an FPS limit this PC ran ${Math.round(report.capacity)} FPS in the test match. Kute aims for at least ${report.plan.target} FPS
        (${TARGET_REFRESH_MULTIPLE}x your ${report.hz} Hz screen), and this PC needs ${Math.round(report.plan.needed)} to keep that in a fight:
        samples of the same settings differ by ${Math.round(report.noise * 100)} %, and it ended the run at ${Math.round(report.drift * 100)} % of its starting speed.</p>`;
    if (report.pushed){
        const speeds = (report.unlimited ?? []).map((reading) => shown(reading.fps, 0)).join(", ");
        const { limit, steadyUpTo } = report.pushed;
        let found = `No limit ran steadily, not even your screen's ${report.hz} FPS, so there was no limit to offer.`;
        if (limit !== null && steadyUpTo !== null){
            found = `Up to ${steadyUpTo} FPS it ran steadily in the empty test match. A real match is heavier than that, so the limit with room is the highest multiple of your ${report.hz} Hz
            that has ${steadyUpTo > limit ? "one more steady step above it" : "run steadily"}: ${limit} FPS. A limit of your own that runs steadily is kept, a lower one would make the mouse wait longer.`;
        }
        capacity = `<p class="adWarn">This PC does not run steadily without an FPS limit: it stood still ${Math.round(report.pushed.stoodStill * 100)} % of the time
        (readings without a limit: ${speeds} FPS). That happens when a PC throttles itself under full load, common on laptops.</p>
        <p>${found} Game settings were not measured, their gain is read without a limit.</p>`;
    }
    const played = report.played ?? [];
    const flood = played.some(flooding)
        ? `<p class="adWarn">The game drew more frames than reached the screen: one every ${msText(middle(played.map((reading) => reading.p50)))}, shown one every ${msText(middle(played.map((reading) => reading.presentMs)))}.</p>`
        : "";
    const load = loadHtml(report);
    const capNote = report.pushed
        ? "On a PC that does not run steadily without a limit, the limits are not compared with each other: each one only has to run steadily."
        : "A limit is taken when the game reacts sooner or the mouse waits less with it than with yours (gain above zero), and never when anything measures worse. A lower limit's longer frames are in the mouse wait. Slowest 1 % counts beyond the frame time.";
    const caps = capTables.map((entry, index) => section(`${entry.where}: FPS limits`, `${entry.html}${index === capTables.length - 1 ? `<p class="adNote">${capNote}</p>` : ""}`, { unit: "times in ms" }));
    const cards = [
        section("This PC", `<p><b>${report.gpu}</b><br><b>${report.cpu}</b>${report.laptop ? " (laptop)" : ""}, ${report.hz} Hz${report.powerOverlay ? `, Windows power mode: ${report.powerOverlay}` : ""}.${graphics}</p>
            ${capacity}${report.rolledBack ? `<p class="adWarn">${report.rolledBack}</p>` : ""}${report.pipelineRefused ? `<p class="adWarn">${report.pipelineRefused}</p>` : ""}${inputLine(report.input)}${overlayLine(report.client)}${flood}`),
        section("Before and after", `${table(`<th></th>${metricsHead}`, [
            `<tr><td>Before (${capName(report.beforeCap)})</td>${metricCells(report.before)}</tr>`,
            report.after ? `<tr><td>After (${capName(report.afterCap)})</td>${metricCells(report.after)}</tr>` : "",
        ])}${report.after ? "" : "<p class=\"adNote\">Your setup stayed as it was, so there is no after to measure.</p>"}`, { unit: "times in ms" }),
        section("Client test: setup", pipeline.length > 0
            ? table(`<th>Setup</th>${metricsHead}<th class="adResult">Result</th>`, pipeline, "adNum adWrap")
            : "<p>The client test did not run, the client's own setup was left alone.</p>", { unit: "times in ms" }),
        ...caps,
        section("Test match: game settings", `<p>${regime}</p>${settingsHtml}
            <p class="adNote">Settings that need a reload cannot be measured in one test match, they were not changed.</p>`),
        load ? section("What the PC did", load, { wide: true }) : "",
    ];
    return `<div class="adGrid">${cards.join("")}</div>
        <div class="adFooter"><p class="adNote">The run took ${report.seconds.toFixed(0)} s. A difference only counts when it is bigger than the spread between two samples of the same setup,
        and a setup that measures worse anywhere is never taken.</p><div class="adButton" id="adCopy">Copy this report</div></div>`;
}

function rankCaps(readings: Map<number, Reading[]>, incumbentCap: number, where: CapRow["where"], prefer?: number, trade = false): { rows: CapRow[]; winner: number; reason: string; order: number[]; }{
    const choice = chooseCap(readings, incumbentCap, { prefer, inputRequired: where === "test match", trade });
    const rows: CapRow[] = choice.judged.map((entry) => ({ cap: entry.cap, where, summary: entry.summary, frameMs: entry.frameMs, netMs: entry.netMs, outcome: entry.outcome }));
    const won = choice.judged.find((entry) => entry.cap === choice.winner);
    let reason = "measures as smooth as before, with fewer frames to draw";
    if (choice.decidedBy === "net"){
        const { task = 0, input = null } = won?.gains ?? {};
        const parts = [];
        if (task > 0) parts.push(`the game reacts ${shown(task)} ms sooner`);
        if (input !== null && input > 0) parts.push(`the mouse waits ${shown(input)} ms less`);
        if (input !== null && input < 0) parts.push(`the mouse waits ${shown(-input)} ms longer, which the sooner reaction outweighs on a PC below its target`);
        reason = parts.length > 0 ? parts.join(", ") : "frames come sooner and nothing waits longer";
    }
    const order = choice.judged
        .filter((entry) => entry.cap !== incumbentCap && entry.outcome !== "worse" && entry.outcome !== "not steady")
        .sort((a, b) => (b.netMs ?? -Infinity) - (a.netMs ?? -Infinity))
        .map((entry) => entry.cap);
    return { rows, winner: choice.winner, reason, order };
}

class Panel {
    overlay: HTMLDivElement;
    onEscape: ((event: KeyboardEvent) => void) | undefined;
    root: ShadowRoot;

    constructor(){
        document.querySelector("#adPanelHost")?.parentElement?.remove();
        this.overlay = document.createElement("div");
        this.onEscape = undefined;
        this.overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.93)";
        const host = document.createElement("div");
        host.id = "adPanelHost";
        this.overlay.append(host);
        this.root = host.attachShadow({ mode: "open" });
        this.root.innerHTML = panelHtml;
        document.body.append(this.overlay);
    }

    element(id: string): HTMLElement{
        return this.root.querySelector(`#${id}`) as HTMLElement;
    }

    progress(text: string, fraction: number): void{
        this.element("adStatus").textContent = text;
        this.element("adBarFill").style.width = `${Math.round(fraction * 100)}%`;
    }

    choose(title: string, line: string, choices: { label: string; onPick: () => void; cancel?: boolean; }[], note?: string): void{
        const cancel = choices.find((choice) => choice.cancel);
        this.dismissWith(cancel ? (): void => cancel.onPick() : undefined);
        this.element("adTitle").textContent = title;
        this.element("adStatus").textContent = line;
        const noteElement = this.element("adNote");
        noteElement.textContent = note ?? "";
        noteElement.style.display = note ? "block" : "none";
        this.element("adBar").style.display = "none";
        this.element("adHint").style.display = "none";
        const actions = this.element("adActions");
        actions.style.display = "flex";
        actions.innerHTML = "";
        for (const choice of choices){
            const button = document.createElement("div");
            button.className = "adButton";
            button.textContent = choice.label;
            button.onclick = (): void => choice.onPick();
            actions.append(button);
        }
    }

    result(summary: Summary, actions: { onUndo?: () => void; onRun?: () => void; report?: Report; } = {}): void{
        this.dismissWith(() => this.close());
        this.element("adTitle").textContent = summary.title;
        this.element("adStatus").textContent = summary.line;
        this.element("adNote").style.display = "none";
        this.element("adBar").style.display = "none";
        this.element("adHint").style.display = "none";
        this.element("adActions").style.display = "flex";
        this.element("adDetailsButton").style.display = "none";
        this.element("adUndo").style.display = summary.changed && actions.onUndo ? "" : "none";
        this.element("adRun").style.display = actions.onRun ? "" : "none";
        this.element("adRestart").style.display = summary.needsRestart ? "" : "none";
        this.element("adRestart").onclick = (): void => window.chrome.webview.postMessage("restart");
        this.element("adAdvancedButton").style.display = actions.report ? "" : "none";

        const details = this.element("adDetails");
        details.innerHTML = summary.details.map((line) => `<li>${line}</li>`).join("");
        details.style.display = summary.details.length > 0 ? "block" : "none";

        if (actions.report){
            const advanced = this.element("adAdvanced");
            advanced.innerHTML = advancedHtml(actions.report);
            const button = this.element("adAdvancedButton");
            button.textContent = "Advanced";
            button.onclick = (): void => {
                const open = advanced.style.display !== "block";
                advanced.style.display = open ? "block" : "none";
                this.element("adPanel").classList.toggle("adWide", open);
                button.textContent = open ? "Hide advanced" : "Advanced";
            };
            this.element("adCopy").onclick = (): void => {
                const text = JSON.stringify({ kute: kute.version, ...actions.report }, null, 2);
                navigator.clipboard.writeText(text).then(
                    () => {
                        this.element("adCopy").textContent = "Copied";
                    },
                    () => {
                        this.element("adCopy").textContent = "Copying failed";
                    },
                );
            };
        }
        this.element("adOk").onclick = (): void => this.close();
        this.element("adUndo").onclick = (): void => {
            this.close();
            actions.onUndo?.();
        };
        this.element("adRun").onclick = (): void => {
            this.close();
            actions.onRun?.();
        };
    }

    clickThrough(enabled: boolean): void{
        this.overlay.style.pointerEvents = enabled ? "none" : "";
    }

    dismissWith(action: (() => void) | undefined): void{
        this.unbindEscape();
        this.overlay.onclick = action ? (event): void => {
            if (event.target === this.overlay) action();
        } : null;
        if (!action) return;
        this.onEscape = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            action();
        };
        document.addEventListener("keydown", this.onEscape, true);
    }

    unbindEscape(): void{
        if (this.onEscape) document.removeEventListener("keydown", this.onEscape, true);
        this.onEscape = undefined;
    }

    close(): void{
        this.unbindEscape();
        this.overlay.remove();
    }
}

function mute(muted: boolean): void{
    if (kute.hostFeatures?.includes("mute")) window.chrome.webview.postMessage(`mute, ${muted}`);
}

function runNote(): string{
    const sound = kute.hostFeatures?.includes("mute") ? " The game is muted meanwhile." : "";
    return `Takes about two minutes. Don't touch mouse or keyboard meanwhile: a test window opens and closes a few times, then Kute plays a private match by itself, turning the view and firing.${sound}`;
}

function restartNeeded(): boolean{
    return PIPELINE.some((entry) => (kute.settings.data[entry.setting] !== false) !== (kute.running?.[entry.setting] !== false));
}

function shownReport(state: RunState): Report | undefined{
    return state.report?.version === 2 ? state.report : undefined;
}

function rateOver(ms: number): Promise<number | null>{
    return new Promise((resolve) => {
        const start = performance.now();
        const state = { frames: 0, done: false, watchdog: 0 };
        const frame = (): void => {
            state.frames++;
            const elapsed = performance.now() - start;
            if (elapsed < ms){
                requestAnimationFrame(frame);
                return;
            }
            state.done = true;
            clearTimeout(state.watchdog);
            resolve((state.frames * 1000) / elapsed);
        };
        requestAnimationFrame(frame);
        state.watchdog = setTimeout(() => {
            if (!state.done) resolve(null);
        }, ms + 2000);
    });
}

async function limitHolds(cap: number): Promise<boolean>{
    if (cap === 0) return true;
    const deadline = performance.now() + LIMIT_WAIT_MS;
    while (performance.now() < deadline){
        const rate = await rateOver(250);
        if (rate === null) return false;
        if (rate <= cap * (1 + IMPORTANT_SHARE)) return true;
    }
    return false;
}

function rounded(reading: Reading): Reading{
    const short = (value: number | null | undefined): number | null => (typeof value === "number" ? Math.round(value * 100) / 100 : null);
    return {
        fps: short(reading.fps),
        p50: short(reading.p50),
        p99: short(reading.p99),
        maxMs: short(reading.maxMs),
        stallMs: short(reading.stallMs),
        taskP99: short(reading.taskP99),
        inputP99: short(reading.inputP99),
        ...(typeof reading.presentMs === "number" ? { presentMs: short(reading.presentMs) } : {}),
        ...(reading.invalid ? { invalid: true, why: reading.why } : {}),
        ...(reading.load ? { load: reading.load } : {}),
    };
}

function fpsOf(readings: Reading[]): number{
    return summarize(readings).fps.median ?? 0;
}

class AutoDetect {
    running = false;
    cancelled = false;

    snapshot(): RunState["snapshot"]{
        return {
            client: Object.fromEntries(CLIENT_KEYS.map((key) => [key, kute.settings.data[key]])),
            game: Object.fromEntries(game.ALL_IDS.map((id) => [id, game.read(id)])),
        };
    }

    restore(snapshot: RunState["snapshot"]): void{
        game.resetCache();
        for (const [id, value] of Object.entries(snapshot.game)){
            if (value !== null && game.read(id) !== value) game.write(id, value);
        }
        for (const [id, value] of Object.entries(snapshot.client)){
            if (value !== undefined && kute.settings.data[id] !== value) applyClient(id, value);
        }
    }

    undo(): void{
        const state = readState();
        if (!state?.undoable){
            kute.showNotification("Nothing to undo", false, 3);
            return;
        }
        const reloadIds = new Set(game.SETTINGS.filter((setting) => setting.needsReload).map((setting) => setting.id));
        const needsReload = Object.entries(state.snapshot.game).some(([id, value]) => reloadIds.has(id) && value !== null && game.read(id) !== value);
        this.restore(state.snapshot);
        const needsRestart = restartNeeded();
        state.undoable = false;
        let line = "Your previous settings are back.";
        if (needsReload) line = "Your previous settings are back, the game reloads once to apply them.";
        if (needsRestart) line += " Restart Kute to finish.";
        state.summary = { title: "Undone", line, details: [], changed: false, needsRestart };
        writeState(state);
        kute.showNotification(`Auto-detect undone. ${line.replace("Your previous settings are back", "Your settings are back")}`, false, 5);
        if (needsReload) setTimeout(() => location.reload(), 1200);
    }

    dropUndo(): void{
        const state = readState();
        if (!state?.undoable) return;
        state.undoable = false;
        writeState(state);
    }

    showLast(): void{
        const state = readState();
        if (!state?.summary){
            kute.showNotification("Auto-detect has not run yet", false, 3);
            return;
        }
        new Panel().result(state.summary, { onUndo: state.undoable ? (): void => this.undo() : undefined, report: shownReport(state) });
    }

    async start(options: { snapshot?: RunState["snapshot"]; details?: string[]; resume?: RunState; } = {}): Promise<void>{
        if (this.running) return;
        if (!kute.hostFeatures?.includes(HOST_FEATURE)){
            kute.showNotification("Auto-detect needs a newer Kute, update the client to use it", false, 6);
            return;
        }
        if (kute.recovery){
            kute.showNotification("Auto-detect can't run in safe mode or while Kute looks for the cause of a crash", false, 6);
            return;
        }
        if (!loggedIn()){
            kute.showNotification("Log in first: auto-detect measures in a private test match, and hosting one needs an account", false, 6);
            return;
        }
        if (document.pointerLockElement || checkCompMode()){
            kute.showNotification("Open the menu outside of a competitive match first", false, 4);
            return;
        }
        if (!options.resume && restartNeeded()){
            kute.showNotification("Restart Kute first: a setting you changed only applies after a restart, auto-detect would test the old one", false, 7);
            return;
        }
        this.running = true;
        this.cancelled = false;
        window.closWind?.();

        let state: RunState;
        let previous: RunState | null;
        if (options.resume){
            state = options.resume;
            previous = state.previous ?? null;
        }
        else {
            previous = readState();
            if (previous){
                delete previous.wizard;
                delete previous.wizardDetails;
            }
            const baseline = this.snapshot();
            state = { status: "running", at: Date.now(), snapshot: options.snapshot ?? baseline, baseline, previous, details: options.details ?? [] };
            writeState(state);
        }

        const panel = new Panel();
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            this.cancelled = true;
            cancelBench();
        };
        document.addEventListener("keydown", onKey, true);

        const venue = { inMatch: false };
        const abandon = (): void => {
            window.chrome.webview.postMessage("input-replay-stop");
            this.restore(state.snapshot);
            if (previous) writeState(previous);
            else writeState({ status: "prompted", at: Date.now(), snapshot: state.snapshot });
            panel.close();
            if (restartNeeded()) kute.showNotification("Your settings are back. Restart Kute to finish", false, 7);
            if (venue.inMatch){
                document.exitPointerLock();
                location.href = HOME;
            }
        };

        try {
            const outcome = await this.run(panel, state, venue);
            if (outcome === "restarting") return;
            if (outcome === null){
                abandon();
                return;
            }
            state.status = "done";
            state.summary = outcome.summary;
            state.report = outcome.report;
            state.undoable = outcome.summary.changed;
            if (!outcome.summary.changed && previous?.undoable){
                state.snapshot = previous.snapshot;
                state.undoable = true;
            }
            delete state.previous;
            delete state.baseline;
            delete state.carry;
            delete state.details;
            state.showSummary = true;
            writeState(state);
            panel.progress("Leaving the test match", 1);
            document.exitPointerLock();
            await sleep(800);
            location.href = HOME;
        }
        catch (error){
            const message = `Auto-detect stopped: ${error instanceof Error ? error.message : String(error)}`;
            if (venue.inMatch) sessionStorage.setItem(STOPPED_KEY, message);
            abandon();
            kute.showNotification(message, false, 7);
        }
        finally {
            document.removeEventListener("keydown", onKey, true);
            mute(false);
            window.chrome.webview.postMessage("throttle, menu");
            this.running = false;
        }
    }

    async run(panel: Panel, state: RunState, venue: { inMatch: boolean; }): Promise<{ summary: Summary; report: Report; } | "restarting" | null>{
        const dev = devOverrides();
        const baseline = state.baseline ?? state.snapshot;
        const earlier = state.details ?? [];
        const started = performance.now() - (state.carry?.elapsedMs ?? 0);
        const resumed = Boolean(state.carry);

        panel.progress("Reading your hardware", 0.02);
        const specs = await request("get-specs", "specs");
        if (specs === null) throw new Error("this needs a newer version of the client");
        const displays: { hz: number; hostsWindow: boolean; adapter?: string | null; }[] = specs.displays ?? [];
        const display = displays.find((entry) => entry.hostsWindow) ?? displays[0];
        const hz = dev.hz ?? (display?.hz > 1 ? display.hz : 60);
        const gpus: { name: string; software: boolean; vramMb: number; }[] = (specs.gpus ?? []).filter((gpu: { software: boolean; }) => !gpu.software);
        const gpuName = specs.renderAdapter?.name ?? [...gpus].sort((a, b) => b.vramMb - a.vramMb)[0]?.name ?? "unknown graphics card";
        const onBattery = dev.battery ?? Boolean(specs.onBattery);
        const mobile = dev.laptop ?? (Boolean(specs.laptop) || specs.hybrid === true);
        const target = hz * TARGET_REFRESH_MULTIPLE;

        const loadKnown = kute.hostFeatures?.includes("load-sample") === true;
        const hookRuns = kute.running?.hardFlip !== false;
        const frameCapBefore = Number(baseline.game[game.GAME_FRAME_CAP]) || 0;
        const fpsLimitBefore = Number(baseline.client.gameFpsLimit) || 0;
        const throttleBefore = Number(baseline.client.throttle) || 1;
        const ownCaps = [fpsLimitBefore, frameCapBefore].filter((cap) => cap > 0);
        const playedCap = ownCaps.length > 0 ? Math.min(...ownCaps) : 0;

        const pipelineBefore = currentPipeline();
        let search: PipelineSearch | null = null;
        let benchCaps: CapRow[] = [];
        let capOrder: number[] = [];
        if (!resumed){
            search = await searchPipeline({ hz, hybrid: specs.hybrid === true, progress: (text, share) => panel.progress(text, 0.03 + 0.27 * share), cancelled: () => this.cancelled });
            if (this.cancelled) return null;
            if (search && dev.force && dev.force in pipelineBefore){
                search = { ...search, winner: { ...pipelineBefore, [dev.force]: !pipelineBefore[dev.force] }, changed: true, decidedBy: "p99" };
            }
            if (search){
                panel.progress("Testing FPS limits", 0.31);
                const benchList = [...new Set([0, target, 2 * hz, hz, playedCap])].sort((a, b) => b - a);
                const measured = await measureCaps({ pipeline: search.winner, common: search.common, caps: benchList, cancelled: () => this.cancelled });
                if (this.cancelled) return null;
                if (measured){
                    const ranked = rankCaps(measured, playedCap, "client test", mobile ? target : undefined);
                    benchCaps = ranked.rows;
                    capOrder = ranked.order;
                }
            }
        }

        panel.progress("Opening a private test match", 0.38);
        mute(true);
        panel.clickThrough(true);
        const room = await hostLobby();
        let joined = false;
        if (room){
            panel.progress("Joining the test match", 0.41);
            joined = await spawn(room);
        }
        panel.clickThrough(false);
        if (!joined){
            window.closWind?.();
            throw new Error("could not open a private test match (is a host slot free?)");
        }
        venue.inMatch = true;
        const stillInRoom = (): void => {
            if (!inRoom(room)) throw new Error("left the private test match");
        };
        if (this.cancelled) return null;

        if (frameCapBefore > 0 && resumed) game.write(game.GAME_FRAME_CAP, "0");
        let appliedCap = Number(kute.settings.data.gameFpsLimit) || 0;
        let capHeld = true;
        takeInputDiagnostics();
        window.chrome.webview.postMessage("throttle, game");
        await sleep(2500);
        await sleep(300);
        window.chrome.webview.postMessage("bring-to-front");

        const sample = async(cap: number, ms: number = READ_MS): Promise<Reading> => {
            if (cap !== appliedCap){
                applyClient("gameFpsLimit", cap);
                appliedCap = cap;
                await sleep(CAP_SETTLE_MS);
                capHeld = await limitHolds(cap);
            }
            stillInRoom();
            if (loadKnown) await request("load-sample", "loadSample", 500);
            if (hookRuns) await request("get-present-intervals", "presentIntervals", 400);
            const reading = await takeReading({ ms, hz, replay: true });
            if (hookRuns){
                const presents = await request("get-present-intervals", "presentIntervals", 400);
                if (presents && presents.samples > 0) reading.presentMs = presents.p50;
            }
            if (loadKnown) reading.load = await request("load-sample", "loadSample", 500);
            stillInRoom();
            if (!capHeld && !reading.invalid){
                reading.invalid = true;
                reading.why = "nothing held the FPS limit";
            }
            if (dev.collapse !== undefined && (cap === 0 || cap >= dev.collapse)){
                const late = (value: number | null | undefined, extra: number): number => (value ?? 0) + extra;
                return { ...reading, fps: (reading.fps ?? 0) / 2, stallMs: 400, p99: late(reading.p99, 25), maxMs: late(reading.maxMs, 40), taskP99: late(reading.taskP99, 40), inputP99: late(reading.inputP99, 30) };
            }
            return reading;
        };
        const traceUnlimited = async(): Promise<NonNullable<Report["trace"]>> => {
            if (!loadKnown) return [];
            await sample(0, REPLAY_CIRCLE_MS);
            window.chrome.webview.postMessage(`input-replay, ${10 * REPLAY_CIRCLE_MS}`);
            const steps: NonNullable<Report["trace"]> = [];
            const start = performance.now();
            await request("load-sample", "loadSample", 500);
            while (performance.now() - start < 10 * REPLAY_CIRCLE_MS && !this.cancelled){
                const fps = await rateOver(300);
                if (fps === null) break;
                steps.push({ ms: Math.round(performance.now() - start), fps: Math.round(fps), load: await request("load-sample", "loadSample", 500) });
            }
            window.chrome.webview.postMessage("input-replay-stop");
            return steps;
        };
        const sampleTwice = async(cap: number, ms: number = READ_MS): Promise<Reading[]> => {
            const usable: Reading[] = [];
            for (let attempt = 0; attempt < 5 && usable.length < 2 && !this.cancelled; attempt++){
                const reading = await sample(cap, ms);
                if (!reading.invalid) usable.push(reading);
            }
            return usable;
        };
        const recover = async(cap: number): Promise<void> => {
            for (let attempt = 0; attempt < 4 && !this.cancelled; attempt++){
                if (!unsteady([await sample(cap, SETTING_READ_MS)], cap)) return;
            }
        };
        const sampleEach = async(caps: number[]): Promise<Map<number, Reading[]>> => {
            const readings: Map<number, Reading[]> = new Map(caps.map((cap) => [cap, []]));
            for (let round = 0; round < 2; round++){
                for (const cap of caps){
                    if (this.cancelled) return readings;
                    readings.get(cap)?.push(await sample(cap));
                }
            }
            return readings;
        };

        let { carry } = state;
        if (!carry){
            panel.progress("Measuring how the game runs now", 0.45);
            await sample(appliedCap);
            const asPlayed = await sampleTwice(appliedCap);
            if (this.cancelled) return null;
            if (asPlayed.length < 2) throw new Error("the game could not be measured, the Kute window has to stay in front during the test");
            if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, "0");
            if (throttleBefore > 1){
                applyClient("throttle", 1);
                window.chrome.webview.postMessage("throttle, game");
                await sleep(SETTLE_MS);
            }
            panel.progress("Measuring what this PC can do", 0.5);
            const unchanged = playedCap === 0 && throttleBefore <= 1;
            const uncapped = unchanged ? [...asPlayed, await sample(0)] : [await sample(0), await sample(0), await sample(0)];
            if (this.cancelled) return null;
            carry = {
                asPlayed,
                uncapped,
                playedCap,
                pipelineBefore,
                pipelineAfter: search?.winner ?? pipelineBefore,
                pipelineChanged: Boolean(search?.changed),
                decidedBy: search?.decidedBy ?? null,
                rows: search?.rows ?? [],
                benchCaps,
                capOrder,
                elapsedMs: performance.now() - started,
            };
            if (carry.pipelineChanged){
                state.carry = carry;
                writeState(state);
                if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, String(frameCapBefore));
                if (appliedCap !== fpsLimitBefore) applyClient("gameFpsLimit", fpsLimitBefore);
                for (const entry of PIPELINE){
                    if (carry.pipelineAfter[entry.setting] !== pipelineBefore[entry.setting]) applyClient(entry.setting, carry.pipelineAfter[entry.setting]);
                }
                document.exitPointerLock();
                panel.choose("Kute restarts once", "The client test found a setup that runs better on this PC. Kute restarts with it and checks it in the game, the test goes on by itself.", []);
                await sleep(3500);
                if (this.cancelled) return null;
                window.chrome.webview.postMessage("restart");
                return "restarting";
            }
        }
        const { playedCap: originalCap } = carry;
        const run = carry;

        const report = (fields: Partial<Report>): Report => ({
            version: 2,
            gpu: gpuName,
            cpu: `${specs.cpu?.name ?? "unknown processor"}, ${specs.cpu?.threads ?? "?"} threads`,
            hz,
            laptop: Boolean(specs.laptop),
            hybrid: typeof specs.hybrid === "boolean" ? specs.hybrid : null,
            powerOverlay: specs.powerOverlay ?? null,
            capacity: fpsOf(run.uncapped),
            unlimited: run.uncapped.map(rounded),
            played: run.asPlayed.map(rounded),
            adapters: { render: specs.renderAdapter?.luid ?? null, display: display?.adapter ?? null },
            hybridSource: specs.hybridSource ?? null,
            client: {
                ...Object.fromEntries(["gameFpsLimit", "throttle", "inMenuThrottle", "uncapFps", "patchFrameLimiter", "obsCapturePlugin", "renderStats", "performanceMode", "webviewPriority", ...PIPELINE.map((entry) => entry.setting)]
                    .map((key) => [key, baseline.client[key] ?? kute.settings.data[key] ?? null])),
                gameFrameCap: frameCapBefore,
                hook: specs.hook ?? null,
                overlays: specs.overlays ?? null,
                limiter: kute.frameLimiter ?? null,
                running: kute.running ?? null,
            },
            noise: 0,
            drift: 1,
            headroom: 1,
            beforeCap: originalCap,
            before: summarize(run.asPlayed),
            afterCap: originalCap,
            after: null,
            pipeline: run.rows,
            caps: run.benchCaps,
            halfResolutionGain: null,
            settings: [],
            plan: decide({ capacity: fpsOf(run.uncapped), hz, headroom: 1, halfResolutionGain: null, settings: [] }),
            input: takeInputDiagnostics(),
            rolledBack: null,
            pipelineRefused: run.pipelineRefused ?? null,
            recheck: run.recheck ?? [],
            seconds: (performance.now() - started) / 1000,
            ...fields,
        });
        const rollBack = (why: string, measured: Partial<Report> = {}): { summary: Summary; report: Report; } => {
            this.restore(state.snapshot);
            const needsRestart = restartNeeded();
            return {
                summary: { title: "Nothing changed", line: needsRestart ? `${why} Restart Kute to finish.` : why, details: [], changed: false, needsRestart },
                report: report({ ...measured, rolledBack: why }),
            };
        };
        const trade = fpsOf(run.uncapped) < target;
        const refused = (reference: Reading[], result: Reading[], capAfter: number): string | null => {
            const { keep, failed } = accept(reference, result, { capBefore: originalCap, capAfter, trade });
            if (keep) return null;
            if (failed === "reference") return "Kute could not measure the game with your own settings well enough to compare (its window has to stay in front), so it put yours back.";
            if (failed === "result") return "Kute could not measure the result (its window has to stay in front), so it put your settings back.";
            const why = failed === "fps" ? `${Math.round(fpsOf(result))} FPS, ${Math.round(fpsOf(reference))} before` : WORSE[failed ?? ""];
            return `The new settings measured worse than yours (${why}), so Kute put yours back.`;
        };

        const details: string[] = [...earlier];
        if (throttleBefore > 1) details.push(`<b>CPU Throttling</b>: ${throttleBefore} → off (it slows the game down on purpose, the result is checked against how the game ran with it)`);
        if (resumed && run.pipelineChanged && !run.pipelineRefused){
            panel.progress("Checking the new setup in the game", 0.5);
            const playedNow = await sampleTwice(originalCap);
            if (this.cancelled) return null;
            const recheck = { recheck: playedNow.map(rounded) };
            const worse = unsteady(run.asPlayed, originalCap) && unsteady(playedNow, originalCap) ? null : refused(run.asPlayed, playedNow, originalCap);
            if (worse && accept(run.asPlayed, playedNow, { capBefore: originalCap, capAfter: originalCap, trade }).failed === "result") return rollBack(worse.replace("The new settings", "The setup that won the client test"), recheck);
            if (worse){
                for (const entry of PIPELINE){
                    if (run.pipelineAfter[entry.setting] !== run.pipelineBefore[entry.setting]) applyClient(entry.setting, run.pipelineBefore[entry.setting]);
                }
                if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, String(frameCapBefore));
                if (appliedCap !== fpsLimitBefore) applyClient("gameFpsLimit", fpsLimitBefore);
                state.carry = { ...run, pipelineRefused: worse.replace("The new settings", "The setup that won the client test"), ...recheck, elapsedMs: performance.now() - started, resumed: false };
                writeState(state);
                document.exitPointerLock();
                panel.choose("Kute restarts once more", "The setup from the client test ran worse in the game, so Kute goes back to yours and tests the FPS limits on it.", []);
                await sleep(3500);
                if (this.cancelled) return null;
                window.chrome.webview.postMessage("restart");
                return "restarting";
            }
            const winnerRow = run.rows.find((row) => PIPELINE.every((entry) => row.pipeline[entry.setting] === run.pipelineAfter[entry.setting]));
            const reason = winnerRow ? because(run.decidedBy, summarize(run.rows[0].readings), summarize(winnerRow.readings)) : "measured better";
            for (const entry of PIPELINE){
                if (run.pipelineAfter[entry.setting] === run.pipelineBefore[entry.setting]) continue;
                details.push(`<b>${entry.label}</b>: ${readable(run.pipelineBefore[entry.setting])} → ${readable(run.pipelineAfter[entry.setting])} (${reason})`);
            }
        }

        panel.progress("Finding the FPS limit that runs best", 0.56);
        const roughCapacity = fpsOf(run.uncapped);
        const batteryCap = roughCapacity >= target ? target : hz;
        const allowed = (cap: number): boolean => !onBattery || cap === originalCap || (cap !== 0 && cap <= target);
        const floods = run.uncapped.filter(flooding).length >= 2;
        const prefer = (mobile || floods) && roughCapacity >= target ? target : undefined;
        let measuredCaps: Map<number, Reading[]> = new Map();
        let capRows: CapRow[] = [];
        let bestCap = originalCap;
        let capReason = "";
        let capacity = roughCapacity;
        let pushed = collapses(new Map([[0, run.uncapped]]));
        if (!pushed){
            const fromBench = run.capOrder.length > 0 ? run.capOrder.slice(0, 2) : capCandidates({ hz, capacity: roughCapacity, current: originalCap }).slice(1, 3);
            const candidates = [...new Set([originalCap, 0, ...fromBench, ...(prefer ? [prefer] : []), ...(onBattery ? [batteryCap] : [])])].filter(allowed);
            measuredCaps = await sampleEach(candidates);
            if (this.cancelled) return null;
            pushed = collapses(measuredCaps);
            const ranked = rankCaps(measuredCaps, originalCap, "test match", prefer, trade);
            capRows = ranked.rows;
            if (!pushed){
                bestCap = ranked.winner;
                capReason = ranked.reason;
                capacity = fpsOf(measuredCaps.get(0) ?? []) || roughCapacity;

                const between = refineCaps([...measuredCaps.keys()], bestCap, capacity, hz).filter((cap) => allowed(cap) && cap < capacity);
                if (between.length > 0){
                    panel.progress("Fine tuning the FPS limit", 0.64);
                    const finer = await sampleEach(between);
                    if (this.cancelled) return null;
                    const refined = rankCaps(new Map([[bestCap, measuredCaps.get(bestCap) ?? []], ...finer]), bestCap, "test match", undefined, trade);
                    capRows.push(...refined.rows.filter((row) => row.cap !== bestCap));
                    for (const [cap, readings] of finer) measuredCaps.set(cap, readings);
                    if (refined.winner !== bestCap){
                        bestCap = refined.winner;
                        capReason = refined.reason;
                    }
                    pushed = collapses(measuredCaps);
                }
            }
        }

        let pushedFacts: Report["pushed"];
        if (pushed){
            panel.progress("Finding the FPS limit this PC holds steadily", 0.62);
            const ladder: Map<number, Reading[]> = new Map();
            await recover(hz);
            for (const rung of steadyRungs(hz)){
                if (this.cancelled) return null;
                const readings = await sampleTwice(rung, PUSHED_READ_MS);
                ladder.set(rung, readings);
                if (!steady(readings, rung)) break;
            }
            if (this.cancelled) return null;
            const limit = steadyLimit(hz, ladder);
            const stoodStill = (middle([...run.uncapped, ...(measuredCaps.get(0) ?? [])].filter(stalled).map((reading) => reading.stallMs)) ?? 0) / 1000;
            pushedFacts = { stoodStill, steadyUpTo: limit.steadyUpTo, limit: limit.cap };
            for (const row of capRows){
                if (row.outcome === "better") row.outcome = "not used";
            }
            for (const [rung, readings] of ladder){
                const outcome = steady(readings, rung) ? "steady" : "not steady";
                capRows.push({ cap: rung, where: "test match", summary: summarize(readings.map(atLimit)), frameMs: middle(readings.map((reading) => reading.p50)), netMs: null, outcome });
                measuredCaps.set(rung, readings);
            }
            const ownSteady = originalCap > 0 && steady(run.asPlayed, originalCap);
            bestCap = originalCap;
            if (!ownSteady){
                const offers = [...new Set([limit.cap, limit.steadyUpTo])].filter((cap) => cap !== null) as number[];
                bestCap = offers.find((cap) => accept(run.asPlayed, ladder.get(cap) ?? [], { capBefore: originalCap, capAfter: cap }).keep) ?? originalCap;
            }
            capReason = `without a limit this PC stood still ${Math.round(stoodStill * 100)} % of the time. Up to ${limit.steadyUpTo} FPS it ran steadily in the empty test match, ${bestCap} FPS ${(limit.steadyUpTo ?? 0) > bestCap ? "leaves a step of room for a real match" : "is the highest that did"}`;
        }
        const batteryRow = capRows.find((row) => row.cap === batteryCap);
        const batteryFine = batteryRow !== undefined && (batteryRow.outcome === "steady" || (batteryRow.netMs !== null && (batteryRow.outcome === "better" || batteryRow.outcome === "not better")));
        if (onBattery && (bestCap === 0 || bestCap > target) && batteryFine){
            bestCap = batteryCap;
            capReason = "on battery";
        }
        for (const row of capRows){
            if (row.cap === bestCap && row.cap !== originalCap && row.outcome !== "not steady") row.outcome = "chosen";
            row.readings = (measuredCaps.get(row.cap) ?? []).map(rounded);
        }

        const speeds = run.uncapped.map((reading) => reading.fps).filter((fps) => typeof fps === "number");
        const noise = speeds.length > 1 ? (Math.max(...speeds) - Math.min(...speeds)) / Math.max(1, ...speeds) : 0;
        let drift = 1;
        let margin = 1;
        let late: Reading | null = null;
        if (!pushed){
            late = await sample(0);
            const firstUncapped = (resumed ? measuredCaps.get(0)?.[0] : run.uncapped[0])?.fps ?? capacity;
            drift = (late.fps ?? capacity) / Math.max(1, firstUncapped);
            margin = headroom(drift, noise);
        }
        const needed = target * margin;

        const settings: MeasuredSetting[] = [];
        let halfResolutionGain: number | null = null;
        const resolution = Number(baseline.game[game.RESOLUTION]) || 1;
        if (pushed){
            for (const setting of game.SETTINGS){
                settings.push({ id: setting.id, label: setting.label, current: baseline.game[setting.id] ?? "default", cheap: String(setting.cheap), gain: null, steady: true, note: "not tested (this PC does not run steadily without a limit)" });
            }
        }
        else if (capacity < needed){
            const replayWorks = run.asPlayed.some((reading) => reading.inputP99 !== null);
            let reference = late?.fps ?? capacity;
            const measure = async(apply: () => void, revert: () => void): Promise<{ ratio: number; steady: boolean; raw: number[]; }> => {
                const first = reference;
                apply();
                await sleep(SETTLE_MS);
                const fpsNow = async(): Promise<number | null> => {
                    const reading = await sample(0, SETTING_READ_MS);
                    return reading.invalid ? null : reading.fps;
                };
                const changed = await fpsNow();
                revert();
                await sleep(SETTLE_MS);
                const after = await fpsNow();
                if (changed === null || after === null) return { ratio: 1, steady: false, raw: [first, changed ?? 0, after ?? 0] };
                reference = after;
                const mean = (first + after) / 2;
                return {
                    ratio: changed / Math.max(1, mean),
                    steady: Math.abs(first - after) / Math.max(1, mean) <= STEADY_SPREAD,
                    raw: [first, changed, after],
                };
            };

            const live = game.SETTINGS.filter((setting) => !setting.needsReload && (replayWorks || !setting.fightOnly));
            for (const setting of game.SETTINGS){
                const current = baseline.game[setting.id];
                const cheap = String(setting.cheap);
                const row: MeasuredSetting = { id: setting.id, label: setting.label, current: current ?? "default", cheap, gain: null, steady: true };
                settings.push(row);
                if (setting.needsReload){
                    row.note = "not tested (needs a reload)";
                    continue;
                }
                if (setting.fightOnly && !replayWorks){
                    row.note = "not tested (only costs in a fight)";
                    continue;
                }
                if (current === null){
                    row.note = "value unknown";
                    continue;
                }
                if (this.cancelled) return null;
                panel.progress(`Measuring ${setting.label}`, 0.68 + (0.17 * live.indexOf(setting)) / live.length);
                const flipped = game.opposite(current);
                const measurement = await measure(() => game.write(setting.id, flipped), () => game.write(setting.id, current));
                row.gain = flipped === cheap ? measurement.ratio : 1 / Math.max(0.01, measurement.ratio);
                row.steady = measurement.steady;
                row.raw = measurement.raw;
            }
            for (const row of settings){
                if (row.gain === null || !row.steady || row.current === row.cheap || row.gain < SIGNIFICANT_SETTING) continue;
                if (this.cancelled) return null;
                panel.progress(`Confirming ${row.label}`, 0.86);
                const confirmed = await measure(() => game.write(row.id, row.cheap), () => game.write(row.id, row.current));
                row.confirmGain = confirmed.ratio;
                row.gain = Math.min(row.gain, confirmed.ratio);
                row.steady = confirmed.steady;
            }
            panel.progress("Checking the graphics card", 0.88);
            const half = await measure(
                () => game.write(game.RESOLUTION, String(Math.max(0.1, resolution * 0.5))),
                () => game.write(game.RESOLUTION, String(resolution)),
            );
            halfResolutionGain = half.steady && half.ratio > 0.92 ? half.ratio : null;
        }
        else {
            for (const setting of game.SETTINGS){
                settings.push({ id: setting.id, label: setting.label, current: baseline.game[setting.id] ?? "default", cheap: String(setting.cheap), gain: null, steady: true, note: "not tested (this PC reaches its target)" });
            }
        }
        if (this.cancelled) return null;

        const plan = decide({ capacity, hz, headroom: margin, halfResolutionGain, settings });
        for (const change of plan.changes){
            details.push(`<b>${change.label}</b>: ${readable(baseline.game[change.id])} → ${readable(change.value)} (${change.reason})`);
            game.write(change.id, String(change.value));
        }
        let capacityAfter: number | null = null;
        if (plan.changes.length > 0 || plan.tuneResolution){
            await sleep(SETTLE_MS);
            capacityAfter = (await sample(0, SETTING_READ_MS)).fps;
        }
        if (plan.tuneResolution && capacityAfter !== null){
            let scale = resolution;
            for (let step = 0; step < 2 && capacityAfter !== null && capacityAfter < plan.needed && scale > MIN_RESOLUTION && !this.cancelled; step++){
                const estimate = step === 0 ? scale * Math.sqrt(capacityAfter / plan.needed) : MIN_RESOLUTION;
                scale = Math.min(scale, Math.max(MIN_RESOLUTION, Math.floor(estimate * 20) / 20));
                panel.progress(`Trying resolution ${scale}`, 0.9 + step * 0.01);
                game.write(game.RESOLUTION, String(scale));
                await sleep(SETTLE_MS);
                capacityAfter = (await sample(0, SETTING_READ_MS)).fps;
            }
            if (scale !== resolution) details.push(`<b>Resolution</b>: ${resolution} → ${scale} (the graphics card is the limit)`);
        }
        if (this.cancelled) return null;

        panel.progress("Checking the result", 0.94);
        if (plan.changes.length > 0) await sample(bestCap);
        const trace = pushed ? await traceUnlimited() : [];
        if (pushed) await recover(bestCap);
        const finalReadings = await sampleTwice(bestCap, pushed ? PUSHED_READ_MS : READ_MS);
        if (this.cancelled) return null;
        const measured = {
            capacity,
            noise,
            drift,
            headroom: margin,
            afterCap: bestCap,
            after: summarize(finalReadings),
            caps: [...run.benchCaps, ...capRows],
            halfResolutionGain,
            settings,
            plan,
            pushed: pushedFacts,
            ...(trace.length > 0 ? { trace } : {}),
        };
        const capChanged = bestCap !== originalCap;
        const capMoved = !capChanged && frameCapBefore > 0 && (fpsLimitBefore === 0 || frameCapBefore < fpsLimitBefore);
        if (capChanged) details.push(`<b>FPS Limit</b>: ${capName(originalCap)} → ${capName(bestCap)} (${capReason})`);
        else if (capMoved) details.push(`<b>FPS Limit</b>: ${capName(bestCap)}, now held by Kute instead of the game's frame cap (the game's cap keeps the processor busy while it waits)`);
        const changed = details.length > 0;
        const ownChanges = details.length > earlier.length;
        if (ownChanges){
            const again = (measuredCaps.get(originalCap) ?? []).filter((reading) => !reading.invalid);
            const exact = resumed || frameCapBefore > 0 || throttleBefore > 1;
            const worse = refused(!exact && again.length >= 2 ? again : run.asPlayed, finalReadings, bestCap);
            if (worse) return rollBack(worse, measured);
        }
        else {
            if (frameCapBefore > 0) game.write(game.GAME_FRAME_CAP, String(frameCapBefore));
            if (appliedCap !== fpsLimitBefore) applyClient("gameFpsLimit", fpsLimitBefore);
        }
        game.resetCache();

        const aims = `${target} FPS (${TARGET_REFRESH_MULTIPLE}x your ${hz} Hz screen)`;
        const count = `${details.length} setting${details.length === 1 ? "" : "s"} changed.`;
        let line = `Your PC ran ${Math.round(capacity)} FPS in the test match, above the ${aims} Kute aims for. Nothing needed changing.`;
        if (changed && capacityAfter !== null) line = `${count} Test match without a limit: ${Math.round(capacity)} FPS before, ${Math.round(capacityAfter)} after. Kute aims for at least ${aims} with no stutter.`;
        else if (changed) line = `${count} Without a limit your PC runs ${Math.round(capacity)} FPS in the test match, Kute aims for at least ${aims} with no stutter.`;
        else if (capacity < target) line = `Your PC ran ${Math.round(capacity)} FPS in the test match, Kute aims for at least ${aims}. No setting measurably helps on this PC, so nothing was changed.`;
        let title = changed ? "Optimized" : "Nothing to change";
        if (pushedFacts){
            const still = `Without an FPS limit this PC does not run steadily: it stood still ${Math.round(pushedFacts.stoodStill * 100)} % of the time in the test match.`;
            const { limit, steadyUpTo } = pushedFacts;
            if (capChanged){
                line = `${still} Kute limits it to ${bestCap} FPS, which ran steadily${(steadyUpTo ?? 0) > bestCap ? " with room to spare" : ""}.`;
            }
            else if (bestCap > 0 && steady(run.asPlayed, bestCap)){
                const hint = limit !== null && limit < bestCap ? ` If real matches still stutter, try ${limit} FPS, it leaves more room.` : "";
                line = `${still} Your limit of ${bestCap} FPS runs steadily in the test match, so Kute kept it.${hint}`;
            }
            else if (limit === null){
                title = "No steady setting found";
                line = `${still} No limit Kute tried ran steadily either, so nothing was changed.`;
            }
            else {
                line = `${still} The limits that ran steadily measured worse than your setup in another way, so nothing was changed.`;
            }
        }

        await sleep(150);
        const needsRestart = restartNeeded();
        return {
            summary: { title, line: needsRestart ? `${line} Restart Kute to finish.` : line, details, changed, needsRestart },
            report: report({ ...measured, after: ownChanges ? measured.after : null }),
        };
    }

    remember(wizard: WizardStage, snapshot?: RunState["snapshot"], details?: string[]): void{
        const state = readState() ?? { status: "prompted" as const, at: Date.now(), snapshot: { client: {}, game: {} } };
        writeState({ ...state, at: Date.now(), wizard, ...(snapshot ? { snapshot } : {}), ...(details ? { wizardDetails: details } : {}) });
    }

    offer(): void{
        if (this.running || sessionStorage.getItem(ASKED_KEY) || !kute.hostFeatures?.includes(HOST_FEATURE) || kute.recovery) return;
        if (document.pointerLockElement){
            document.addEventListener("pointerlockchange", () => setTimeout(() => this.offer(), 1500), { once: true });
            return;
        }
        sessionStorage.setItem(ASKED_KEY, "1");
        const panel = new Panel();
        panel.choose(
            "Set Kute up for this PC?",
            "Kute can set the game up for what this PC can do: it measures in a private test match, and everything it changes can be undone. You have to be logged in for that.",
            [
                {
                    label: "Yes",
                    onPick: (): void => {
                        this.setUp(panel);
                    },
                },
                {
                    label: "Ask later",
                    onPick: (): void => {
                        panel.close();
                        this.remember("later");
                    },
                },
                {
                    label: "No",
                    cancel: true,
                    onPick: (): void => this.decline(panel),
                },
            ],
            runNote(),
        );
    }

    decline(panel: Panel): void{
        panel.close();
        this.remember("declined");
        kute.showNotification("Got it. You can always start the setup from Settings, Client", false, 5);
    }

    async signedIn(): Promise<boolean>{
        if (loggedIn()) return true;
        if (!localStorage.getItem("krunker_token")) return false;
        const until = Date.now() + SIGN_IN_WAIT_MS;
        while (Date.now() < until){
            await sleep(250);
            if (loggedIn()) return true;
        }
        return false;
    }

    async setUp(panel: Panel = new Panel()): Promise<void>{
        if (this.running){
            panel.close();
            return;
        }
        panel.choose("Setting Kute up", "Checking your account.", []);
        if (!await this.signedIn()){
            this.askLogin(panel);
            return;
        }
        this.askSettings(panel);
    }

    askLogin(panel: Panel = new Panel()): void{
        this.remember("login");
        panel.choose("Log in to continue", "Kute measures in a private test match, and hosting one needs an account.", [
            {
                label: "Log in",
                onPick: (): void => {
                    panel.close();
                    window.loginOrRegister();
                    this.waitForLogin();
                },
            },
            {
                label: "Ask later",
                onPick: (): void => {
                    panel.close();
                    this.remember("later");
                },
            },
            {
                label: "Cancel",
                cancel: true,
                onPick: (): void => this.decline(panel),
            },
        ]);
    }

    waitForLogin(): void{
        const until = Date.now() + LOGIN_TIMEOUT_MS;
        const timer = setInterval(() => {
            if (loggedIn()){
                clearInterval(timer);
                this.askSettings();
                return;
            }
            if (Date.now() > until) clearInterval(timer);
        }, 1000);
    }

    askSettings(panel: Panel = new Panel()): void{
        this.remember("settings");
        panel.choose(
            "Where should your game settings come from?",
            "Kute measures this PC either way and sets what it finds. This is only about the settings it starts from.",
            [
                {
                    label: "Import a settings.txt",
                    onPick: (): void => {
                        panel.close();
                        this.remember("import");
                        window.importSettingsPopup();
                    },
                },
                {
                    label: "Kute's preset",
                    onPick: (): void => {
                        panel.close();
                        this.applyPreset();
                    },
                },
                {
                    label: "Keep my settings",
                    onPick: (): void => {
                        panel.close();
                        this.start();
                    },
                },
                {
                    label: "Cancel",
                    cancel: true,
                    onPick: (): void => this.decline(panel),
                },
            ],
            runNote(),
        );
    }

    afterImport(): void{
        if (readState()?.wizard !== "import") return;
        const snapshot = this.snapshot();
        this.remember("run", snapshot, []);
        setTimeout(() => {
            if (readState()?.wizard === "run") this.start({ snapshot });
        }, 1500);
    }

    applyPreset(): void{
        const snapshot = this.snapshot();
        const details: string[] = [];
        for (const [id, value] of Object.entries(game.PRESET)){
            if (String(snapshot.game[id]) === String(value)) continue;
            game.write(id, value);
            details.push(`<b>${game.label(id)}</b>: ${readable(snapshot.game[id])} → ${readable(value)} (Kute's preset)`);
        }
        this.remember("run", snapshot, details);
        kute.showNotification("Applying Kute's preset, the game reloads once", false, 4);
        setTimeout(() => location.reload(), 1200);
    }

    resume(): void{
        const state = readState();
        if (state?.status === "running"){
            if (state.carry && !state.carry.resumed){
                state.carry.resumed = true;
                writeState(state);
                setTimeout(async() => {
                    if (await this.signedIn()){
                        this.start({ resume: state });
                        return;
                    }
                    this.restore(state.snapshot);
                    if (state.previous) writeState(state.previous);
                    else localStorage.removeItem(STORAGE_KEY);
                    kute.showNotification("Auto-detect could not go on (not logged in). Your settings are back, restart Kute to finish", false, 8);
                }, RESUME_RUN_DELAY_MS);
                return;
            }
            this.restore(state.snapshot);
            if (state.previous) writeState(state.previous);
            else localStorage.removeItem(STORAGE_KEY);
            return;
        }
        const stopped = sessionStorage.getItem(STOPPED_KEY);
        if (stopped){
            sessionStorage.removeItem(STOPPED_KEY);
            setTimeout(() => kute.showNotification(stopped, false, 12), RESUME_RUN_DELAY_MS);
        }
        if (state?.showSummary && state.summary){
            state.showSummary = false;
            writeState(state);
            new Panel().result(state.summary, { onUndo: () => this.undo(), report: shownReport(state) });
            return;
        }
        if (state?.wizard === "run"){
            setTimeout(async() => {
                if (await this.signedIn()) this.start({ snapshot: state.snapshot, details: state.wizardDetails ?? [] });
            }, RESUME_RUN_DELAY_MS);
            return;
        }
        if (state?.wizard === "login" || state?.wizard === "settings" || state?.wizard === "import"){
            setTimeout(() => this.setUp(), OFFER_DELAY_MS);
            return;
        }
        if (state && state.wizard !== "later") return;
        setTimeout(() => this.offer(), OFFER_DELAY_MS);
    }
}

const autoDetect = new AutoDetect();
kute.autoDetect = autoDetect;
autoDetect.resume();
