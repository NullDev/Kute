import { kute } from "../client";
import { getElement, getInput } from "../utils";

class BetterChat {
    teamModes: Set<string>;
    styles: HTMLStyleElement;
    chatHolder: HTMLElement;
    chatList: HTMLElement;
    chatInput: HTMLInputElement;
    chatSwitch: HTMLElement;
    channelT: HTMLDivElement;
    channelA: HTMLDivElement;
    observer: MutationObserver;

    constructor(){
        this.teamModes = new Set([
            "Team Deathmatch",
            "Hardpoint",
            "Capture the Flag",
            "Hide & Seek",
            "Infected",
            "Last Man Standing",
            "Simon Says",
            "Prop Hunt",
            "Boss Hunt",
            "Deposit",
            "Stalker",
            "Kill Confirmed",
            "Defuse",
            "Traitor",
            "Blitz",
            "Domination",
            "Squad Deathmatch",
            "Team Defender",
        ]);
        this.styles = document.createElement("style");
        import("../components/betterChat.css").then((css) => {
            this.styles.innerHTML = css.default;
        });

        kute.settings.toggleBetterChat = (enabled): void => this.toggle(enabled);

        this.chatHolder = getElement("#chatHolder");
        this.chatList = getElement("#chatList");
        this.chatInput = getInput("#chatInput");
        this.chatSwitch = getElement("#chatSwitch");
        this.channelT = document.createElement("div");
        this.channelA = document.createElement("div");
        this.channelT.style.cssText = "float: left; display: inline-block; margin-right: 5px; color: #9eeb56;";
        this.channelT.textContent = "[T]";
        this.channelA.style.cssText = "float: left; display: inline-block; margin-right: 5px; color: #eb5656;";
        this.channelA.textContent = "[M]";

        this.observer = new MutationObserver((mutations) => this.parseMessages(mutations));
        this.toggle(true);
    }

    switchChat = (event: KeyboardEvent): void => {
        if (event.key !== "Tab") return;
        window.switchChat(this.chatSwitch);
        event.preventDefault();
    };

    parseMessages(mutations: MutationRecord[]): void{
        let tagged = false;
        for (const mutation of mutations){
            for (const node of mutation.addedNodes){
                if (!(node instanceof HTMLElement)) continue;
                const chatItem = node.querySelector(".chatItem");
                if (!chatItem) continue;
                const chatMsg = chatItem.querySelector(".chatMsg");
                if (!chatMsg) continue;
                if (chatMsg.textContent.includes("Text & Voice Chat")){
                    node.remove();
                    continue;
                }
                const { tab } = node.dataset;
                if (!tab || !chatItem.textContent.includes("\u200E:") || !this.teamModes.has(window.getGameActivity().mode)) continue;
                if (tab === "0") chatMsg.insertBefore(this.channelA.cloneNode(true), chatMsg.firstChild);
                else if (tab === "1") chatMsg.insertBefore(this.channelT.cloneNode(true), chatMsg.firstChild);
                tagged = true;
            }
        }
        if (tagged) this.chatList.scrollTop = 1e9;
    }

    toggle(enabled: boolean): void{
        if (enabled){
            document.head.append(this.styles);
            this.chatInput.addEventListener("keydown", this.switchChat, { capture: true });
            this.observer.observe(this.chatList, { childList: true });
        }
        else {
            this.styles.remove();
            this.chatInput.removeEventListener("keydown", this.switchChat, { capture: true });
            this.observer.disconnect();
        }
    }
}

export default new BetterChat();
