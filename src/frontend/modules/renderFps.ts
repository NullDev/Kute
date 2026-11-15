import { kute } from "../client";
import { waitForElement } from "../utils";
import { takeFrameWorkMs } from "./gameFpsLimit";

const STALE_MS = 2000;
const BLIND_SHARE = 0.25;
const BLIND_MAX = 60;
const SWITCH_AFTER_MS = 3000;
const POTENTIAL_SMOOTHING = 0.3;

class RenderFps {
    ingameFPS: HTMLElement | null = null;
    menuFPS: HTMLElement | null = null;
    listener: ((event: MessageEvent) => void) | null = null;
    gameFPS: string | null = null;
    rawGameFPS: string | null = null;
    potentialFps = 0;
    presentEnabled = Boolean(kute.settings?.data?.renderStats);
    presentFps = 0;
    presentAt = 0;
    showPresent = true;
    disagreeSince = 0;
    shown = "";

    constructor(){
        kute.settings.toggleRenderFps = (enabled): Promise<void> => this.toggle(enabled);
        this.toggle(true);
    }

    presentUsable(): boolean{
        if (performance.now() - this.presentAt > STALE_MS) return false;
        const game = Number.parseFloat(this.rawGameFPS ?? "");
        if (!Number.isFinite(game) || game <= 0) return true;
        return !(this.presentFps < game * BLIND_SHARE && this.presentFps < BLIND_MAX);
    }

    evaluate(): void{
        if (!this.presentEnabled){
            this.render();
            return;
        }
        const now = performance.now();
        if (this.presentUsable() === this.showPresent) this.disagreeSince = 0;
        else if (!this.disagreeSince) this.disagreeSince = now;
        else if (now - this.disagreeSince >= SWITCH_AFTER_MS){
            this.showPresent = !this.showPresent;
            this.disagreeSince = 0;
            if (!this.showPresent) this.explainOnce();
        }
        this.render();
    }

    explainOnce(): void{
        try {
            if (sessionStorage.getItem("kute_presentFpsHidden")) return;
            sessionStorage.setItem("kute_presentFpsHidden", "1");
        }
        catch {
            return;
        }
        kute.showNotification?.(kute.settings?.data?.hardFlip === false
            ? "Present FPS needs the DXGI Swapchain Hook (Settings, Engine), which is off. Showing the game's FPS"
            : "Present FPS is hidden: the swap chain hook does not see the game's frames on this PC, its number would be wrong. Showing the game's FPS", false, 8);
    }

    render(): void{
        const text = this.showPresent && this.presentAt > 0 ? `${this.gameFPS ?? ""} ${this.presentFps}` : (this.gameFPS ?? "");
        if (text === this.shown) return;
        this.shown = text;
        if (this.ingameFPS) this.ingameFPS.innerText = text;
        if (this.menuFPS) this.menuFPS.innerText = text;
    }

    withPotential(value: string): string{
        const game = Number.parseFloat(value);
        const workMs = takeFrameWorkMs();
        if (!Number.isFinite(game) || game <= 0 || Number(kute.settings?.data?.gameFpsLimit) > 0) return value;
        if (workMs > 0){
            const frameMs = 1000 / game;
            const estimate = 1000 / Math.max(workMs, frameMs - workMs);
            this.potentialFps = this.potentialFps ? this.potentialFps + (estimate - this.potentialFps) * POTENTIAL_SMOOTHING : estimate;
        }
        return this.potentialFps > game ? String(Math.round(this.potentialFps)) : value;
    }

    applyFpsDisplay(element: HTMLElement | null): void{
        if (!element) return;
        Object.defineProperty(element, "textContent", {
            set: (value) => {
                this.rawGameFPS = value;
                this.gameFPS = this.withPotential(value);
                this.evaluate();
            },
            configurable: true,
        });
    }

    async toggle(enabled: boolean): Promise<void>{
        const [ingameFPS, menuFPS] = await Promise.all([waitForElement("#ingameFPS"), waitForElement("#menuFPS")]);
        this.ingameFPS = ingameFPS;
        this.menuFPS = menuFPS;

        if (enabled){
            this.applyFpsDisplay(ingameFPS);
            this.applyFpsDisplay(menuFPS);

            this.listener = (event): void => {
                const fps = event.data?.fpsInfo;
                if (typeof fps !== "number") return;
                this.presentFps = fps;
                this.presentAt = performance.now();
                if (this.showPresent) this.render();
            };

            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            if (this.listener){
                window.chrome.webview.removeEventListener("message", this.listener);
                this.listener = null;
            }
            Reflect.deleteProperty(ingameFPS, "textContent");
            Reflect.deleteProperty(menuFPS, "textContent");
        }
    }
}

export default new RenderFps();
