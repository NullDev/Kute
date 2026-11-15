const SEND_WINDOW_MS = 250;

class ChatDraft {
    tracked: WeakSet<HTMLTextAreaElement> = new WeakSet();
    draft: { input: HTMLTextAreaElement; friend: string; text: string; start: number; end: number; } | null = null;
    observer: MutationObserver | null = null;
    pending: ReturnType<typeof setTimeout> | null = null;
    sentAt = 0;

    constructor(){
        document.addEventListener("focusin", (event) => {
            const input = event.target;
            if (input instanceof HTMLTextAreaElement && input.classList.contains("conversation-input")) this.track(input);
        });
    }

    friendOf(input: HTMLTextAreaElement): string{
        return input.closest(".conversation-root")?.querySelector(".conversation-header-name")?.textContent ?? "";
    }

    track(input: HTMLTextAreaElement): void{
        if (this.tracked.has(input)) return;
        this.tracked.add(input);
        input.addEventListener("input", () => this.save(input));
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) this.sentAt = performance.now();
        });
        input.closest(".conversation-compose")?.querySelector(".conversation-send-button")?.addEventListener("click", () => {
            this.sentAt = performance.now();
        });
        if (input.value) this.save(input);
    }

    save(input: HTMLTextAreaElement): void{
        if (!input.value){
            this.stop();
            return;
        }
        this.draft = { input, friend: this.friendOf(input), text: input.value, start: input.selectionStart, end: input.selectionEnd };
        if (this.observer) return;
        const root = input.closest(".conversation-root");
        if (!root) return;
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    schedule(): void{
        if (this.pending === null) this.pending = setTimeout(() => this.check(), 0);
    }

    check(): void{
        this.pending = null;
        const { draft } = this;
        if (!draft) return;
        const { input } = draft;
        if (!input.isConnected || this.friendOf(input) !== draft.friend){
            this.stop();
            return;
        }
        if (input.value){
            this.save(input);
            return;
        }
        if (performance.now() - this.sentAt < SEND_WINDOW_MS){
            this.stop();
            return;
        }
        input.value = draft.text;
        if (document.activeElement === input) input.setSelectionRange(draft.start, draft.end);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    stop(): void{
        this.draft = null;
        this.observer?.disconnect();
        this.observer = null;
    }
}

export default new ChatDraft();
