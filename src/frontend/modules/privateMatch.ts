const LOBBY_MAP = "gameMap0";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

export function activity(): Partial<KrunkerGameActivity> & { id?: string }{
    try {
        return window.getGameActivity?.() ?? {};
    }
    catch {
        return {};
    }
}

export function inRoom(room: string | null): boolean{
    const now = activity();
    return Boolean(room) && Boolean(now.custom) && now.id === room;
}

export async function hostLobby(): Promise<string | null>{
    if (typeof window.openHostWindow !== "function" || typeof window.createPrivateRoom !== "function") return null;
    const previousId = activity().id;
    for (let attempt = 0; attempt < 4; attempt++){
        window.openHostWindow(false, 0);
        await sleep(800);
        window.windows[7]?.switchTab?.(0);
        await sleep(300);
        const maps = [...document.querySelectorAll("#windowHolder input[id^=gameMap]")] as HTMLInputElement[];
        const makePrivate = document.querySelector("#makePrivate") as HTMLInputElement | null;
        if (maps.length === 0 || !makePrivate){
            window.closWind?.();
            return null;
        }
        for (const map of maps){
            if (map.checked !== (map.id === LOBBY_MAP)) map.click();
        }
        const tickedByUs = !makePrivate.checked;
        if (tickedByUs) makePrivate.click();
        try {
            window.createPrivateRoom();
            for (let i = 0; i < 32; i++){
                await sleep(250);
                const now = activity();
                if (now.custom && now.id && now.id !== previousId && now.map) return now.id;
            }
        }
        finally {
            if (tickedByUs && makePrivate.checked) makePrivate.click();
        }
        window.closWind?.();
        await sleep(1500);
    }
    return null;
}

export function spawned(): boolean{
    const instructions = document.querySelector("#instructions");
    return Boolean(document.pointerLockElement) || (instructions !== null && getComputedStyle(instructions).display === "none");
}

export async function spawn(room: string | null): Promise<boolean>{
    for (let i = 0; i < 40 && !(activity().map && document.querySelector("#instructions")); i++) await sleep(250);
    await sleep(500);
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    for (let attempt = 0; attempt < 3 && !spawned(); attempt++){
        if (!inRoom(room)) return false;
        window.chrome.webview.postMessage(`click, ${x}, ${y}`);
        await sleep(1200);
    }
    await sleep(800);
    return spawned();
}
