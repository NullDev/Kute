import { kute } from "../../client";
import sharedCss from "../../components/managers/manager.css";

export interface ManagerPopup {
    shadow: ShadowRoot;
    close: () => void;
    signal: AbortSignal;
    showError: (message: string) => void;
}

export const hostSupportsManagers = (): boolean => kute.hostFeatures?.includes("script-manager") ?? false;

export interface DroppedFile {
    path: string;
    file: File;
}

const dropTargets: WeakMap<HTMLElement, (files: DroppedFile[]) => void> = new WeakMap();

const MAX_DROPPED_FILES = 5000;

export function makeDropTarget(element: HTMLElement, onDrop: (files: DroppedFile[]) => void): void{
    dropTargets.set(element, onDrop);
}

function collectDropped(dataTransfer: DataTransfer): Promise<DroppedFile[]>{
    const entries = [...dataTransfer.items]
        .filter((item) => item.kind === "file")
        .map((item) => item.webkitGetAsEntry())
        .filter((entry) => entry !== null);
    if (!entries.length) return Promise.resolve([...dataTransfer.files].map((file) => ({ path: file.name, file })));

    const found: DroppedFile[] = [];
    const walk = async(entry: FileSystemEntry): Promise<void> => {
        if (found.length >= MAX_DROPPED_FILES) return;
        if (entry.isFile){
            const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
            found.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
            return;
        }
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;){
            const batch: FileSystemEntry[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            if (!batch.length) break;
            for (const child of batch) await walk(child);
        }
    };
    return Promise.all(entries.map(walk)).then(() => found);
}

export const readBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = (): void => reject(reader.error);
    reader.readAsDataURL(file);
});

export function openManagerPopup(html: string, { onMessage, canClose, onEscape }: { onMessage: (data: any) => void; canClose?: () => boolean; onEscape?: () => boolean; }): ManagerPopup{
    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
    const host = document.createElement("div");
    overlay.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${sharedCss}</style>${html}`;

    const controller = new AbortController();
    const { signal } = controller;

    const listener = (event: MessageEvent): void => {
        if (event.data && typeof event.data === "object") onMessage(event.data);
    };
    window.chrome.webview.addEventListener("message", listener);

    const close = (): void => {
        if (signal.aborted || (canClose && !canClose())) return;
        controller.abort();
        window.chrome.webview.removeEventListener("message", listener);
        overlay.remove();
    };

    for (const type of ["keydown", "keyup", "keypress"]){
        shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            const cancel = shadow.querySelector(".askBackdrop [data-cancel]") as HTMLElement|null;
            if (cancel) cancel.click();
            else if (!onEscape?.()) close();
        },
        { signal, capture: true },
    );
    overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close();
    });

    const errorBox = shadow.querySelector("[data-error]") as HTMLElement|null;
    let errorTimer = 0;
    const showError = (message: string): void => {
        if (!errorBox) return;
        errorBox.textContent = message;
        errorBox.hidden = false;
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => {
            errorBox.hidden = true;
        }, 8000);
    };

    let hovered: HTMLElement | null = null;
    const setHovered = (target: HTMLElement | null): void => {
        if (hovered === target) return;
        hovered?.classList.remove("dropHover");
        hovered = target;
        target?.classList.add("dropHover");
    };
    const targetOf = (event: DragEvent): HTMLElement | null => {
        for (const node of event.composedPath()){
            if (node === overlay) break;
            if (node instanceof HTMLElement && dropTargets.has(node)) return node;
        }
        return null;
    };
    overlay.addEventListener("dragover", (event) => {
        event.preventDefault();
        const target = targetOf(event);
        setHovered(target);
        if (event.dataTransfer) event.dataTransfer.dropEffect = target ? "copy" : "none";
    });
    overlay.addEventListener("dragleave", (event) => {
        if (!event.relatedTarget) setHovered(null);
    });
    overlay.addEventListener("drop", (event) => {
        event.preventDefault();
        const target = targetOf(event);
        setHovered(null);
        const onDrop = target && dropTargets.get(target);
        if (!onDrop || !event.dataTransfer) return;
        collectDropped(event.dataTransfer)
            .then((files) => {
                if (files.length) onDrop(files);
            })
            .catch((error) => showError(`Could not read the dropped files: ${error?.message ?? error}`));
    });

    shadow.querySelector("[data-close]")?.addEventListener("click", close);

    document.body.append(overlay);
    return { shadow, close, signal, showError };
}

export function askText(shadow: ShadowRoot, title: string, initial: string, hint = ""): Promise<string | null>{
    const dialog = document.createElement("div");
    dialog.className = "askBackdrop";
    dialog.innerHTML = `<div class="askBox"><div class="askTitle"></div><input class="askInput" spellcheck="false">
        <div class="askHint"></div><div class="askActions"><div class="btn" data-cancel>Cancel</div><div class="btn primary" data-ok>OK</div></div></div>`;
    (dialog.querySelector(".askTitle") as HTMLElement).textContent = title;
    (dialog.querySelector(".askHint") as HTMLElement).textContent = hint;
    const input = dialog.querySelector(".askInput") as HTMLInputElement;
    input.value = initial;
    const popup = shadow.querySelector(".managerPopup") ?? shadow;
    popup.append(dialog);
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(initial.lastIndexOf("/") + 1, dot > 0 ? dot : initial.length);

    return new Promise((resolve) => {
        const finish = (value: string | null): void => {
            dialog.remove();
            resolve(value);
        };
        (dialog.querySelector("[data-ok]") as HTMLElement).onclick = (): void => finish(input.value.trim() || null);
        (dialog.querySelector("[data-cancel]") as HTMLElement).onclick = (): void => finish(null);
        input.onkeydown = (event): void => {
            if (event.key === "Enter") finish(input.value.trim() || null);
        };
    });
}

export function askConfirm(shadow: ShadowRoot, title: string, text: string, confirmLabel: string): Promise<boolean>{
    const dialog = document.createElement("div");
    dialog.className = "askBackdrop";
    dialog.innerHTML = `<div class="askBox"><div class="askTitle"></div><div class="askHint"></div>
        <div class="askActions"><div class="btn" data-cancel>Cancel</div><div class="btn primary" data-ok></div></div></div>`;
    (dialog.querySelector(".askTitle") as HTMLElement).textContent = title;
    (dialog.querySelector(".askHint") as HTMLElement).textContent = text;
    const ok = dialog.querySelector("[data-ok]") as HTMLElement;
    ok.textContent = confirmLabel;
    (shadow.querySelector(".managerPopup") ?? shadow).append(dialog);

    return new Promise((resolve) => {
        const finish = (value: boolean): void => {
            dialog.remove();
            resolve(value);
        };
        ok.onclick = (): void => finish(true);
        (dialog.querySelector("[data-cancel]") as HTMLElement).onclick = (): void => finish(false);
    });
}

export const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
