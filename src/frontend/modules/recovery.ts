import html from "../components/recovery.html";
import { kute } from "../client";
import { confirmPopup } from "./confirmPopup";

const send = (command: string): void => window.chrome.webview.postMessage(`recovery-${command}`);

class Recovery {
    host: HTMLDivElement | null = null;
    shadow: ShadowRoot | null = null;

    constructor(){
        document.addEventListener("pointerlockchange", () => {
            if (this.host) this.host.style.display = document.pointerLockElement ? "none" : "flex";
        });
        window.chrome.webview.addEventListener("message", (event) => {
            if (event.data?.recovery) this.show(event.data.recovery);
        });
        if (kute.recovery) this.show(kute.recovery);
    }

    banner(title: string, body: string, actions: [string, string, boolean?][]): void{
        if (!this.host){
            this.host = document.createElement("div");
            this.host.style.cssText = "position:fixed;top:12px;left:0;right:0;display:flex;justify-content:center;pointer-events:none;z-index:2147482000";
            this.shadow = this.host.attachShadow({ mode: "open" });
            this.shadow.innerHTML = html;
            document.body.append(this.host);
        }
        const { shadow } = this as { shadow: ShadowRoot };
        (shadow.querySelector("#rcTitle") as HTMLElement).textContent = title;
        (shadow.querySelector("#rcBody") as HTMLElement).textContent = body;
        const row = shadow.querySelector("#rcActions") as HTMLElement;
        row.replaceChildren();
        for (const [label, command, main] of actions){
            const button = document.createElement("div");
            button.className = main ? "rcButton rcMain" : "rcButton";
            button.textContent = label;
            button.onclick = (): void => send(command);
            row.append(button);
        }
    }

    show(info: RecoveryInfo): void{
        if (info.mode === "safe"){
            const actions: [string, string, boolean?][] = [["Restart normally", "normal", !info.canFind]];
            if (info.canFind) actions.unshift(["Find the cause", "find", true]);
            this.banner("Safe mode:", "your userscripts, swaps, custom CSS, flags and engine tweaks are off for this start. Nothing of yours was changed.", actions);
        }
        else if (info.mode === "test"){
            const left = `${info.suspects} ${info.suspects === 1 ? "thing" : "things"} left to check.`;
            if (info.ranFine) this.banner(`Finding the cause, test ${info.step}:`, `this test passed, ${left} Restart for the next one.`, [["Next test", "next", true], ["Stop", "stop"]]);
            else if (info.kind === "startup") this.banner(`Finding the cause, test ${info.step}:`, `${left} Kute restarts by itself, nothing to do.`, [["Stop", "stop"]]);
            else this.banner(`Finding the cause, test ${info.step}:`, `${left} Play as usual. After ${info.minutes} min without a crash this test passes.`, [["Stop", "stop"]]);
        }
        else if (info.mode === "result") this.result(info).catch((error) => console.error("[kute] recovery:", error));
        else if (info.mode === "offer") this.offer().catch((error) => console.error("[kute] recovery:", error));
    }

    async result(info: RecoveryInfo): Promise<void>{
        const ran = `${info.tests?.crashed ?? 0} tests crashed, ${info.tests?.ranFine ?? 0} ran fine.`;
        if (info.verdict === "notTheSetup"){
            const report = !(await confirmPopup({
                title: "Not your setup",
                paragraphs: [
                    "Kute crashed even with everything of yours switched off, so it is most likely a driver, the PC or another program.",
                    "A Diagnostics Report (About settings) helps us look into it.",
                    ran,
                ],
                stay: "Create a report",
                leave: "Close",
            }));
            send("dismiss");
            if (report) kute.diagnostics?.open();
            return;
        }
        const culprits = info.culprits ?? [];
        const fixable = culprits.every((culprit) => culprit.fixable);
        const keepOff = !(await confirmPopup({
            title: "Found the cause",
            paragraphs: [
                `Kute crashed with ${culprits.length === 1 ? "this" : "these together"} and ran fine without:`,
                ...culprits.map((culprit) => culprit.label),
                fixable
                    ? "It is off for this start. Switch it off for good, or keep it and Kute starts with it again next time."
                    : "It is off for this start. To keep it off, remove it from the file in Documents\\kute.",
                ran,
            ],
            stay: fixable ? "Switch it off" : "OK",
            leave: "Keep it",
        }));
        send(keepOff && fixable ? "apply" : "dismiss");
        if (keepOff && fixable) kute.showNotification("Switched off", false, 3);
    }

    async offer(): Promise<void>{
        const safe = !(await confirmPopup({
            title: "Kute crashed the last times it ran",
            paragraphs: ["Safe mode starts without your userscripts, swaps, custom CSS, flags and engine tweaks, and can find which one causes it. Nothing of yours gets changed."],
            stay: "Restart in safe mode",
            leave: "Not now",
        }));
        send(safe ? "safe" : "dismiss");
    }
}

export default new Recovery();
