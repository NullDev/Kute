import { kute } from "../client";

const SCROLL = "20000";

let active = false;
let scrollBound: boolean | undefined;

export function setRampBoost(enabled: boolean): void{
    active = enabled;
    window.chrome.webview.postMessage(`toggle-rboost, ${enabled}`);
}

export function syncScrollBinds(): void{
    let bound = false;
    try {
        bound = Object.keys(localStorage).some((key) => key.startsWith("cont_") && localStorage.getItem(key) === SCROLL);
    }
    catch {
        return;
    }
    if (bound === scrollBound) return;
    scrollBound = bound;
    if (kute.hostFeatures?.includes("scroll-binds")) window.chrome.webview.postMessage(`wheel-to-page, ${bound}`);
}

window.addEventListener("wheel", (event) => {
    if (!active || !document.pointerLockElement || !kute.hostFeatures?.includes("ramp-boost")) return;
    if (!scrollBound){
        event.stopImmediatePropagation();
        event.preventDefault();
    }
    window.chrome.webview.postMessage(`ramp-wheel, ${(event.deltaY || event.deltaX) < 0 ? 1 : -1}`);
}, { capture: true, passive: false });
