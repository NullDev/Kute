import { kute } from "../client";

const SETTING_KEY = "kro_setngss_endMessage";
const FIELD_ID = "slid_endMessage";
const HEADER_ID = "playerHeaderEl";
const SAVE_DELAY_MS = 500;

function confirmedAccount(): string | null{
    if (!document.getElementById("signedInHeaderBar")) return null;
    try {
        return localStorage.getItem("krunker_username") || null;
    }
    catch {
        return null;
    }
}

function storedMessage(): string{
    try {
        return localStorage.getItem(SETTING_KEY) ?? "";
    }
    catch {
        return "";
    }
}

class AccountEndMessage {
    account: string | null | undefined = undefined;
    header = new MutationObserver(() => this.check());
    saveTimer = 0;
    editedFor: string | null = null;
    onInput = (event: Event): void => {
        if (!(event.target instanceof HTMLInputElement) || event.target.id !== FIELD_ID || !this.account) return;
        this.editedFor = this.account;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    };

    constructor(){
        kute.settings.toggleAccountEndMessage = (enabled): void => this.toggle(enabled, true);
        this.toggle(!!kute.settings.data.accountEndMessage, false);
    }

    get messages(): Record<string, string>{
        return { ...kute.settings.data.endMessages };
    }

    save(messages: Record<string, string>): void{
        kute.settings.data.endMessages = messages;
        window.chrome.webview.postMessage(`set-config-json endMessages ${JSON.stringify(messages)}`);
    }

    remember(account: string, message: string): void{
        const { messages } = this;
        if ((messages[account] ?? "") === message) return;
        if (message) messages[account] = message;
        else delete messages[account];
        this.save(messages);
    }

    flush(): void{
        clearTimeout(this.saveTimer);
        if (this.editedFor) this.remember(this.editedFor, storedMessage());
        this.editedFor = null;
    }

    check(): void{
        const account = confirmedAccount();
        if (account === this.account) return;
        this.flush();
        this.account = account;
        const message = account ? this.messages[account] ?? "" : "";
        if (storedMessage() !== message) window.setSetting("endMessage", message);
    }

    toggle(enabled: boolean, byPlayer: boolean): void{
        this.header.disconnect();
        document.removeEventListener("input", this.onInput, true);
        if (!enabled){
            this.flush();
            this.account = undefined;
            return;
        }

        const account = confirmedAccount();
        if (byPlayer && account){
            const message = storedMessage();
            this.remember(account, message);
            kute.showNotification(
                message ? `Kept "${message}" for ${account}. Other accounts send nothing until you give them one` : `End messages are now per account, ${account} has none`,
                false,
                6,
            );
        }

        document.addEventListener("input", this.onInput, true);
        const header = document.getElementById(HEADER_ID);
        if (header) this.header.observe(header, { childList: true });
        else console.error("[kute] end message: no account header");
        this.check();
    }
}

export default new AccountEndMessage();
