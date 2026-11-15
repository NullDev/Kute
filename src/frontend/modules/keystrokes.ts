import styles from "../components/keystrokes.css";
import markup from "../components/keystrokes.html";
import { kute } from "../client";

const LEFT_CLICK_KEY = 131;
const WHEEL_LIT_MS = 120;
const SPACE = 32;
const RAMP_SPACE_MS = 80;
const MOVE_MIN = 0.02;
const MOVE_SHARE = 0.35;
const MOVE_SMOOTH_MS = 20;
const MOVE_HOLD_MS = 80;
const FAST_RATIO = 3;
const TYPICAL_MS = 3000;
const TYPICAL_START = 3;
const TYPICAL_KEY = "kute_keystrokes_speed";
const FAST_HOLD_MS = 120;

const ACTIONS: [string, string, number][] = [
    ["kuteKeyForward", "0", 87],
    ["kuteKeyBack", "1", 83],
    ["kuteKeyLeft", "2", 65],
    ["kuteKeyRight", "3", 68],
    ["kuteKeyJump", "jumpKey", 32],
    ["kuteKeyCrouch", "crouchKey", 16],
    ["kuteKeyReload", "reloadKey", 82],
    ["kuteKeyMelee", "meleeKey", 81],
    ["kuteKeySwap", "swapKey", 69],
];

const KEY_LABELS: Record<number, string> = {
    8: "BKSP", 9: "TAB", 13: "ENT", 16: "SHIFT", 17: "CTRL", 18: "ALT", 20: "CAPS", 32: "SPACE",
    37: "←", 38: "↑", 39: "→", 40: "↓", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/",
    192: "`", 219: "[", 220: "\\", 221: "]", 222: "'",
};

function keyLabel(code: number): string{
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return String.fromCharCode(code);
    if (code >= 96 && code <= 105) return `N${code - 96}`;
    if (code >= 112 && code <= 123) return `F${code - 111}`;
    return KEY_LABELS[code] ?? "?";
}

function boundKeys(bind: string, fallback: number): number[]{
    const codes: number[] = [];
    const slots: [string, number][] = [[`cont_${bind}_alt`, -1], [`cont_${bind}`, fallback]];
    for (const [key, unset] of slots){
        let value = null;
        try {
            value = window.localStorage.getItem(key);
        }
        catch {
            value = null;
        }
        const code = value === null ? unset : Number(value);
        if (code > 0 && code < 10000) codes.push(code);
    }
    return codes;
}

class Keystrokes {
    widget: HTMLElement | null = null;
    byCode: Map<number, HTMLElement[]> = new Map();
    wheelTimers: Map<string, number> = new Map();
    rampWheelAt = -Infinity;
    spaceDownAt = -Infinity;
    spaceIgnored = false;
    arcs: [HTMLElement, number, number][] = [];
    moveX = 0;
    moveY = 0;
    lastMove = -Infinity;
    moveTimer = 0;
    typical = TYPICAL_START;
    typicalMs = 0;
    fastUntil = [0, 0, 0, 0];
    onKeyDown = (event: KeyboardEvent): void => this.key(event.keyCode, true);
    onKeyUp = (event: KeyboardEvent): void => this.key(event.keyCode, false);
    onMouseDown = (event: MouseEvent): void => this.button(event.button, true);
    onMouseUp = (event: MouseEvent): void => this.button(event.button, false);
    onWheel = (event: WheelEvent): void => this.wheel(event.deltaY < 0);
    onMouseMove = (event: MouseEvent): void => this.move(event);
    onMoveIdle = (): void => {
        this.moveTimer = 0;
        const idle = performance.now() - this.lastMove;
        if (idle < MOVE_HOLD_MS){
            this.moveTimer = window.setTimeout(this.onMoveIdle, MOVE_HOLD_MS - idle);
            return;
        }
        this.moveX = 0;
        this.moveY = 0;
        this.fastUntil.fill(0);
        this.drawMove();
    };
    onHostMessage = (event: MessageEvent): void => {
        const { data } = event;
        if (typeof data?.wheel === "number" && data.wheel !== 0) this.wheel(data.wheel > 0);
        else if (typeof data?.rampWheel === "number" && data.rampWheel !== 0) this.rampWheel(data.rampWheel > 0);
    };
    releaseAll = (): void => {
        for (const lit of this.widget?.querySelectorAll(".on") ?? []) lit.classList.remove("on");
        this.moveX = 0;
        this.moveY = 0;
        this.fastUntil.fill(0);
        this.drawMove();
    };
    onPointerLockChange = (): void => {
        if (document.pointerLockElement){
            this.readBinds();
            return;
        }
        this.releaseAll();
        try {
            window.localStorage.setItem(TYPICAL_KEY, this.typical.toFixed(3));
        }
        catch {}
    };

    constructor(){
        kute.settings.toggleKeystrokes = (enabled): void => this.toggle(enabled);
        this.toggle(!!kute.settings.data.keystrokes);
    }

    toggle(enabled: boolean): void{
        queueMicrotask(() => kute.hudEditor?.apply());
        if (!enabled){
            this.remove();
            return;
        }
        if (this.widget) return;
        const style = document.createElement("style");
        style.id = "kuteKeystrokesCSS";
        style.textContent = styles;
        document.head.append(style);

        this.widget = document.createElement("div");
        this.widget.id = "kuteKeystrokes";
        this.widget.innerHTML = markup;
        (document.querySelector("#uiBase") ?? document.body).append(this.widget);
        this.readBinds();
        this.loadTypical();
        const { widget } = this;
        const directions: [string, number, number][] = [["kuteMoveLeft", -1, 0], ["kuteMoveRight", 1, 0], ["kuteMoveUp", 0, -1], ["kuteMoveDown", 0, 1]];
        this.arcs = directions.map(([id, x, y]) => [widget.querySelector(`#${id}`) as HTMLElement, x, y]);

        window.addEventListener("keydown", this.onKeyDown, true);
        window.addEventListener("keyup", this.onKeyUp, true);
        window.addEventListener("mousedown", this.onMouseDown, true);
        window.addEventListener("mouseup", this.onMouseUp, true);
        window.addEventListener("mousemove", this.onMouseMove, { capture: true, passive: true });
        window.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
        window.addEventListener("blur", this.releaseAll);
        document.addEventListener("pointerlockchange", this.onPointerLockChange);
        window.chrome.webview.addEventListener("message", this.onHostMessage);
    }

    remove(): void{
        window.removeEventListener("keydown", this.onKeyDown, true);
        window.removeEventListener("keyup", this.onKeyUp, true);
        window.removeEventListener("mousedown", this.onMouseDown, true);
        window.removeEventListener("mouseup", this.onMouseUp, true);
        window.removeEventListener("mousemove", this.onMouseMove, true);
        window.removeEventListener("wheel", this.onWheel, true);
        window.removeEventListener("blur", this.releaseAll);
        document.removeEventListener("pointerlockchange", this.onPointerLockChange);
        window.chrome.webview.removeEventListener("message", this.onHostMessage);
        for (const timer of this.wheelTimers.values()) clearTimeout(timer);
        this.wheelTimers.clear();
        clearTimeout(this.moveTimer);
        this.moveTimer = 0;
        this.arcs = [];
        this.widget?.remove();
        this.widget = null;
        this.byCode.clear();
        document.querySelector("#kuteKeystrokesCSS")?.remove();
    }

    readBinds(): void{
        if (!this.widget) return;
        this.byCode.clear();
        for (const [id, bind, fallback] of ACTIONS){
            const element = this.widget.querySelector(`#${id}`) as HTMLElement|null;
            if (!element) continue;
            const codes = boundKeys(bind, fallback);
            element.textContent = codes.length > 0 ? keyLabel(codes[0]) : "";
            element.title = codes.map(keyLabel).join(" / ");
            for (const code of codes){
                const list = this.byCode.get(code) ?? [];
                list.push(element);
                this.byCode.set(code, list);
            }
        }
    }

    key(code: number, down: boolean): void{
        if (code === LEFT_CLICK_KEY){
            this.button(0, down);
            return;
        }
        if (code === SPACE){
            if (down){
                this.spaceDownAt = performance.now();
                this.spaceIgnored = this.spaceDownAt - this.rampWheelAt < RAMP_SPACE_MS;
            }
            const ignored = this.spaceIgnored;
            if (!down) this.spaceIgnored = false;
            if (ignored) return;
        }
        const elements = this.byCode.get(code);
        if (!elements) return;
        for (const element of elements) element.classList.toggle("on", down);
    }

    button(button: number, down: boolean): void{
        const id = { 0: "kuteMouseLeft", 1: "kuteWheel", 2: "kuteMouseRight" }[button];
        if (id) this.widget?.querySelector(`#${id}`)?.classList.toggle("on", down);
    }

    move(event: MouseEvent): void{
        if (document.pointerLockElement === null || this.arcs.length === 0) return;
        const now = event.timeStamp;
        const paused = now - this.lastMove >= 100;
        const elapsed = Math.min(now - this.lastMove, 100);
        this.lastMove = now;
        if (!(elapsed > 0)) return;
        const keep = Math.exp(-elapsed / MOVE_SMOOTH_MS);
        this.moveX = this.moveX * keep + (event.movementX / elapsed) * (1 - keep);
        this.moveY = this.moveY * keep + (event.movementY / elapsed) * (1 - keep);
        const speed = Math.hypot(this.moveX, this.moveY);
        if (!paused && speed > MOVE_MIN){
            this.typicalMs = Math.min(this.typicalMs + elapsed, TYPICAL_MS);
            this.typical += (Math.min(speed, this.typical * FAST_RATIO) - this.typical) * (elapsed / this.typicalMs);
        }
        this.drawMove(now);
        if (!this.moveTimer) this.moveTimer = window.setTimeout(this.onMoveIdle, MOVE_HOLD_MS);
    }

    loadTypical(): void{
        let stored = NaN;
        try {
            stored = Number(window.localStorage.getItem(TYPICAL_KEY));
        }
        catch {
            stored = NaN;
        }
        if (stored > 0){
            this.typical = stored;
            this.typicalMs = TYPICAL_MS;
        }
    }

    drawMove(now: number = performance.now()): void{
        const total = Math.hypot(this.moveX, this.moveY);
        const fast = Math.max(this.typical, MOVE_MIN) * FAST_RATIO;
        this.arcs.forEach(([arc, x, y], index) => {
            const speed = this.moveX * x + this.moveY * y;
            if (speed > fast) this.fastUntil[index] = now + FAST_HOLD_MS;
            let name = "kuteMove";
            if (this.fastUntil[index] > now) name = "kuteMove on fast";
            else if (total > MOVE_MIN && speed >= total * MOVE_SHARE) name = "kuteMove on";
            if (arc.className !== name) arc.className = name;
        });
    }

    rampWheel(up: boolean): void{
        this.rampWheelAt = performance.now();
        if (this.rampWheelAt - this.spaceDownAt < RAMP_SPACE_MS){
            this.spaceIgnored = true;
            for (const element of this.byCode.get(SPACE) ?? []) element.classList.remove("on");
        }
        this.wheel(up);
    }

    wheel(up: boolean): void{
        if (!this.widget) return;
        const id = up ? "kuteWheelUp" : "kuteWheelDown";
        this.widget.querySelector(`#${id}`)?.classList.add("on");
        clearTimeout(this.wheelTimers.get(id));
        this.wheelTimers.set(id, window.setTimeout(() => {
            this.widget?.querySelector(`#${id}`)?.classList.remove("on");
            this.wheelTimers.delete(id);
        }, WHEEL_LIT_MS));
    }
}

export default new Keystrokes();
