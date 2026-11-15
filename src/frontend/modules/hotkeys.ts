import html from "../components/hotkeys.html";
import { kute } from "../client";
import { hiddenByPerformance } from "../performance";

const HOST_FEATURE = "hotkeys";
const F20 = 131;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

interface Binding {
    key: number;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    name: string;
}

interface HotkeyAction {
    id: string;
    label: string;
    note?: string;
    group: "window"|"toggle"|"account";
    fallback: Binding|null;
    setting?: string;
    run?: () => void;
}

function openChatLogs(): void{
    if (kute.settings.data.chatLogs === false || !kute.chatLogs){
        kute.showNotification("Chat Logs is off in the settings", false, 3);
        return;
    }
    kute.chatLogs.toggle();
}

function quickLogin(index: number): void{
    if (kute.settings.data.accountManager === false || !kute.accounts){
        kute.showNotification("Account Manager is off in the settings", false, 3);
        return;
    }
    kute.accounts.loginSlot(index);
}

const plain = (key: number, name: string): Binding => ({ key, ctrl: false, alt: false, shift: false, name });

const accountSlot = (slot: number): HotkeyAction => ({
    id: `account${slot}`,
    label: `Account ${slot}`,
    note: `logs in account ${slot} of the Accounts list`,
    group: "account",
    fallback: { key: 48 + slot, ctrl: true, alt: true, shift: false, name: `Ctrl+Alt+${slot}` },
    run: () => quickLogin(slot - 1),
});

const ACTIONS: HotkeyAction[] = [
    { id: "newLobby", label: "New lobby", group: "window", fallback: plain(115, "F4") },
    { id: "matchmaker", label: "Matchmaker", note: "new lobby while the Matchmaker setting is off", group: "window", fallback: plain(117, "F6") },
    { id: "reload", label: "Reload", group: "window", fallback: plain(116, "F5") },
    { id: "fullscreen", label: "Fullscreen", group: "window", fallback: plain(122, "F11") },
    { id: "devtools", label: "Developer tools", group: "window", fallback: plain(123, "F12") },
    { id: "toggleSpotify", label: "Spotify overlay", note: "on and off", group: "toggle", fallback: null, setting: "spotifyOverlay" },
    { id: "toggleKeystrokes", label: "Keystrokes", note: "on and off", group: "toggle", fallback: null, setting: "keystrokes" },
    { id: "chatLogs", label: "Chat logs", note: "open and close", group: "toggle", fallback: plain(112, "F1"), run: openChatLogs },
    accountSlot(1),
    accountSlot(2),
    accountSlot(3),
];

const KRUNKER_BINDS: [string, string, number, number][] = [
    ["0", "Forward", 87, -1], ["1", "Back", 83, -1], ["2", "Left", 65, -1], ["3", "Right", 68, -1],
    ["jumpKey", "Jump", 32, -1], ["crouchKey", "Crouch", 16, -1], ["reloadKey", "Reload", 82, -1],
    ["swapKey", "Swap weapon", 69, -1], ["primKey", "Primary weapon", 84, -1], ["meleeKey", "Melee", 81, -1],
    ["equipKey", "Equip", 67, -1], ["dropKey", "Drop", 90, -1], ["inspKey", "Inspect", 88, -1],
    ["wepVisKey", "Hide weapon", -1, -1], ["sprayKey", "Spray", 70, -1], ["sprayWheelKey", "Spray wheel", 70, -1],
    ["interactKey", "Interact", 71, -1], ["interactSecKey", "Second interact", 72, -1], ["confirmKey", "Confirm", 75, -1],
    ["resetKey", "Reset", 66, -1], ["resetLastKey", "Reset to last", 78, -1], ["markPositionKey", "Mark position", 10002, -1],
    ["chatKey", "Chat", 13, -1], ["voiceKey", "Voice chat", 86, -1], ["pListKey", "Player list", 18, -1],
    ["sBoardKey", "Scoreboard", 9, -1], ["hidePlayersKey", "Hide players", -1, -1],
    ["kickVoteYKey", "Kick vote yes", 49, -1], ["kickVoteNKey", "Kick vote no", 50, -1],
    ["kpdVoteYKey", "Vote yes", 89, -1], ["kpdVoteNKey", "Vote no", 78, -1], ["kpdVisionKey", "Vision", 187, -1],
    ["specFreeKey", "Spectate free camera", 70, -1], ["specObjKey", "Spectate objective", 72, -1],
    ["specFirstKey", "Spectate first person", 82, -1], ["specNamesKey", "Spectate names", 77, -1],
    ["specMiniMap", "Spectate minimap", 189, -1], ["specFocusKey", "Spectate focus", 190, -1],
    ["propKey", "Prop", 80, -1], ["propRandKey", "Random prop", 77, -1], ["propRotKey", "Rotate prop", 82, -1],
    ["propRotRKey", "Rotate prop back", 78, -1],
    ["18", "Streak 1", 49, -1], ["19", "Streak 2", 50, -1], ["20", "Streak 3", 51, -1],
    ...[0, 1, 2, 3, 4, 5].map((n) => ([`taunt${n}`, `Taunt ${n + 1}`, 49 + n, -1] as [string, string, number, number])),
    ...["27", "28", "29", "30", "31", "32"].map((id, n) => ([id, `Toggle ${n + 1}`, -1, -1] as [string, string, number, number])),
    ...["43", "44", "45", "46", "47", "48"].map((id, n) => ([id, `Chat message ${n + 1}`, -1, -1] as [string, string, number, number])),
];

function hostSupports(): boolean{
    return Boolean(kute.hostFeatures?.includes(HOST_FEATURE));
}

export function bindings(): Record<string, Binding | null>{
    const stored: Record<string, Binding | null | undefined> = (hostSupports() && kute.settings.data.hotkeys) || {};
    return Object.fromEntries(ACTIONS.map((action) => [action.id, stored[action.id] ?? (action.id in stored ? null : action.fallback)]));
}

function same(event: KeyboardEvent, binding: Binding | null): boolean{
    return Boolean(binding) && event.keyCode === binding?.key && event.ctrlKey === binding.ctrl && event.altKey === binding.alt && event.shiftKey === binding.shift;
}

export function matches(event: KeyboardEvent, id: string): boolean{
    return same(event, bindings()[id] ?? null);
}

function krunkerUses(key: number): string[]{
    const read = (slot: string, fallback: number): number => {
        try {
            const value = window.localStorage.getItem(slot);
            return value === null ? fallback : Number(value);
        }
        catch {
            return fallback;
        }
    };
    return KRUNKER_BINDS.filter(([id, , primary, alt]) => read(`cont_${id}`, primary) === key || read(`cont_${id}_alt`, alt) === key).map(([, label]) => label);
}

const KEY_NAMES: Record<number, string> = {
    8: "Backspace", 9: "Tab", 13: "Enter", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End", 36: "Home",
    37: "Left", 38: "Up", 39: "Right", 40: "Down", 45: "Insert", 46: "Delete",
};

function codeName(keyCode: number): string{
    if ((keyCode >= 48 && keyCode <= 57) || (keyCode >= 65 && keyCode <= 90)) return String.fromCharCode(keyCode);
    if (keyCode >= 96 && keyCode <= 105) return `Num ${keyCode - 96}`;
    if (keyCode >= 112 && keyCode <= 135) return `F${keyCode - 111}`;
    return KEY_NAMES[keyCode] ?? `Key ${keyCode}`;
}

function keyName(event: KeyboardEvent): string{
    const { code } = event;
    let name = code;
    if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
    else if (/^Digit\d$/.test(code)) name = code.slice(5);
    else if (code.startsWith("Numpad")) name = `Num ${code.slice(6)}`;
    else if (code.startsWith("Arrow")) name = code.slice(5);
    else if (!code) name = codeName(event.keyCode);
    return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", name].filter(Boolean).join("+");
}

function clashes(action: HotkeyAction, binding: Binding, current: Record<string, Binding | null>): string[]{
    const warnings: string[] = [];
    const also = ACTIONS.filter((other) => {
        const theirs = current[other.id];
        return other.id !== action.id && theirs !== null && theirs.key === binding.key && theirs.ctrl === binding.ctrl && theirs.alt === binding.alt && theirs.shift === binding.shift;
    });
    if (also.length > 0) warnings.push(`Also bound to Kute's ${also.map((other) => other.label).join(", ")}, pick another key.`);
    const krunker = krunkerUses(binding.key);
    if (krunker.length > 0){
        const more = krunker.length > 3 ? ` and ${krunker.length - 3} more` : "";
        warnings.push(`Krunker uses this key for ${krunker.slice(0, 3).join(", ")}${more}, the game still gets it.`);
    }
    return warnings;
}

function typing(): boolean{
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

class HotkeyMenu {
    owner: Hotkeys;
    waiting: string | null;
    overlay: HTMLDivElement;
    shadow: ShadowRoot;

    constructor(owner: Hotkeys){
        this.owner = owner;
        this.waiting = null;
        this.overlay = document.createElement("div");
        this.overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        this.overlay.append(host);
        this.shadow = host.attachShadow({ mode: "open" });
        this.shadow.innerHTML = html;
        document.body.append(this.overlay);

        this.onKey = this.onKey.bind(this);
        window.addEventListener("keydown", this.onKey, true);
        this.overlay.addEventListener("click", (event) => {
            if (event.target === this.overlay) this.close();
        });
        this.element("hkDone").onclick = (): void => this.close();
        this.element("hkReset").onclick = (): void => {
            this.owner.save({});
            this.stopWaiting();
            this.render();
        };
        this.render();
    }

    element(id: string): HTMLElement{
        return this.shadow.querySelector(`#${id}`) as HTMLElement;
    }

    startWaiting(id: string): void{
        this.stopWaiting();
        this.waiting = id;
        this.owner.capturing = true;
        window.chrome.webview.postMessage("hotkeys-pause, true");
        this.render();
    }

    stopWaiting(): void{
        if (this.waiting === null) return;
        this.waiting = null;
        this.owner.capturing = false;
        window.chrome.webview.postMessage("hotkeys-pause, false");
        this.render();
    }

    assign(id: string, binding: Binding | null): void{
        this.owner.save({ ...bindings(), [id]: binding });
        this.stopWaiting();
        this.render();
    }

    row(action: HotkeyAction, current: Record<string, Binding | null>): HTMLElement{
        const binding = current[action.id];
        const row = document.createElement("div");
        row.className = "hkRow";

        const label = document.createElement("div");
        label.className = "hkLabel";
        label.textContent = action.label;
        if (action.note){
            const note = document.createElement("span");
            note.className = "hkNote";
            note.textContent = action.note;
            label.append(note);
        }

        const waiting = this.waiting === action.id;
        const key = document.createElement("div");
        key.className = `hkKey${waiting ? " hkWaiting" : ""}${binding ? "" : " hkNone"}`;
        key.textContent = waiting ? "Press a key" : binding?.name ?? "No key";
        key.title = "Click, then press the new key. Escape cancels";
        key.onclick = (): void => this.startWaiting(action.id);

        const clear = document.createElement("div");
        clear.className = "hkClear";
        clear.textContent = "Clear";
        clear.style.visibility = binding ? "" : "hidden";
        clear.onclick = (): void => this.assign(action.id, null);
        row.append(label, key, clear);

        const warnings = binding ? clashes(action, binding, current) : [];
        if (warnings.length === 0) return row;
        const warning = document.createElement("div");
        warning.className = "hkWarn";
        warning.textContent = warnings.join(" ");
        const wrap = document.createElement("div");
        wrap.append(row, warning);
        return wrap;
    }

    render(): void{
        const current = bindings();
        for (const group of ["window", "toggle", "account"]){
            const rows = ACTIONS.filter((action) => action.group === group).map((action) => this.row(action, current));
            this.element(`hkGroup-${group}`).replaceChildren(...rows);
        }
    }

    onKey(event: KeyboardEvent): void{
        if (this.waiting === null){
            if (event.key === "Escape") this.close();
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape"){
            this.stopWaiting();
            return;
        }
        if (MODIFIER_KEYS.has(event.key) || event.keyCode === F20 || event.keyCode === 0) return;
        this.assign(this.waiting, { key: event.keyCode, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, name: keyName(event) });
    }

    close(): void{
        this.stopWaiting();
        window.removeEventListener("keydown", this.onKey, true);
        this.overlay.remove();
    }
}

class Hotkeys {
    capturing = false;

    constructor(){
        kute.hotkeys = { edit: (): void => this.edit() };
        window.addEventListener("keydown", (event) => this.onKey(event), true);
    }

    onKey(event: KeyboardEvent): void{
        if (this.capturing || event.repeat || typing() || !hostSupports()) return;
        const current = bindings();
        for (const action of ACTIONS){
            if (action.group === "window" || !same(event, current[action.id])) continue;
            if (action.run) action.run();
            else if (action.setting) this.flip(action.setting, action.label);
        }
    }

    flip(setting: string, label: string): void{
        if (hiddenByPerformance(kute.settings.data, setting)){
            kute.showNotification(`${label} is off in performance mode`, false, 3);
            return;
        }
        const on = !kute.settings.data[setting];
        kute.settings.changeSetting(setting, on, false);
        kute.showNotification(`${label} ${on ? "on" : "off"}`, false, 2);
    }

    save(next: Record<string, Binding | null>): void{
        kute.settings.data.hotkeys = next;
        window.chrome.webview.postMessage(`set-config-json hotkeys ${JSON.stringify(next)}`);
    }

    edit(): void{
        if (!hostSupports()){
            kute.showNotification("Hotkeys need a newer Kute", false, 3);
            return;
        }
        // eslint-disable-next-line no-new
        new HotkeyMenu(this);
    }
}

export default new Hotkeys();
