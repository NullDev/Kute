import { kute } from "../client.js";

// scoreboardName.js shipped with 1.1.0 (bundle 0.1.88), seeded off into every scripts folder, and turned out to be
// against krunker's tos. the manager's own commands take it out again: off, then recycle bin. only the shipped copy
// by its header, a script of the player's own under that name stays
const WITHDRAWN = [{ key: "scoreboardName.js", name: "Scoreboard Name", author: "Kute" }];
const DONE_KEY = "kute_withdrawn";
// an exe without the manager commands never answers
const REPLY_MS = 10000;

/** @typedef {import("./managers/userscripts.js").ListedScript} ListedScript */

const done = localStorage.getItem(DONE_KEY) ?? "";
const pending = WITHDRAWN.filter((script) => !done.split(",").includes(script.key));

if (pending.length > 0){
    let timeout = 0;
    /** @type {(event: { data: any }) => void} */
    const listener = (event) => {
        const groups = event.data?.userscripts?.groups;
        if (!Array.isArray(groups)) return;
        window.chrome.webview.removeEventListener("message", listener);
        clearTimeout(timeout);
        const listed = /** @type {ListedScript[]} */ (groups.flatMap((group) => group.scripts ?? []));
        const removed = [];
        for (const script of pending){
            const match = listed.find((entry) => entry.key === script.key && entry.meta?.name === script.name && entry.meta?.author === script.author);
            if (!match) continue;
            window.chrome.webview.postMessage(`scripts-toggle ${JSON.stringify({ key: script.key, enabled: false })}`);
            window.chrome.webview.postMessage(`scripts-delete ${JSON.stringify({ key: script.key })}`);
            removed.push(script.name);
        }
        localStorage.setItem(DONE_KEY, [...done.split(",").filter(Boolean), ...pending.map((script) => script.key)].join(","));
        if (removed.length > 0) kute.showNotification(`${removed.join(", ")} was removed from your userscripts, it is against Krunker's terms of service`, false, 8);
    };
    timeout = setTimeout(() => window.chrome.webview.removeEventListener("message", listener), REPLY_MS);
    window.chrome.webview.addEventListener("message", listener);
    window.chrome.webview.postMessage("scripts-list {}");
}
