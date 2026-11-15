import { kute } from "../client";
import { waitForElement } from "../utils";

class RealPing {
    ingamePing: HTMLElement | null = null;
    menuPing: HTMLElement | null = null;
    interval: number | null = null;
    listener: ((event: MessageEvent) => void) | null = null;

    constructor(){
        kute.settings.toggleRealPing = (enabled): Promise<void> => this.toggle(enabled);
        this.toggle(true);
    }

    applyPingDisplay(element: HTMLElement | null): void{
        if (!element) return;
        Object.defineProperty(element, "textContent", {
            set: () => {},
            configurable: true,
        });
    }

    async toggle(enabled: boolean): Promise<void>{
        const [ingamePing, menuPing] = await Promise.all([waitForElement("#pingText"), waitForElement("#menuPingText")]);
        this.ingamePing = ingamePing;
        this.menuPing = menuPing;

        if (enabled){
            this.applyPingDisplay(ingamePing);
            this.applyPingDisplay(menuPing);
            this.interval = setInterval(() => {
                window.chrome.webview.postMessage("ping");
            }, 3000);

            this.listener = (event): void => {
                const ping = event.data?.pingInfo;
                if (!ping) return;
                ingamePing.innerText = ping;
                menuPing.innerText = ping;
            };
            window.chrome.webview.addEventListener("message", this.listener);
        }
        else {
            if (this.interval !== null) clearInterval(this.interval);
            if (this.listener) window.chrome.webview.removeEventListener("message", this.listener);
            this.interval = null;
            this.listener = null;
            Reflect.deleteProperty(ingamePing, "textContent");
            Reflect.deleteProperty(menuPing, "textContent");
        }
    }
}

export default new RealPing();
