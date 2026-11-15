import { kute } from "../../client";
import api from "../api";
import marketApi from "./api";
import cards from "./cards";
import trade from "./trade";
import offers from "./offers";
import alerts, { UNREAD_EVENT } from "./alerts";
import contrib from "./contrib";
import type { Terminal } from "./terminal";

class Market {
    headerItem = document.createElement("div");
    headerSeparator = document.createElement("div");
    headerObserver = new MutationObserver(() => this.placeButton());
    onUnread = (): void => this.updateBadge();
    terminal: Terminal | null = null;
    running = false;
    warned = false;

    constructor(){
        kute.settings.toggleMarket = (enabled): void => this.toggle(enabled);
        kute.market = { open: (tab, arg): Promise<void> => this.open(tab, arg), toggle: (enabled): void => this.toggle(enabled) };
        this.toggle(true);
    }

    toggle(enabled: boolean): void{
        if (enabled === this.running) return;
        this.running = enabled;
        if (enabled){
            if (!marketApi.hostSupported()){
                if (!this.warned){
                    this.warned = true;
                    kute.showNotification("Item Stats need a newer Kute. Update Kute to use them.", false, 8);
                }
                this.running = false;
                return;
            }
            if (api.offline()){
                this.running = false;
                return;
            }
            this.placeButton();
            const header = document.querySelector("#playerHeaderEl");
            if (header) this.headerObserver.observe(header, { childList: true, subtree: true });
            window.addEventListener(UNREAD_EVENT, this.onUnread);
            cards.start();
            trade.start();
            offers.start();
            alerts.start();
            contrib.start();
        }
        else {
            this.headerObserver.disconnect();
            window.removeEventListener(UNREAD_EVENT, this.onUnread);
            this.headerItem.remove();
            this.headerSeparator.remove();
            cards.stop();
            trade.stop();
            offers.stop();
            alerts.stop();
            contrib.stop();
            this.terminal?.close();
        }
    }

    placeButton(): void{
        const right = document.querySelector("#playerHeaderEl .headerBarRight");
        if (!right) return;
        if (right.contains(this.headerItem)) return;
        const scope = [...(right.querySelector(".nav-item")?.classList ?? [])].find((name) => name.startsWith("svelte-")) ?? "";
        this.headerItem.className = `nav-item ${scope}`;
        this.headerItem.innerHTML = `<div class="nav-icon-wrap ${scope}"><span class="material-icons nav-mat-icon ${scope}">query_stats</span></div> <span class="nav-label ${scope}">Item Stats</span> <div class="nav-badge ${scope}" style="display: none;"></div>`;
        this.headerItem.onclick = (): Promise<void> => this.open(alerts.unread.size ? "watchlist" : undefined);
        this.headerSeparator.className = "verticalSeparator";
        this.headerSeparator.style.cssText = "height: 35px;";
        right.prepend(this.headerItem, this.headerSeparator);
        this.updateBadge();
    }

    updateBadge(): void{
        const badge = this.headerItem.querySelector(".nav-badge") as HTMLElement|null;
        if (!badge) return;
        const count = alerts.unread.size;
        badge.textContent = String(Math.min(99, count));
        badge.style.display = count ? "inline-block" : "none";
    }

    async open(tab?: string, arg?: unknown): Promise<void>{
        if (!this.running) return;
        if (!this.terminal){
            const module = await import("./terminal").catch(() => null);
            if (!module) return;
            this.terminal = module.default;
        }
        await this.terminal.open(tab, arg);
    }
}

const market = new Market();
export default market;
