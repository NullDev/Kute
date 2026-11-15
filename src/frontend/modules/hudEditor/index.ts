import { kute } from "../../client";
import { HUD_ELEMENTS, type HudElement } from "./elements";
import { confirmPopup } from "../confirmPopup";
import { activity, hostLobby, spawn } from "../privateMatch";

export interface HudPlacement {
    x?: number;
    y?: number;
    s?: number;
}

export interface HudGeometry {
    vw: number;
    vh: number;
    factor: number;
    game: string;
    rects: Record<string, [number, number, number, number, number]>;
}

const STYLE_ID = "kute_hudLayoutCSS";
const GEOMETRY_KEY = "kute_hud_geometry";
const KEYSTROKES_WIDTH = 190;
const SPOTIFY_WIDTH = 320;
const WIDGET_GAP = 12;

export function implicitShift(key: string, layout: Record<string, HudPlacement>): number{
    if (key !== "spotify" || !kute.settings.data.keystrokes) return 0;
    const spotify = layout.spotify ?? {};
    const keys = layout.keystrokes ?? {};
    if (spotify.x || spotify.y || keys.x || keys.y) return 0;
    const keysRight = (KEYSTROKES_WIDTH * (1 + (keys.s ?? 1))) / 2;
    const spotifyLeft = (SPOTIFY_WIDTH * (1 - (spotify.s ?? 1))) / 2;
    return Math.round(keysRight + WIDGET_GAP - spotifyLeft);
}

export class HudEditor {
    style: HTMLStyleElement | null = null;
    open = false;
    menuRects: Record<string, Record<string, [number, number, number, number, number]>> = {};

    constructor(){
        kute.hudEditor = { edit: (): Promise<void> => this.edit(), apply: (): void => this.apply() };

        this.migrateNukeCounter();
        this.apply();
        if (Object.keys(this.measureMenuWidgets()).length === 0) setTimeout(() => this.measureMenuWidgets(), 3000);
    }

    get layout(): Record<string, HudPlacement>{
        return { ...kute.settings.data.hudLayout };
    }

    save(layout: Record<string, HudPlacement>): void{
        kute.settings.data.hudLayout = layout;
        window.chrome.webview.postMessage(`set-config-json hudLayout ${JSON.stringify(layout)}`);
        this.apply();
    }

    migrateNukeCounter(): void{
        const config = kute.settings.data.nukeCounterConfig;
        if (!config || (config.x === undefined && config.y === undefined && config.scale === undefined)) return;

        const { layout } = this;
        layout.nuke ??= {
            x: Math.round(((config.x ?? 94) - 94) * 100) / 100,
            y: Math.round(((config.y ?? 50) - 50) * 100) / 100,
            s: config.scale ?? 1,
        };
        const kept = { goal: config.goal ?? 0, background: config.background ?? true };
        kute.settings.data.nukeCounterConfig = kept;
        window.chrome.webview.postMessage(`set-config-json nukeCounterConfig ${JSON.stringify(kept)}`);
        this.save(layout);
    }

    apply(): void{
        const { layout } = this;
        let text = "";
        for (const element of HUD_ELEMENTS){
            const place = layout[element.key] ?? {};
            const moved = (place.x ?? 0) !== 0 || (place.y ?? 0) !== 0;
            const scaled = (place.s ?? 1) !== 1;
            const shift = implicitShift(element.key, layout);
            if (!moved && !scaled && !shift) continue;

            const parts = [];
            if (moved) parts.push(`translate:${place.x ?? 0}vw ${place.y ?? 0}vh`);
            else if (shift) parts.push(`translate:${shift}px 0`);
            if (scaled) parts.push(`scale:${place.s}`);
            text += `${element.rule ?? element.selector}{${parts.join(";")}}`;
        }

        if (!this.style){
            this.style = document.createElement("style");
            this.style.id = STYLE_ID;
            document.head.append(this.style);
        }
        this.style.textContent = text;
    }

    inMatch(): boolean{
        const hud = document.querySelector("#inGameUI");
        return !!hud && window.getComputedStyle(hud).display !== "none";
    }

    snapshot(): HudGeometry | null{
        if (!this.inMatch()) return null;

        const found: { def: HudElement, element: HTMLElement, visible: boolean }[] = [];
        for (const def of HUD_ELEMENTS){
            if (def.menu) continue;
            const element = document.querySelector(def.selector) as HTMLElement | null;
            if (!element) continue;
            found.push({ def, element, visible: window.getComputedStyle(element).display !== "none" });
        }

        const geometry: HudGeometry = { vw: window.innerWidth, vh: window.innerHeight, factor: 1, game: activity().id ?? "", rects: {} };

        const layoutText = this.style?.textContent ?? "";
        if (this.style) this.style.textContent = "";

        for (const { def, element, visible } of found){
            if (!visible) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0) continue;
            geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 1];
            if (rect.width > 60 && element.offsetWidth > 0) geometry.factor = rect.width / element.offsetWidth;
        }

        const hidden = found.filter(({ def }) => !geometry.rects[def.key] && def.display);
        if (hidden.length > 0){
            const probe = document.createElement("style");
            probe.textContent = hidden.map(({ def }) => `${def.selector}{display:${def.display}!important}`).join("");
            document.head.append(probe);
            for (const { def, element } of hidden){
                const rect = element.getBoundingClientRect();
                if (rect.width > 0) geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 0];
            }
            probe.remove();
        }

        for (const { def, element } of found){
            if (geometry.rects[def.key]) continue;
            const rect = element.getBoundingClientRect();
            geometry.rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 0];
        }

        const seen = this.menuRects[`${geometry.vw}x${geometry.vh}`] ?? {};
        for (const def of HUD_ELEMENTS){
            if (!def.menu) continue;
            if (seen[def.key]){
                geometry.rects[def.key] = seen[def.key];
                continue;
            }
            const [cx, cy] = def.menu(geometry.vw, geometry.vh);
            const [w, h] = def.size ?? [0, 0];
            geometry.rects[def.key] = [cx - w / 2, cy - h / 2, w, h, 1];
        }

        if (this.style) this.style.textContent = layoutText;

        try {
            window.localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geometry));
        }
        catch {}
        return geometry;
    }

    geometry(): HudGeometry | null{
        if (this.inMatch()) return this.snapshot();

        let stored: HudGeometry | null = null;
        try {
            stored = JSON.parse(window.localStorage.getItem(GEOMETRY_KEY) ?? "null");
        }
        catch {
            stored = null;
        }
        if (!stored?.rects) return null;
        if (stored.vw !== window.innerWidth || stored.vh !== window.innerHeight) return null;
        return this.withMenuWidgets(stored);
    }

    measureMenuWidgets(): Record<string, [number, number, number, number, number]>{
        const rects: Record<string, [number, number, number, number, number]> = {};
        const layoutText = this.style?.textContent ?? "";
        if (this.style) this.style.textContent = "";
        for (const def of HUD_ELEMENTS){
            if (!def.menu) continue;
            const rect = document.querySelector(def.selector)?.getBoundingClientRect();
            if (rect && rect.width > 0) rects[def.key] = [rect.x, rect.y, rect.width, rect.height, 1];
        }
        if (this.style) this.style.textContent = layoutText;
        if (Object.keys(rects).length > 0) this.menuRects[`${window.innerWidth}x${window.innerHeight}`] = rects;
        return rects;
    }

    withMenuWidgets(geometry: HudGeometry): HudGeometry{
        return { ...geometry, rects: { ...geometry.rects, ...this.measureMenuWidgets() } };
    }

    async edit(): Promise<void>{
        if (this.open) return;

        if (this.inMatch()){
            this.show(this.snapshot());
            return;
        }

        const measured = this.geometry();
        if (measured?.game && measured.game === activity().id){
            this.show(measured);
            return;
        }

        const go = await confirmPopup({
            title: "Set up your HUD",
            paragraphs: [
                "The editor places everything exactly where it sits in a match, so it needs a match to measure.",
                "Kute opens a private one for you, nobody else can join it. If you are in a game right now, you leave it.",
            ],
            stay: "Not now",
            leave: "Open a private match",
        });
        if (!go || this.open) return;

        if (document.querySelector("#signedInHeaderBar") === null){
            kute.showNotification?.("Log in first, a private match needs an account", false, 5);
            return;
        }

        this.open = true;
        kute.showNotification?.("Opening a private match", false, 4);
        const room = await hostLobby();
        const joined = room !== null && (await spawn(room));
        if (!joined){
            this.open = false;
            kute.showNotification?.("Could not open a private match. Is a host slot free?", false, 6);
            return;
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 1500);
        });
        this.open = false;
        this.show(this.snapshot() ?? this.geometry());
    }

    show(geometry: HudGeometry | null): void{
        if (!geometry){
            kute.showNotification?.("Could not measure the HUD, try again", false, 6);
            return;
        }
        this.open = true;
        import("./editor")
            .then((module) => module.openEditor(this, geometry))
            .catch((error) => {
                this.open = false;
                console.error("[kute] hud editor:", error);
            });
    }

    closed(): void{
        this.open = false;
    }
}

export default new HudEditor();
