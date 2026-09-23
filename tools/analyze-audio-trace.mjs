// Reads a capture from the audio test build (Downloads\kute-audio-trace-*.json) and says whether the renderer's
// audio callbacks were late or slow. usage: bun tools/analyze-audio-trace.mjs <trace.json>
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path){
    console.log("usage: bun tools/analyze-audio-trace.mjs <trace.json>");
    process.exit(1);
}

const trace = JSON.parse(readFileSync(path, "utf8"));
const events = trace.traceEvents ?? trace;
console.log(`${events.length} events`);

/**
 * @param {number[]} values
 * @return {string}
 */
function spread(values){
    if (!values.length) return "none";
    const sorted = [...values].sort((a, b) => a - b);
    const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    return `n=${sorted.length} mean=${mean.toFixed(2)} p50=${at(0.5).toFixed(2)} p95=${at(0.95).toFixed(2)} p99=${at(0.99).toFixed(2)} max=${sorted.at(-1).toFixed(2)} (ms)`;
}

// what the trace is made of, so an unexpected category shows up instead of being averaged away
const byName = new Map();
for (const event of events){
    byName.set(event.name, (byName.get(event.name) ?? 0) + 1);
}
console.log("\ntop events:");
for (const [name, count] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)){
    console.log(`  ${String(count).padStart(7)}  ${name}`);
}

// the renderer's audio callback: one per output buffer. "dur" is how long the graph took, the distance between
// two starts is how regularly the audio thread ran
const renders = events
    .filter((event) => event.name === "AudioDestination::Render" && (event.ph === "X" || event.ph === "B"))
    .sort((a, b) => a.ts - b.ts);

if (!renders.length){
    console.log("\nno AudioDestination::Render events: the page had no running audio context while this was recorded");
    process.exit(0);
}

const frames = renders[0].args?.frames ?? null;
const durations = renders.filter((event) => typeof event.dur === "number").map((event) => event.dur / 1000);
const gaps = [];
for (let index = 1; index < renders.length; index++){
    gaps.push((renders[index].ts - renders[index - 1].ts) / 1000);
}

const seconds = (renders.at(-1).ts - renders[0].ts) / 1e6;
console.log(`\ncallbacks: ${renders.length} over ${seconds.toFixed(1)} s, ${frames ? `${frames} frames each` : "buffer size unknown"}`);
console.log(`  time in the callback : ${spread(durations)}`);
console.log(`  distance between them: ${spread(gaps)}`);

// a buffer is late when the next callback starts noticeably after the buffer it just played would have ended
const expected = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
const late = gaps.filter((gap) => gap > expected * 1.5).length;
const slow = durations.filter((duration) => duration > expected * 0.9).length;
console.log(`\n  ${late} of ${gaps.length} callbacks started late (more than 1.5x the usual ${expected.toFixed(2)} ms distance)`);
console.log(`  ${slow} of ${durations.length} callbacks took almost the whole buffer (over 90% of ${expected.toFixed(2)} ms)`);
if (!late && !slow) console.log("\n  -> nothing wrong in this capture: every buffer was rendered in time");
else if (slow > late) console.log("\n  -> the audio graph itself is too slow: the work per buffer does not fit");
else console.log("\n  -> the callbacks arrive late: the audio thread is not running when it should");

// the graph itself, once per 128 frame quantum. this is what a panner heavy match makes expensive
const quanta = events.filter((event) => event.name === "RealtimeAudioDestinationHandler::Render" && typeof event.dur === "number");
if (quanta.length){
    console.log(`\n  graph render per quantum: ${spread(quanta.map((event) => event.dur / 1000))}`);
}

// the names chromium uses when audio is actually lost, not the FIFO bookkeeping events
const glitches = events.filter((event) => /glitch|underrun|underflow|timed out|not ready/i.test(event.name));
if (glitches.length){
    console.log(`\n${glitches.length} glitch events, first few:`);
    for (const event of glitches.slice(0, 6)) console.log(`  ${(event.ts / 1e6).toFixed(3)}s ${event.name} ${JSON.stringify(event.args ?? {})}`);
}
