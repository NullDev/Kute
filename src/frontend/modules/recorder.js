import { kute } from "../client.js";

/**
 * Testing builds only. Keeps the last frames of the page, Chromium's long animation frames and how long mouse and key
 * input waited before the page got it. F9 hands them to the
 * host (modules/recorder.rs), which adds the lobby socket traffic and the hook's presents and writes
 * Documents\kute\captures\<time>\ (summary.txt to read, capture.json for the details).
 */

// a power of two, about 30 s at 2000 fps
const FRAME_RING = 1 << 16;
const WINDOW_MS = 30000;
const MAX_LONG_FRAMES = 300;
const MAX_EVENTS = 200;
const LISTED_HITCHES = 25;
// mouse events while locked, about one per frame
const INPUT_RING = 1 << 16;
const MAX_KEYS = 500;
const LISTED_DELAYS = 15;

/**
 * @typedef {object} LongFrameScript
 * @property {string} invoker
 * @property {string} source
 * @property {string} functionName
 * @property {number} duration
 * @property {number} forcedStyleAndLayout
 *
 * @typedef {object} LongFrame
 * @property {number} start
 * @property {number} duration
 * @property {number} blocking
 * @property {number} renderStart
 * @property {number} styleAndLayoutStart
 * @property {LongFrameScript[]} scripts
 */

/**
 * @param {number[]} sorted
 * @param {number} share
 * @return {number}
 */
function percentile(sorted, share){
    if (sorted.length === 0) return 0;
    return sorted[Math.round((sorted.length - 1) * share)];
}

/**
 * @param {number} ms
 * @return {number}
 */
const round = (ms) => Math.round(ms * 1000) / 1000;

class Recorder {
    constructor(){
        this.frames = new Float64Array(FRAME_RING);
        this.count = 0;
        /** @type {LongFrame[]} */
        this.longFrames = [];
        /** @type {[number, string][]} */
        this.events = [];
        this.busy = false;
        // per mouse event: when the page got it, the timestamp of the oldest raw packet in it, how many packets
        this.inputAt = new Float64Array(INPUT_RING);
        this.inputOldest = new Float64Array(INPUT_RING);
        this.inputPackets = new Uint16Array(INPUT_RING);
        this.inputCount = 0;
        /** @type {[number, number][]} when, wait */
        this.keys = [];

        // its own loop, the game's rAF wrapper stays as it is. runs in the same frames as the game's callback
        /** @param {number} timestamp */
        const tick = (timestamp) => {
            this.frames[this.count++ & (FRAME_RING - 1)] = timestamp;
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);

        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) this.longFrame(/** @type {any} */ (entry));
            }).observe({ type: "long-animation-frame", buffered: true });
        }
        catch {
            // an engine without the entry type only loses the script attribution
        }

        /** @param {string} text */
        const note = (text) => {
            this.events.push([performance.now(), text]);
            if (this.events.length > MAX_EVENTS) this.events.shift();
        };
        document.addEventListener("pointerlockchange", () => note(document.pointerLockElement ? "pointer locked" : "pointer released"));
        document.addEventListener("visibilitychange", () => note(`page ${document.visibilityState}`));
        window.addEventListener("blur", () => note("window lost focus"));
        window.addEventListener("focus", () => note("window got focus"));
        window.addEventListener("resize", () => note(`resized to ${window.innerWidth}x${window.innerHeight}`));

        // chromium hands the page all raw packets since the last event at once, the oldest one waited the longest
        // pointermove, a plain mousemove has no getCoalescedEvents
        window.addEventListener("pointermove", (event) => {
            if (document.pointerLockElement === null) return;
            const packets = event.getCoalescedEvents();
            const index = this.inputCount++ & (INPUT_RING - 1);
            this.inputAt[index] = performance.now();
            this.inputOldest[index] = packets.length ? packets[0].timeStamp : event.timeStamp;
            this.inputPackets[index] = Math.min(packets.length || 1, 65535);
        }, { capture: true, passive: true });

        window.addEventListener("keydown", (event) => {
            if (!event.repeat){
                this.keys.push([performance.now(), performance.now() - event.timeStamp]);
                if (this.keys.length > MAX_KEYS) this.keys.shift();
            }
            if (event.key !== "F9" || event.repeat) return;
            this.capture();
        }, true);
        window.chrome.webview.addEventListener("message", (event) => {
            const { data } = event;
            if (typeof data?.captureSaved === "string"){
                this.busy = false;
                kute.showNotification(`Capture saved: ${data.captureSaved}`, false, 6);
            }
            else if (typeof data?.captureFailed === "string"){
                this.busy = false;
                kute.showNotification(`Capture failed: ${data.captureFailed}`, false, 6);
            }
        });
    }

    /** @param {any} entry PerformanceLongAnimationFrameTiming */
    longFrame(entry){
        this.longFrames.push({
            start: round(entry.startTime),
            duration: round(entry.duration),
            blocking: round(entry.blockingDuration ?? 0),
            renderStart: round(entry.renderStart ?? 0),
            styleAndLayoutStart: round(entry.styleAndLayoutStart ?? 0),
            scripts: (entry.scripts ?? []).slice(0, 6).map((/** @type {any} */ script) => ({
                invoker: String(script.invoker ?? "").slice(0, 120),
                source: (String(script.sourceURL ?? "").split("/").pop() ?? "").slice(0, 80),
                functionName: String(script.sourceFunctionName ?? "").slice(0, 80),
                duration: round(script.duration),
                forcedStyleAndLayout: round(script.forcedStyleAndLayoutDuration ?? 0),
            })),
        });
        if (this.longFrames.length > MAX_LONG_FRAMES) this.longFrames.shift();
    }

    capture(){
        if (this.busy) return;
        this.busy = true;
        kute.showNotification("Saving a capture of the last 30 seconds", false, 3);

        const now = performance.now();
        const newest = this.count - 1;
        const oldest = Math.max(0, this.count - FRAME_RING);
        /** @type {number[]} */
        const stamps = [];
        for (let index = newest; index >= oldest; index--){
            const stamp = this.frames[index & (FRAME_RING - 1)];
            if (now - stamp > WINDOW_MS) break;
            stamps.push(stamp);
        }
        stamps.reverse();
        const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
        const sorted = [...intervals].sort((a, b) => a - b);
        const median = percentile(sorted, 0.5);
        const span = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;

        // a hitch is a frame far over the usual one, at any frame rate
        const limit = Math.max(median * 4, 6);
        const hitches = intervals
            .map((ms, index) => ({ ms, at: stamps[index + 1] }))
            .filter((frame) => frame.ms > limit)
            .sort((a, b) => b.ms - a.ms)
            .slice(0, LISTED_HITCHES)
            .sort((a, b) => a.at - b.at);

        const activity = (() => {
            try {
                return window.getGameActivity?.() ?? null;
            }
            catch {
                return null;
            }
        })();
        const longFrames = this.longFrames.filter((frame) => now - frame.start <= WINDOW_MS);
        const events = this.events.filter(([at]) => now - at <= WINDOW_MS);
        /** @param {number} at */
        const ago = (at) => `${((now - at) / 1000).toFixed(2).padStart(7)} s before F9`;

        /** @type {{at: number, wait: number, packets: number}[]} */
        const input = [];
        for (let index = this.inputCount - 1; index >= Math.max(0, this.inputCount - INPUT_RING); index--){
            const slot = index & (INPUT_RING - 1);
            if (now - this.inputAt[slot] > WINDOW_MS) break;
            input.push({ at: this.inputAt[slot], wait: this.inputAt[slot] - this.inputOldest[slot], packets: this.inputPackets[slot] });
        }
        input.reverse();
        const waits = input.map((event) => event.wait).sort((a, b) => a - b);
        const waitMedian = percentile(waits, 0.5);
        const waitLimit = Math.max(8, waitMedian * 4);
        const delayed = input
            .filter((event) => event.wait > waitLimit)
            .sort((a, b) => b.wait - a.wait)
            .slice(0, LISTED_DELAYS)
            .sort((a, b) => a.at - b.at);
        const keys = this.keys.filter(([at]) => now - at <= WINDOW_MS);
        const keyWaits = keys.map(([, wait]) => wait).sort((a, b) => a - b);

        const summary = [
            `Match: ${activity ? `${activity.mode ?? "?"} on ${activity.map ?? "?"} (${activity.id ?? "no game"}${activity.custom ? ", private" : ""})` : "unknown"}`,
            `Page frames: ${intervals.length} in ${(span / 1000).toFixed(1)} s = ${span > 0 ? Math.round(intervals.length / (span / 1000)) : 0} fps`,
            `  frame time: median ${median.toFixed(2)} ms, p99 ${percentile(sorted, 0.99).toFixed(2)} ms, p99.9 ${percentile(sorted, 0.999).toFixed(2)} ms, worst ${percentile(sorted, 1).toFixed(2)} ms`,
            `Hitches (frames over ${limit.toFixed(1)} ms): ${intervals.filter((ms) => ms > limit).length}${hitches.length ? ", the worst:" : ""}`,
            ...hitches.map((frame) => `  ${ago(frame.at)}: ${frame.ms.toFixed(1)} ms`),
            `Long animation frames (over 50 ms, with the scripts that ran): ${longFrames.length}`,
            ...longFrames.slice(-15).map((frame) => `  ${ago(frame.start)}: ${frame.duration.toFixed(0)} ms, ${
                frame.scripts.map((script) => `${script.source || script.invoker} ${script.functionName} ${script.duration.toFixed(0)} ms`).join(" | ") || "no script"
            }`),
            input.length
                ? `Mouse input while locked: ${input.length} events with ${input.reduce((sum, event) => sum + event.packets, 0)} raw packets, oldest packet waited median ${waitMedian.toFixed(2)} ms, p99 ${percentile(waits, 0.99).toFixed(2)} ms, worst ${percentile(waits, 1).toFixed(2)} ms`
                : "Mouse input while locked: none",
            ...(delayed.length ? [`  mouse input that waited over ${waitLimit.toFixed(1)} ms (${input.filter((event) => event.wait > waitLimit).length}x), the worst:`] : []),
            ...delayed.map((event) => `  ${ago(event.at)}: ${event.wait.toFixed(1)} ms, ${event.packets} packets at once`),
            keys.length
                ? `Key presses: ${keys.length}, waited median ${percentile(keyWaits, 0.5).toFixed(2)} ms, worst ${percentile(keyWaits, 1).toFixed(2)} ms`
                : "Key presses: none",
            "Page events:",
            ...(events.length ? events.map(([at, text]) => `  ${ago(at)}: ${text}`) : ["  none"]),
        ];

        const payload = {
            timeOrigin: performance.timeOrigin,
            capturedAt: now,
            window: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
            activity,
            summary,
            frameStart: stamps[0] ?? 0,
            frameIntervals: intervals.map(round),
            longFrames,
            events: events.map(([at, text]) => [round(at), text]),
            input: input.map((event) => [round(event.at), round(event.wait), event.packets]),
            inputFormat: ["page ms", "wait of the oldest packet ms", "packets"],
            keys: keys.map(([at, wait]) => [round(at), round(wait)]),
        };
        window.chrome.webview.postMessage(`perf-capture ${JSON.stringify(payload)}`);
    }
}

export default new Recorder();
