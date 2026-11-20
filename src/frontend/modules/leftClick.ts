import { kute, ready } from "../client";

const F20 = 131;
const ALT_SLOT = "cont_shoot1Key_alt";
const PRIMARY_SLOT = "cont_shoot1Key";
const FEATURE = "left-click-f20";

let told: boolean | undefined;

function read(slot: string): number{
    return Number(localStorage.getItem(slot) ?? -1);
}

function altSlotTaken(): boolean{
    const alt = read(ALT_SLOT);
    return alt !== -1 && alt !== F20;
}

export function hostSupports(): boolean{
    return kute.hostFeatures?.includes(FEATURE) === true;
}

export function claimAltShoot(): boolean{
    return !altSlotTaken() || !hostSupports();
}

export function prepareShootBind(): void{
    if (!altSlotTaken()){
        localStorage.setItem(ALT_SLOT, String(F20));
        return;
    }
    ready.then(() => {
        if (!hostSupports()) localStorage.setItem(ALT_SLOT, String(F20));
    });
}

export function syncLeftClick(): void{
    if (!hostSupports()) return;
    const f20 = read(ALT_SLOT) === F20 || read(PRIMARY_SLOT) === F20;
    if (f20 === told) return;
    told = f20;
    window.chrome.webview.postMessage(`left-click-f20, ${f20}`);
}
