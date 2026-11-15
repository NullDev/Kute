import { FrameRecorder, InputProbe, TaskProbe } from "./metrics";
import type { Reading } from "./policy";

export interface InputDiagnostics {
    readings: number;
    asked: number;
    withInput: number;
    pageEvents: number;
    hostSteps: number;
    ended: Record<string, number>;
    invalid: Record<string, number>;
}

export const REPLAY_CIRCLE_MS = 600;
const MIN_INPUT_EVENTS = 20;

const emptyDiagnostics = (): InputDiagnostics => ({ readings: 0, asked: 0, withInput: 0, pageEvents: 0, hostSteps: 0, ended: {}, invalid: {} });
let diagnostics = emptyDiagnostics();

window.chrome.webview.addEventListener("message", (event) => {
    const result = event.data?.inputReplay;
    if (!result) return;
    diagnostics.hostSteps += Number(result.sent) || 0;
    diagnostics.ended[result.reason] = (diagnostics.ended[result.reason] ?? 0) + 1;
});

export function takeInputDiagnostics(): InputDiagnostics{
    const taken = diagnostics;
    diagnostics = emptyDiagnostics();
    return taken;
}

export function takeReading({ ms, hz, replay }: { ms: number; hz: number; replay: boolean; }): Promise<Reading>{
    return new Promise((resolve, reject) => {
        const frames = new FrameRecorder();
        const tasks = new TaskProbe();
        const input = new InputProbe();
        const focused = (): boolean => document.hasFocus() && document.visibilityState === "visible";
        const lockedAtStart = document.pointerLockElement !== null;
        let invalidWhy: string | null = focused() ? null : "the window was not in front";
        const onFocus = (): void => {
            if (!focused()) invalidWhy ??= "the window lost focus";
        };
        const onLock = (): void => {
            if ((document.pointerLockElement !== null) !== lockedAtStart) invalidWhy ??= lockedAtStart ? "the game let go of the mouse" : "the game took the mouse";
        };
        const unwatch = (): void => {
            window.removeEventListener("blur", onFocus);
            document.removeEventListener("visibilitychange", onFocus);
            document.removeEventListener("pointerlockchange", onLock);
        };
        window.addEventListener("blur", onFocus);
        document.addEventListener("visibilitychange", onFocus);
        document.addEventListener("pointerlockchange", onLock);

        const watchdog = setTimeout(() => {
            unwatch();
            tasks.stop();
            input.stop();
            window.chrome.webview.postMessage("input-replay-stop");
            reject(new Error("the game stopped drawing frames"));
        }, ms + 5000);

        tasks.start();
        input.start();
        diagnostics.readings++;
        if (replay && lockedAtStart){
            diagnostics.asked++;
            window.chrome.webview.postMessage(`input-replay, ${ms}`);
        }
        const start = performance.now();
        const frame = (): void => {
            const now = performance.now();
            frames.frame(now);
            if (now - start < ms){
                requestAnimationFrame(frame);
                return;
            }
            clearTimeout(watchdog);
            unwatch();
            onFocus();
            onLock();
            const task = tasks.stop();
            const pointer = input.stop();
            const stats = frames.stats(1000 / hz);
            diagnostics.pageEvents += pointer.events;
            if (pointer.events >= MIN_INPUT_EVENTS) diagnostics.withInput++;
            if (stats === null) invalidWhy ??= "too few frames";
            if (invalidWhy !== null) diagnostics.invalid[invalidWhy] = (diagnostics.invalid[invalidWhy] ?? 0) + 1;
            resolve({
                fps: stats?.fps ?? null,
                p50: stats?.p50 ?? null,
                p99: stats?.p99 ?? null,
                maxMs: stats?.maxMs ?? null,
                stallMs: stats?.stallMs ?? null,
                taskP99: task.p99,
                inputP99: pointer.events >= MIN_INPUT_EVENTS ? pointer.p99 : null,
                invalid: invalidWhy !== null,
                ...(invalidWhy === null ? {} : { why: invalidWhy }),
            });
        };
        requestAnimationFrame(frame);
    });
}
