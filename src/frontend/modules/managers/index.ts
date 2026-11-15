import { kute } from "../../client";
import { registry, canLoadLive, loadScripts } from "./registry";
import { reloadStylesheets } from "./stylesheets";

kute.userscriptManager = {
    open: (): void => {
        import("./userscripts").then((module) => module.open()).catch((error) => console.error("[kute] userscript manager:", error));
    },
};
kute.settings.toggleUserscripts = (on: boolean): void => {
    kute.settings.data.userscripts = on;
    if (!on){
        const kept = (registry?.entries ?? [])
            .filter((entry) => (entry.state === "running" || entry.state === "waiting") && !entry.stop())
            .map((entry) => entry.meta.name || entry.key);
        if (kept.length) kute.showNotification(`${kept.join(", ")} cannot be stopped and keeps running until the next refresh.`, false, 6);
    }
    else if (canLoadLive()) loadScripts(null, false, true);
    else if (!kute.userscriptManager.masterChanged) kute.showNotification("Refresh the page to start your userscripts.", false, 5);
    kute.userscriptManager.masterChanged?.(on);
};
window.chrome.webview.addEventListener("message", (event: { data: any }) => {
    const css = event.data?.swapperChanged?.css;
    if (Array.isArray(css) && css.length) reloadStylesheets(new Set(css.map(String)));
});
kute.swapperManager = {
    open: (): void => {
        import("./swapper").then((module) => module.open()).catch((error) => console.error("[kute] swapper manager:", error));
    },
};
kute.customCss = {
    open: (): void => {
        import("./customCss").then((module) => module.open()).catch((error) => console.error("[kute] custom css:", error));
    },
};
