import html from "../components/diagnostics.html";
import { kute } from "../client";
import { highlight } from "./managers/editor";

const HOST_FEATURE = "diagnostics";
const KRUNKER_SETTING_PREFIX = "kro_setngss_";
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

interface DiagnosticsEntry {
    name: string;
    kind: "json" | "text" | "binary";
    note: string;
    bytes: number;
    text?: string;
    truncated?: boolean;
}

function size(bytes: number): string{
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function today(): string{
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function webglRenderer(): { vendor: string, renderer: string } | null{
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const result = info
        ? { vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) }
        : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
}

function pagePart(): Record<string, any>{
    const krunker: Record<string, string | null> = {};
    for (let index = 0; index < localStorage.length; index++){
        const key = localStorage.key(index);
        if (key?.startsWith(KRUNKER_SETTING_PREFIX)) krunker[key] = localStorage.getItem(key);
    }
    let autodetect: any = null;
    try {
        autodetect = JSON.parse(localStorage.getItem("kute_autodetect") ?? "null");
    }
    catch {
        autodetect = null;
    }
    let activity: { mode: string, map: string | null, custom: boolean } | null = null;
    try {
        const { mode, map, custom } = window.getGameActivity();
        activity = { mode, map, custom };
    }
    catch {
        activity = null;
    }
    const { memory } = performance as any;
    return {
        date: today(),
        krunker,
        autodetect,
        page: {
            path: location.pathname,
            activity,
            userAgent: navigator.userAgent,
            threads: navigator.hardwareConcurrency,
            devicePixelRatio: window.devicePixelRatio,
            screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
            window: { width: window.innerWidth, height: window.innerHeight },
            webgl: webglRenderer(),
            jsHeapMb: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null,
            jsHeapLimitMb: memory ? Math.round(memory.jsHeapSizeLimit / 1024 / 1024) : null,
        },
    };
}

class Diagnostics {
    overlay: HTMLDivElement | null = null;
    shadow: ShadowRoot | null = null;
    entries: DiagnosticsEntry[] = [];
    excluded: Set<string> = new Set();
    compressed = 0;
    onMessage: (event: MessageEvent) => void = (event): void => this.receive(event.data);
    onKey: (event: KeyboardEvent) => void = (event): void => {
        if (event.key === "Escape") this.close();
    };

    constructor(){
        kute.diagnostics = { open: (): void => this.open() };
    }

    open(): void{
        if (!kute.hostFeatures?.includes(HOST_FEATURE)){
            kute.showNotification("The Diagnostics Report needs a newer Kute", false, 4);
            return;
        }
        if (this.overlay) return;
        this.entries = [];
        this.excluded.clear();

        this.overlay = document.createElement("div");
        this.overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        this.overlay.append(host);
        this.shadow = host.attachShadow({ mode: "open" });
        this.shadow.innerHTML = html;
        this.element("dgClose").onclick = (): void => this.close();
        this.element("dgSave").onclick = (): void => this.save();
        this.overlay.addEventListener("mousedown", (event) => {
            if (event.target === this.overlay) this.close();
        });
        document.addEventListener("keydown", this.onKey);
        window.chrome.webview.addEventListener("message", this.onMessage);
        document.body.append(this.overlay);

        window.chrome.webview.postMessage(`diagnostics-collect ${JSON.stringify(pagePart())}`);
    }

    close(): void{
        window.chrome.webview.removeEventListener("message", this.onMessage);
        document.removeEventListener("keydown", this.onKey);
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
        this.entries = [];
    }

    element(id: string): HTMLElement{
        return this.shadow?.querySelector(`#${id}`) as HTMLElement;
    }

    receive(data: any): void{
        if (!this.shadow) return;
        if (data?.diagnostics){
            this.entries = data.diagnostics.entries ?? [];
            this.compressed = data.diagnostics.compressed ?? 0;
            this.element("dgSave").classList.remove("dgBusy");
            this.renderList();
            this.select(this.entries.find((entry) => entry.name !== "manifest.json")?.name ?? "manifest.json");
        }
        else if (data?.diagnosticsSaved){
            const { file, error } = data.diagnosticsSaved;
            this.element("dgSave").classList.remove("dgBusy");
            if (error){
                kute.showNotification(`Could not save the report: ${error}`, false, 5);
                return;
            }
            kute.showNotification(`Saved ${file} to your Downloads folder`, false, 5);
            this.close();
        }
    }

    renderList(): void{
        const list = this.element("dgEntries");
        list.replaceChildren();
        for (const entry of this.entries){
            const row = document.createElement("div");
            row.className = "dgEntry";
            row.dataset.name = entry.name;
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !this.excluded.has(entry.name);
            box.disabled = entry.name === "manifest.json";
            box.onclick = (event): void => {
                event.stopPropagation();
                if (box.checked) this.excluded.delete(entry.name);
                else this.excluded.add(entry.name);
                row.classList.toggle("dgOff", !box.checked);
                this.renderTotal();
            };
            const label = document.createElement("div");
            const name = document.createElement("span");
            name.className = "dgName";
            name.textContent = entry.name;
            const bytes = document.createElement("span");
            bytes.className = "dgSize";
            bytes.textContent = size(entry.bytes);
            label.append(name, bytes);
            row.append(box, label);
            row.onclick = (): void => this.select(entry.name);
            list.append(row);
        }
        this.renderTotal();
    }

    select(name: string): void{
        const entry = this.entries.find((candidate) => candidate.name === name);
        if (!entry) return;
        for (const row of this.element("dgEntries").querySelectorAll(".dgEntry")){
            row.classList.toggle("dgSelected", (row as HTMLElement).dataset.name === name);
        }
        this.element("dgNote").textContent = entry.note;
        const text = this.element("dgText");
        if (entry.kind === "binary") text.textContent = `${entry.name}: ${size(entry.bytes)} of binary data, goes into the file as it is.`;
        else if (entry.kind === "json" && !entry.truncated && (entry.text ?? "").length <= MAX_HIGHLIGHT_CHARS) text.innerHTML = highlight(entry.text ?? "", "json");
        else text.textContent = entry.truncated ? `${entry.text}\n\n... (the preview ends here, the file holds all of it)` : (entry.text ?? "");
        text.scrollTop = 0;
    }

    renderTotal(): void{
        const included = this.entries.filter((entry) => !this.excluded.has(entry.name));
        const raw = included.reduce((sum, entry) => sum + entry.bytes, 0);
        const all = this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
        const estimate = all > 0 ? (this.compressed * raw) / all : 0;
        this.element("dgTotal").textContent = `${included.length} of ${this.entries.length} files, about ${size(Math.round(estimate))} as a file`;
    }

    save(): void{
        this.element("dgSave").classList.add("dgBusy");
        window.chrome.webview.postMessage(`diagnostics-save ${JSON.stringify([...this.excluded])}`);
    }
}

export default new Diagnostics();
