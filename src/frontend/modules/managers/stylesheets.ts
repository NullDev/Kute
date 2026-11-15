import { kute } from "../../client";

export const hostWatchesSwapper = (): boolean => kute.hostFeatures?.includes("swapper-watch") ?? false;

export const reloadStylesheets = (paths: Set<string>): void => {
    for (const link of document.querySelectorAll("link[rel=\"stylesheet\"]")){
        if (!(link instanceof HTMLLinkElement) || !link.href) continue;
        const url = new URL(link.href);
        if (!/(^|\.)krunker\.io$/.test(url.hostname) || !paths.has(url.pathname.slice(1).toLowerCase())) continue;
        url.searchParams.set("kuteSwap", String(Date.now()));
        const fresh = link.cloneNode() as HTMLLinkElement;
        fresh.href = url.href;
        fresh.addEventListener("load", () => link.remove(), { once: true });
        fresh.addEventListener("error", () => fresh.remove(), { once: true });
        link.after(fresh);
    }
};
