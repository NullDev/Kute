import { kute } from "../../client";

export const registry: Registry | null = (window as any).__kuteUserscripts ?? null;

export const canLoadLive = (): boolean => Boolean(registry && kute.hostFeatures?.includes("userscripts-live"));

export const loadScripts = (keys: string[] | null, replace: boolean, start: boolean): void => {
    window.chrome.webview.postMessage(`scripts-load ${JSON.stringify({ ...(keys ? { keys } : {}), replace, start })}`);
};
