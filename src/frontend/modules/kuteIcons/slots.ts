export interface HidingSetting {
    id: string;
    name: string;
    kind: "checkbox"|"opacity";
}

export interface IconSlot {
    id: string;
    file: string;
    name: string;
    settings: string[];
    keys?: string[];
    lists?: string[];
    element?: string;
    hiddenBy: HidingSetting[];
}

const SHOW_UI: HidingSetting = { id: "showUI", name: "Show UI", kind: "checkbox" };

export const SLOTS: IconSlot[] = [
    {
        id: "kills",
        file: "kills.png",
        name: "Kill counter",
        settings: ["customKills"],
        element: "killsIcon",
        hiddenBy: [SHOW_UI, { id: "showKillC", name: "Show Kill Counter", kind: "checkbox" }],
    },
    {
        id: "deaths",
        file: "deaths.png",
        name: "Death counter",
        settings: ["customDeaths"],
        element: "deathsIcon",
        hiddenBy: [SHOW_UI, { id: "showDeaths", name: "Show Death Counter", kind: "checkbox" }],
    },
    {
        id: "streak",
        file: "streak.png",
        name: "Streak counter",
        settings: ["customStreak"],
        element: "streakIcon",
        hiddenBy: [SHOW_UI, { id: "showStreak", name: "Show Streak Counter", kind: "checkbox" }],
    },
    {
        id: "kdr",
        file: "kdr.png",
        name: "K/D counter",
        settings: [],
        element: "kdIcon",
        hiddenBy: [SHOW_UI, { id: "showKD", name: "Show K/D Counter", kind: "checkbox" }],
    },
    { id: "ammo", file: "ammo.png", name: "Ammo", settings: ["customAmmo"], element: "ammoIcon", hiddenBy: [SHOW_UI] },
    {
        id: "hitmarker",
        file: "hitmarker.png",
        name: "Hitmarker",
        settings: ["customHitmarker"],
        hiddenBy: [
            { id: "hitm", name: "Hitmarker: Show", kind: "checkbox" },
            { id: "hitOpac", name: "Hitmarker: Opacity", kind: "opacity" },
        ],
    },
    { id: "reticle", file: "reticle.png", name: "Reticle", settings: [], keys: ["savedReticle"], lists: ["krk_custRet"], element: "aimDot", hiddenBy: [] },
    {
        id: "scope",
        file: "scope.png",
        name: "Scope",
        settings: [],
        keys: ["savedScope"],
        lists: ["krk_custScps"],
        element: "recticleImg",
        hiddenBy: [{ id: "scopeOpac", name: "Scope Opacity", kind: "opacity" }],
    },
];

const LIST_LIMIT = 30;

function stored(key: string): string | null{
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}

function listEntries(key: string): string[]{
    try {
        const entries: unknown = JSON.parse(stored(key) ?? "[]");
        if (!Array.isArray(entries)) return [];
        return entries.map((entry) => (Array.isArray(entry) ? entry[1] : null)).filter((url) => typeof url === "string").slice(0, LIST_LIMIT);
    }
    catch {
        return [];
    }
}

let posted = "";

export function postUrls(): void{
    const urls: Record<string, string[]> = {};
    for (const slot of SLOTS){
        const list: string[] = [];
        for (const setting of slot.settings) list.push(stored(`kro_setngss_${setting}`) ?? "");
        for (const key of slot.keys ?? []) list.push(stored(key) ?? "");
        for (const key of slot.lists ?? []) list.push(...listEntries(key));
        const element = slot.element ? document.getElementById(slot.element) : null;
        if (element instanceof HTMLImageElement) list.push(element.src);
        const theirs = [...new Set(list)].filter((url) => url.startsWith("http"));
        if (theirs.length > 0) urls[slot.id] = theirs;
    }
    const json = JSON.stringify(urls);
    if (json === posted) return;
    posted = json;
    window.chrome.webview.postMessage(`icon-urls ${json}`);
}
