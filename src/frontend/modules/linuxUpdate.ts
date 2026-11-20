import { kute } from "../client";
import { confirmPopup } from "./confirmPopup";

const ASKED_KEY = "kute_update_asked";
const READY_KEY = "kute_update_ready";
const PROGRESS_STEPS = [0.25, 0.5, 0.75];

interface UpdateState {
    stage: "offer" | "downloading" | "ready" | "failed";
    version: string;
    current?: string;
    install?: boolean;
    size?: number | null;
    done?: number;
    total?: number;
    error?: string;
}

const inMenu = (): Promise<void> => new Promise((resolve) => {
    const check = (): void => {
        if (!document.pointerLockElement) resolve();
        else setTimeout(check, 2000);
    };
    check();
});

const megabytes = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;

class LinuxUpdate {
    step = 0;
    busy = false;

    constructor(){
        if (kute.platform !== "linux" || !kute.hostFeatures?.includes("appimage-update")) return;

        window.chrome.webview.addEventListener("message", (event) => {
            const update = (event.data as { update?: UpdateState })?.update;
            if (update && typeof update === "object") this.receive(update).catch(() => {});
        });
        window.chrome.webview.postMessage("update-state");
    }

    async receive(update: UpdateState): Promise<void>{
        if (update.stage === "offer") await this.offer(update);
        else if (update.stage === "downloading") this.progress(update);
        else if (update.stage === "ready") await this.ready(update);
        else if (update.stage === "failed"){
            kute.showNotification(`The update to Kute ${update.version} failed: ${update.error ?? "unknown error"}`, false, 8);
        }
    }

    async offer(update: UpdateState): Promise<void>{
        if (this.busy || sessionStorage.getItem(ASKED_KEY) === update.version) return;
        this.busy = true;
        await inMenu();
        sessionStorage.setItem(ASKED_KEY, update.version);
        const install = update.install === true;
        const yes = await confirmPopup({
            title: `Kute ${update.version} is out`,
            paragraphs: install
                ? [
                    `You have ${update.current}. The update${update.size ? ` (${megabytes(update.size)})` : ""} downloads while you play.`,
                    "It replaces your Kute AppImage and starts the next time you open Kute.",
                ]
                : [
                    `You have ${update.current}.`,
                    "This copy of Kute does not run as an AppImage and cannot update itself. The download page has the new version.",
                ],
            stay: "Later",
            leave: install ? "Update" : "Open download page",
        });
        this.busy = false;
        if (!yes) return;
        window.chrome.webview.postMessage(install ? "update-install" : "update-page");
        if (install) kute.showNotification(`Downloading Kute ${update.version}`, false, 4);
    }

    progress(update: UpdateState): void{
        if (!update.total || !update.done) return;
        const share = update.done / update.total;
        while (this.step < PROGRESS_STEPS.length && share >= PROGRESS_STEPS[this.step]){
            kute.showNotification(`Downloading Kute ${update.version}: ${Math.round(PROGRESS_STEPS[this.step] * 100)} %`, false, 3);
            this.step++;
        }
    }

    async ready(update: UpdateState): Promise<void>{
        if (sessionStorage.getItem(READY_KEY) === update.version) return;
        await inMenu();
        sessionStorage.setItem(READY_KEY, update.version);
        const restart = await confirmPopup({
            title: `Kute ${update.version} is ready`,
            paragraphs: ["It starts the next time you open Kute. Restart now to use it right away."],
            stay: "Later",
            leave: "Restart now",
        });
        if (restart) window.chrome.webview.postMessage("update-restart");
    }
}

export default new LinuxUpdate();
