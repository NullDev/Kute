const BLOCKED_WORDS = ["null", "client"];
const ECHO_WINDOW_MS = 4000;
const WARNING_COLOR = "#ff5a5a";

/**
 * @param {string} text
 * @return {string | null} the first blocked word in the text
 */
export function blockedWord(text: string): string | null{
    const lower = text.toLowerCase();
    let found: string | null = null;
    let at = Infinity;
    for (const word of BLOCKED_WORDS){
        const index = lower.indexOf(word);
        if (index !== -1 && index < at){
            found = word;
            at = index;
        }
    }
    return found;
}

/**
 * @param {string} sent
 * @param {string} shown
 * @return {boolean} whether the shown line is the sent one, censored characters included
 */
export function sameMessage(sent: string, shown: string): boolean{
    const a = sent.trim().replace(/\s+/g, " ");
    const b = shown.trim().replace(/\s+/g, " ");
    if (a.length !== b.length || a.length === 0) return false;
    for (let i = 0; i < a.length; i++){
        if (a[i] !== b[i] && b[i] !== "*") return false;
    }
    return true;
}

class BlockedChatWarning {
    chatList: HTMLElement | null = null;
    chatInput: HTMLInputElement | null = null;
    typed = "";
    pending: { text: string, word: string, at: number }[] = [];
    observer: MutationObserver;

    constructor(){
        this.observer = new MutationObserver((mutations) => {
            if (this.pending.length === 0) return;
            for (const mutation of mutations) for (const node of mutation.addedNodes) this.check(node);
        });
        this.attach();
    }

    onInput = (): void => {
        this.typed = this.chatInput?.value ?? "";
    };

    onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" || event.isComposing) return;
        const text = this.chatInput?.value || this.typed;
        this.typed = "";
        const word = blockedWord(text);
        if (!word) return;
        const now = performance.now();
        this.pending = this.pending.filter((entry) => now - entry.at < ECHO_WINDOW_MS);
        this.pending.push({ text, word, at: now });
    };

    check(node: Node): void{
        if (!(node instanceof HTMLElement) || node.dataset.tab !== "-1") return;
        const item = node.querySelector(".chatItem");
        const message = item?.querySelector(".chatMsg");
        if (!item || !message || item.firstChild === message || item.querySelector(".tradeMsg")) return;
        const now = performance.now();
        const index = this.pending.findIndex((entry) => now - entry.at < ECHO_WINDOW_MS && sameMessage(entry.text, message.textContent ?? ""));
        if (index === -1) return;
        const [{ word }] = this.pending.splice(index, 1);
        const warning = document.createElement("span");
        warning.className = "chatMsg";
        warning.style.color = WARNING_COLOR;
        warning.textContent = `Message not sent. Krunker blocks "${word}" in chat, nobody else saw it.`;
        item.replaceChildren(warning);
    }

    attach(): void{
        this.chatList = document.getElementById("chatList");
        const input = document.getElementById("chatInput");
        this.chatInput = input instanceof HTMLInputElement ? input : null;
        if (!this.chatList || !this.chatInput) return;
        this.chatInput.addEventListener("input", this.onInput);
        this.chatInput.addEventListener("keydown", this.onKey, { capture: true });
        this.observer.observe(this.chatList, { childList: true });
    }
}

export default new BlockedChatWarning();
