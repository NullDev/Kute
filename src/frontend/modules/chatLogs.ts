import html from "../components/chatLogs.html";
import { kute } from "../client";
import { bindings, matches } from "./hotkeys";

const MAX_ENTRIES = 2000;
const STORE_KEY = "kute_chat_logs";
const LTR_MARK = String.fromCharCode(0x200e);

type Category = "player"|"kill"|"event"|"server";

type Entry = {t: number, cat: Category|"lobby", text: string};

const CATEGORIES: [Category, string][] = [["player", "Players"], ["kill", "Kills"], ["event", "Events"], ["server", "Server"]];
const ROW_CLASS: Record<string, string> = { player: "", kill: "clKill", event: "clEvent", server: "clServer", lobby: "clLobby" };

function classify(node: HTMLElement): Category{
    if (!node.hasAttribute("data-tab")) return "kill";
    const item = node.querySelector(".chatItem");
    const msg = item?.querySelector(".chatMsg");
    if (!item || !(msg instanceof HTMLElement) || item.querySelector(".tradeMsg")) return "event";
    if (item.firstChild !== msg) return "player";
    return msg.style.color ? "server" : "event";
}

function killText(node: HTMLElement): string{
    let text = "";
    let weapon = false;
    const tags: string[] = [];
    for (const part of node.querySelector(".chatMsg")?.childNodes ?? []){
        if (!(part instanceof HTMLImageElement)){
            text += part.textContent ?? "";
            continue;
        }
        const src = part.getAttribute("src") ?? "";
        if (src.includes("headshot")) tags.push("headshot");
        else if (src.includes("wallbang")) tags.push("wallbang");
        else if (!weapon){
            weapon = true;
            text += " ▸ ";
        }
    }
    return tags.length > 0 ? `${text.trim()} (${tags.join(", ")})` : text;
}

function clock(time: number): string{
    const date = new Date(time);
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function restore(): Entry[]{
    try {
        const stored = JSON.parse(window.sessionStorage.getItem(STORE_KEY) ?? "[]");
        return Array.isArray(stored) ? stored.slice(-MAX_ENTRIES) : [];
    }
    catch {
        return [];
    }
}

function lobbyName(): string{
    try {
        const { mode, map } = window.getGameActivity();
        if (mode && map) return `${mode} on ${map}`;
    }
    catch {}
    return "New lobby";
}

class ChatLogs {
    entries = restore();
    shown: Set<Category>;
    view: { overlay: HTMLDivElement; shadow: ShadowRoot; list: HTMLElement; search: HTMLInputElement; } | null;
    stick: boolean;
    observer: MutationObserver;
    save: () => void;

    constructor(){
        if (this.entries.length > 0 && this.entries[this.entries.length - 1].cat !== "lobby") this.entries.push({ t: Date.now(), cat: "lobby", text: lobbyName() });
        this.shown = new Set();
        this.view = null;
        this.stick = true;
        this.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) for (const node of mutation.addedNodes) this.add(node);
        });
        this.save = (): void => {
            try {
                window.sessionStorage.setItem(STORE_KEY, JSON.stringify(this.entries));
            }
            catch {}
        };

        kute.chatLogs = { open: (): void => this.open(), toggle: (): void => this.toggle() };
        kute.settings.toggleChatLogs = (enabled): void => this.setEnabled(enabled);
        this.setEnabled(true);
    }

    setEnabled(enabled: boolean): void{
        this.observer.disconnect();
        window.removeEventListener("pagehide", this.save);
        if (!enabled){
            this.close();
            return;
        }
        const chatList = document.getElementById("chatList");
        if (!chatList) return;
        for (const node of chatList.children) this.add(node);
        this.observer.observe(chatList, { childList: true });
        window.addEventListener("pagehide", this.save);
    }

    add(node: Node): void{
        if (!(node instanceof HTMLElement)) return;
        const cat = classify(node);
        const text = (cat === "kill" ? killText(node) : node.textContent ?? "").replaceAll(LTR_MARK, "").trim();
        if (!text) return;
        const entry: Entry = { t: Date.now(), cat, text };
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        if (!this.view || !this.visible(entry)) return;
        const { list } = this.view;
        list.querySelector(".clEmpty")?.remove();
        list.append(this.row(entry));
        if (list.childElementCount > MAX_ENTRIES) list.firstElementChild?.remove();
        if (this.stick) list.scrollTop = 1e9;
    }

    visible(entry: Entry): boolean{
        const query = this.view?.search.value.trim().toLowerCase() ?? "";
        if (entry.cat === "lobby") return this.shown.size === 0 && !query;
        if (this.shown.size > 0 && !this.shown.has(entry.cat)) return false;
        return !query || entry.text.toLowerCase().includes(query);
    }

    row(entry: Entry): HTMLDivElement{
        const row = document.createElement("div");
        row.className = `clRow ${ROW_CLASS[entry.cat] ?? ""}`;
        const time = document.createElement("span");
        time.className = "clTime";
        time.textContent = clock(entry.t);
        row.append(time, entry.text);
        return row;
    }

    render(): void{
        if (!this.view) return;
        const rows = this.entries.filter((entry) => this.visible(entry)).map((entry) => this.row(entry));
        if (rows.length === 0){
            const empty = document.createElement("div");
            empty.className = "clEmpty";
            empty.textContent = this.entries.length === 0 ? "Nothing in the chat yet" : "No line matches";
            rows.push(empty);
        }
        this.view.list.replaceChildren(...rows);
        this.view.list.scrollTop = 1e9;
        this.stick = true;
        this.renderFilters();
    }

    renderFilters(): void{
        if (!this.view) return;
        const button = (label: string, on: boolean, onClick: () => void): HTMLDivElement => {
            const element = document.createElement("div");
            element.className = `clFilter${on ? " clOn" : ""}`;
            element.textContent = label;
            element.onclick = onClick;
            return element;
        };
        const all = button("All", this.shown.size === 0, () => {
            this.shown.clear();
            this.render();
        });
        const filters = CATEGORIES.map(([cat, label]) => button(label, this.shown.has(cat), () => {
            if (this.shown.has(cat)) this.shown.delete(cat);
            else this.shown.add(cat);
            this.render();
        }));
        (this.view.shadow.querySelector("#clFilters") as HTMLElement).replaceChildren(all, ...filters);
    }

    open(): void{
        if (this.view) return;
        if (document.pointerLockElement) document.exitPointerLock();
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html;
        const element = (id: string): HTMLElement => (shadow.querySelector(`#${id}`) as HTMLElement);
        const list = element("clList");
        const search = element("clSearch") as HTMLInputElement;
        this.view = { overlay, shadow, list, search };

        const binding = bindings().chatLogs;
        element("clHint").textContent = `${binding ? `${binding.name} opens and closes this. ` : ""}Select lines and copy with Ctrl+C`;
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) this.close();
        });
        for (const type of ["keydown", "keyup", "keypress"]){
            host.addEventListener(type, (event) => {
                const key = event as KeyboardEvent;
                if (type === "keydown" && !key.repeat && (key.key === "Escape" || matches(key, "chatLogs"))) this.close();
                event.stopPropagation();
            });
        }
        list.addEventListener("scroll", () => {
            this.stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
        }, { passive: true });
        search.addEventListener("input", () => this.render());
        element("clCopy").onclick = (): void => {
            const text = this.entries.filter((entry) => this.visible(entry)).map((entry) => `${clock(entry.t)} ${entry.text}`).join("\n");
            navigator.clipboard.writeText(text).then(
                () => kute.showNotification("Chat log copied", false, 2),
                () => kute.showNotification("Could not copy the chat log", false, 3),
            );
        };
        element("clClear").onclick = (): void => {
            this.entries = [];
            this.save();
            this.render();
        };
        element("clClose").onclick = (): void => this.close();

        document.body.append(overlay);
        this.render();
        search.focus();
    }

    close(): void{
        this.view?.overlay.remove();
        this.view = null;
    }

    toggle(): void{
        if (this.view) this.close();
        else this.open();
    }
}

export default new ChatLogs();
