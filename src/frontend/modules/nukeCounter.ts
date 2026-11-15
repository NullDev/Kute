import styles from "../components/nukeCounter.css";
import { kute } from "../client";

interface NukeCounterConfig {
    goal: number;
    background: boolean;
}

const DEFAULT_CONFIG: NukeCounterConfig = { goal: 0, background: true };

const PLAYER_API = "https://gapi.svc.krunker.io/players/";
const TICK_MS = 2000;
const RETRY_MS = 30000;
const COMMIT_DELAYS = [5000, 20000];
const GAIN_MS = 8000;

function clamp(value: number, min: number, max: number): number{
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function format(value: number): string{
    return value.toLocaleString("en-US");
}

class NukeCounter {
    overlay: HTMLElement | null = null;
    nukes: number | null = null;
    nukesFor = "";
    noStat = false;
    fetching = false;
    lastTry = 0;
    endWasUp = false;
    tick: number | null = null;
    commitTimers: number[] = [];

    constructor(){
        kute.nukeCounter = { showOptions: (): Promise<void> => this.showOptions() };
        kute.settings.toggleNukeCounter = (enabled): void => this.toggle(enabled);

        this.toggle(!!kute.settings.data.nukeCounter);
    }

    accountName(): string{
        try {
            return window.localStorage.getItem("krunker_username") ?? "";
        }
        catch {
            return "";
        }
    }

    get config(): NukeCounterConfig{
        return { ...DEFAULT_CONFIG, ...kute.settings.data.nukeCounterConfig };
    }

    saveConfig(config: NukeCounterConfig): void{
        kute.settings.data.nukeCounterConfig = config;
        window.chrome.webview.postMessage(`set-config-json nukeCounterConfig ${JSON.stringify(config)}`);
    }

    toggle(enabled: boolean): void{
        if (!enabled){
            this.destroy();
            return;
        }
        if (!document.querySelector("#kuteNukeCounterCSS")){
            const style = document.createElement("style");
            style.id = "kuteNukeCounterCSS";
            style.textContent = styles;
            document.head.append(style);
        }
        this.inject();
        if (this.nukes === null) this.refresh();
        this.tick ??= setInterval(() => this.onTick(), TICK_MS);
    }

    destroy(): void{
        if (this.tick !== null){
            clearInterval(this.tick);
            this.tick = null;
        }
        for (const timer of this.commitTimers) clearTimeout(timer);
        this.commitTimers = [];
        this.overlay?.remove();
        this.overlay = null;
        document.querySelector("#kuteNukeCounterCSS")?.remove();
        this.endWasUp = false;
    }

    inject(): void{
        if (!this.accountName()) return;
        if (this.overlay?.isConnected) return;

        this.overlay?.remove();
        const overlay = document.createElement("div");
        overlay.id = "kuteNukeCounter";
        overlay.innerHTML = '<span class="nukeIcon">☢</span><span class="nukeCount">—</span><span class="nukeGoal"></span>';
        (document.querySelector("#uiBase") ?? document.body).append(overlay);

        this.overlay = overlay;
        this.applyConfig();
        this.render();
    }

    applyConfig(): void{
        this.overlay?.classList.toggle("nukeBg", this.config.background);
    }

    render(): void{
        const { overlay } = this;
        if (!overlay) return;
        const { goal } = this.config;
        const count = overlay.querySelector(".nukeCount");
        const goalElement = overlay.querySelector(".nukeGoal") as HTMLElement | null;
        if (count) count.textContent = this.nukes === null ? "—" : format(this.nukes);
        if (goalElement){
            goalElement.style.display = goal > 0 ? "" : "none";
            goalElement.textContent = `/ ${format(goal)}`;
        }
        overlay.classList.toggle("nukeGoalMet", goal > 0 && this.nukes !== null && this.nukes >= goal);
    }

    showGain(gain: number): void{
        const { overlay } = this;
        if (!overlay || gain <= 0) return;
        overlay.querySelector(".nukeGain")?.remove();
        const element = document.createElement("span");
        element.className = "nukeGain";
        element.textContent = `+${format(gain)}`;
        overlay.append(element);
        setTimeout(() => element.remove(), GAIN_MS);
    }

    refresh(): void{
        const name = this.accountName();
        if (!name || this.fetching) return;
        this.fetching = true;
        this.lastTry = Date.now();

        window.fetch(PLAYER_API + encodeURIComponent(name), { credentials: "omit", signal: AbortSignal.timeout(10000) })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                const total = body?.data?.player_stats?.n;
                if (typeof total === "number"){
                    const gain = this.nukes === null || this.nukesFor !== name ? 0 : total - this.nukes;
                    this.nukes = total;
                    this.noStat = false;
                    this.nukesFor = name;
                    this.render();
                    this.showGain(gain);
                }
                else if (body){
                    this.noStat = true;
                    this.nukesFor = name;
                }
            })
            .catch(() => {
            })
            .finally(() => {
                this.fetching = false;
            });
    }

    onTick(): void{
        this.inject();
        const name = this.accountName();
        if (name !== this.nukesFor && (this.nukes !== null || this.noStat)){
            this.nukes = null;
            this.noStat = false;
            this.lastTry = 0;
            this.render();
        }
        if (this.nukes === null && !this.noStat && Date.now() - this.lastTry > RETRY_MS) this.refresh();

        const endUI = document.querySelector("#endUI") as HTMLElement | null;
        const endIsUp = !!endUI && endUI.style.display !== "none";
        if (endIsUp && !this.endWasUp && this.commitTimers.length === 0){
            this.commitTimers = COMMIT_DELAYS.map((delay, index) => setTimeout(() => {
                if (index === COMMIT_DELAYS.length - 1) this.commitTimers = [];
                this.refresh();
            }, delay));
        }
        this.endWasUp = endIsUp;
    }

    async showOptions(): Promise<void>{
        const html = await import("../components/nukeCounterOptions.html");
        const { config } = this;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        const element = (id: string): HTMLInputElement => (shadow.querySelector(`#${id}`) as HTMLInputElement);

        const apply = (): void => {
            kute.settings.data.nukeCounterConfig = config;
            this.applyConfig();
            this.render();
        };

        element("nkGoalInput").value = String(config.goal);
        element("nkBackground").checked = config.background;

        element("nkGoalInput").oninput = (event): void => {
            const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
            config.goal = Number.isNaN(value) ? 0 : clamp(value, 0, 1000000);
            apply();
        };
        element("nkBackground").onchange = (event): void => {
            config.background = (event.target as HTMLInputElement).checked;
            apply();
        };

        const controller = new AbortController();
        const close = (): void => {
            controller.abort();
            overlay.remove();
            this.saveConfig(config);
        };
        element("nkDone").onclick = close;
        element("nkPlace").onclick = (): void => {
            close();
            kute.hudEditor?.edit();
        };
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );
        document.body.append(overlay);
    }
}

export default new NukeCounter();
