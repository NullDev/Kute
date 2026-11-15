import { kute } from "../client";

const STATUS = ".ranked-matchmaking-status";
const FOUND = "Match found!";

class RankedAlert {
    found = false;
    status: Element | null = null;
    observer = new MutationObserver(() => this.check());

    constructor(){
        kute.settings.toggleRankedAlert = (enabled): void => this.toggle(enabled);
        this.toggle(true);
    }

    toggle(enabled: boolean): void{
        this.observer.disconnect();
        if (!enabled) return;
        this.status = document.querySelector(STATUS);
        if (!this.status) return;
        this.observer.observe(this.status, { attributes: true, attributeFilter: ["class"], childList: true, characterData: true, subtree: true });
        this.found = this.shown();
    }

    shown(): boolean{
        return Boolean(this.status?.classList.contains("show")) && this.status?.textContent === FOUND;
    }

    check(): void{
        const found = this.shown();
        if (found && !this.found) window.chrome.webview.postMessage("bring-to-front");
        this.found = found;
    }
}

export default new RankedAlert();
