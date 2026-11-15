import { createScene, cpuChecksum, DEFAULT_LOAD } from "./scene";
import { FrameRecorder, TaskProbe, type FrameStats } from "./metrics";

const query = new URLSearchParams(location.search);

function numberParam(key: string, fallback: number): number{
    const value = Number(query.get(key));
    return query.has(key) && Number.isFinite(value) ? value : fallback;
}

const FINISH_GRACE_MS = 400;

const settleMs = numberParam("settle", 700);
const sampleMs = numberParam("ms", 2000);
const refreshMs = 1000 / numberParam("hz", 60);
const step = numberParam("step", 0);
const steps = numberParam("steps", 0);
const caps = (query.get("caps") ?? "").split(".").filter((part) => part !== "").map(Number).filter(Number.isFinite);
const rounds = numberParam("rounds", 1);
const capSettleMs = numberParam("capsettle", 700);
const selfCap = query.get("selfcap") === "1";

const load = {
    draws: numberParam("draws", DEFAULT_LOAD.draws),
    meshSegments: DEFAULT_LOAD.meshSegments,
    overdraw: numberParam("overdraw", DEFAULT_LOAD.overdraw),
    cpuIterations: numberParam("cpu", DEFAULT_LOAD.cpuIterations),
};

function finish(result: object): void{
    window.chrome.webview.postMessage(`bench-finish ${JSON.stringify(result)}`);
}

function run(): void{
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:block";
    document.body.append(canvas);

    const labelLines = steps > 0 ? ["Kute is testing this PC", `client test ${step} of ${steps}`, "this takes a moment, nothing to do for you"] : [];

    const scene = createScene(canvas, load, labelLines);
    scene.resize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    const phases = caps.length > 0 ? Array.from({ length: Math.max(1, rounds) }, () => caps).flat() : [null];
    const samples: { cap: number; stats: FrameStats | null; otherTasks: ReturnType<TaskProbe["stop"]>; }[] = [];
    let phase = 0;
    let phaseStart = performance.now();
    let recorder: FrameRecorder | null = null;
    const tasks = new TaskProbe();
    let cap = numberParam("cap", 0);
    let nextSlot = phaseStart;
    let finishedAt = 0;
    let contextLost = false;
    canvas.addEventListener("webglcontextlost", () => {
        contextLost = true;
    });

    const enterPhase = (now: number): void => {
        phaseStart = now;
        recorder = null;
        const value = phases[phase];
        if (value === null) return;
        cap = selfCap ? value : 0;
        nextSlot = now;
        window.chrome.webview.postMessage(`bench-cap ${value}`);
    };
    enterPhase(phaseStart);

    const frame = (timestamp: number): void => {
        if (cap > 0){
            while (performance.now() < nextSlot);
            nextSlot = Math.max(nextSlot + 1000 / cap, performance.now());
        }
        const now = performance.now();
        if (contextLost || (finishedAt > 0 && scene.lost())){
            if (finishedAt === 0) finish({ ok: false, error: "webgl context lost" });
            scene.destroy();
            return;
        }
        scene.render(timestamp);

        if (finishedAt > 0){
            if (now - finishedAt < FINISH_GRACE_MS) requestAnimationFrame(frame);
            else scene.destroy();
            return;
        }

        const settle = phase === 0 ? settleMs : capSettleMs;
        if (recorder === null && now - phaseStart >= settle){
            recorder = new FrameRecorder();
            if (phase === 0) window.chrome.webview.postMessage("bench-sample-start");
            tasks.start();
        }
        if (recorder !== null){
            recorder.frame(now);
            if (now - phaseStart >= settle + sampleMs){
                samples.push({ cap: phases[phase] ?? cap, stats: recorder.stats(refreshMs), otherTasks: tasks.stop() });
                phase++;
                if (phase < phases.length){
                    enterPhase(now);
                }
                else {
                    finishedAt = now;
                    finish({
                        ok: true,
                        stats: samples[0].stats,
                        otherTasks: samples[0].otherTasks,
                        caps: caps.length > 0 ? samples : undefined,
                        load,
                        width: canvas.width,
                        height: canvas.height,
                        checksum: cpuChecksum(),
                    });
                }
            }
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

function runSafely(): void{
    try {
        run();
    }
    catch (error){
        finish({ ok: false, error: String(error) });
    }
}

if (document.body) runSafely();
else document.addEventListener("DOMContentLoaded", runSafely, { once: true });
