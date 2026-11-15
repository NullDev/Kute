import { kute, ready } from "../client";

const nativeRAF = window.requestAnimationFrame;
const nativeCancelRAF = window.cancelAnimationFrame;

const CHECK_WINDOW_MS = 2000;
const TOLERANCE = 1.15;

let settingsData: Record<string, any> | null = null;

const BURST_EVERY = 256;
const BURST_CALLS = 12;
let rafCalls = 0;
let burstFrames = 0;
let burstFrameTs = -1;
let frameStart = 0;
let frameWorkMs: number[] = [];
const frameRendered = new MessageChannel();
frameRendered.port1.onmessage = (): void => {
    if (frameWorkMs.length < 512) frameWorkMs.push(performance.now() - frameStart);
};

export function takeFrameWorkMs(): number{
    if (frameWorkMs.length < 10) return 0;
    const sorted = frameWorkMs.sort((a, b) => a - b);
    frameWorkMs = [];
    const kept = sorted.slice(0, Math.ceil(sorted.length * 0.9));
    return kept.reduce((sum, ms) => sum + ms, 0) / kept.length;
}

function timed(callback: FrameRequestCallback): FrameRequestCallback{
    return function(timestamp){
        if (timestamp !== burstFrameTs){
            burstFrameTs = timestamp;
            if (burstFrames++ > 0){
                frameStart = performance.now();
                frameRendered.port2.postMessage(0);
            }
        }
        callback(timestamp);
    };
}
ready.then(() => {
    settingsData = kute.settings.data;
});

let nextFrameTime = 0;
let lastFrameTimestamp = -1;
let lastTarget = 0;
let busyWait = false;
let windowStart = -1;
let framesInWindow = 0;
let windowsOverTarget = 0;

function verifyHostLimiter(targetFps: number, timestamp: number): void{
    if (windowStart < 0) windowStart = timestamp;
    framesInWindow++;
    const elapsed = timestamp - windowStart;
    if (elapsed < CHECK_WINDOW_MS) return;

    const fps = framesInWindow / (elapsed / 1000);
    windowsOverTarget = fps > targetFps * TOLERANCE ? windowsOverTarget + 1 : 0;
    if (windowsOverTarget >= 2 && kute.frameLimiter !== "viz") busyWait = true;

    framesInWindow = 0;
    windowStart = timestamp;
}

function recheckHostLimiter(): void{
    if (!busyWait || !settingsData?.hardFlip) return;
    busyWait = false;
    framesInWindow = 0;
    windowsOverTarget = 0;
    windowStart = -1;
}
document.addEventListener("pointerlockchange", recheckHostLimiter);
window.addEventListener("resize", recheckHostLimiter);

function waitForFrameSlot(targetFps: number): void{
    let targetInterval: number;
    if (targetFps > 200) targetInterval = 1000 / (targetFps * 1.0055);
    else targetInterval = 1000 / targetFps;

    while (performance.now() < nextFrameTime);

    const now = performance.now();

    if (now - nextFrameTime > targetInterval){
        nextFrameTime = now + targetInterval;
    }
    else nextFrameTime += targetInterval;
}

let frameEnd: FrameRequestCallback | null = null;
let frameEndId = 0;
let frameTs = -1;
let frameEndTs = -2;
let queueingFrameEnd = false;

function runFrameEnd(timestamp: number): void{
    frameTs = timestamp;
    frameEnd?.(timestamp);
}

function requestFrame(callback: FrameRequestCallback): number{
    // eslint-disable-next-line no-use-before-define -- the two call each other
    if (frameEnd !== null && !queueingFrameEnd) return requestFrameWithEnd(callback);
    const limit = settingsData === null ? 0 : settingsData.gameFpsLimit;

    if (!(limit > 0)){
        lastTarget = 0;
        const slot = ++rafCalls % BURST_EVERY;
        if (slot >= BURST_CALLS) return nativeRAF(callback);
        if (slot === 0) burstFrames = 0;
        return nativeRAF(timed(callback));
    }

    const targetFps = Number(limit);
    return nativeRAF(function(timestamp){
        if (targetFps !== lastTarget){
            lastTarget = targetFps;
            busyWait = false;
            framesInWindow = 0;
            windowsOverTarget = 0;
            windowStart = -1;
        }

        if (timestamp !== lastFrameTimestamp){
            lastFrameTimestamp = timestamp;
            if (busyWait) waitForFrameSlot(targetFps);
            else verifyHostLimiter(targetFps, timestamp);
        }

        callback(timestamp);
    });
}

function requestFrameWithEnd(callback: FrameRequestCallback): number{
    queueingFrameEnd = true;
    const id = requestFrame((timestamp) => {
        frameTs = timestamp;
        callback(timestamp);
    });
    queueingFrameEnd = false;
    if (frameEndTs === frameTs) nativeCancelRAF(frameEndId);
    frameEndTs = frameTs;
    frameEndId = nativeRAF(runFrameEnd);
    return id;
}

export function setFrameEnd(callback: FrameRequestCallback | null): void{
    frameEnd = callback;
    if (callback === null) nativeCancelRAF(frameEndId);
}

window.requestAnimationFrame = requestFrame;
