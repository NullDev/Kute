import panelHtml from "../../components/kuteIcons.html";
import { kute } from "../../client";
import { confirmPopup } from "../confirmPopup";
import { SLOTS, postUrls, type IconSlot, type HidingSetting } from "./slots";

const PREVIEW = "https://krunker.io/kute-icons/";
const SLOTS_SETTING = "kuteIconSlots";

function chosenSlots(): Record<string, boolean>{
    const chosen = kute.settings.data[SLOTS_SETTING];
    return chosen && typeof chosen === "object" ? chosen : {};
}

function hostSupports(): boolean{
    return kute.hostFeatures?.includes("kute-icons") ?? false;
}

function slotOn(slot: IconSlot): boolean{
    return chosenSlots()[slot.id] !== false;
}

function hidingSettings(slot: IconSlot): HidingSetting[]{
    return slot.hiddenBy.filter((setting) => {
        let value = null;
        try {
            value = localStorage.getItem(`kro_setngss_${setting.id}`);
        }
        catch {
            return false;
        }
        if (value === null) return false;
        return setting.kind === "checkbox" ? value === "false" : Number(value) === 0;
    });
}

function describe(setting: HidingSetting): string{
    return setting.kind === "checkbox" ? `${setting.name} is off` : `${setting.name} is 0`;
}

async function offerReload(what: string): Promise<void>{
    const now = await confirmPopup({
        title: "Reload the game?",
        paragraphs: [what, "The game keeps the images it already loaded, so this shows after a reload. Nothing else changes, and you can do it later."],
        stay: "Later",
        leave: "Reload now",
    });
    if (now) window.chrome.webview.postMessage("hard-reload");
}

class KuteIcons {
    asking = false;
    watched: WeakSet<Element> = new WeakSet();

    constructor(){
        kute.kuteIcons = {
            customize: (): void => this.customize(),
            refresh: (): void => this.refresh(),
        };
        kute.settings.toggleKuteIcons = (enabled): Promise<void> => this.onToggle(!!enabled);

        this.refresh();
        document.addEventListener("pointerlockchange", () => {
            if (document.pointerLockElement) setTimeout(() => this.refresh(), 1500);
        });
    }

    refresh(): void{
        for (const slot of SLOTS){
            const element = slot.element ? document.getElementById(slot.element) : null;
            if (!element || this.watched.has(element)) continue;
            this.watched.add(element);
            new MutationObserver(() => postUrls()).observe(element, { attributes: true, attributeFilter: ["src"] });
        }
        postUrls();
    }

    async onToggle(enabled: boolean): Promise<void>{
        postUrls();
        if (!hostSupports()){
            if (enabled) kute.showNotification("Kute icons need a newer Kute, update the client", false, 4);
            return;
        }
        if (enabled) await this.warnHidden(SLOTS.filter(slotOn));
        await offerReload(enabled ? "Kute icons are on." : "Kute icons are off, your own icons are back.");
    }

    async warnHidden(slots: IconSlot[]): Promise<boolean>{
        const settings: Map<string, HidingSetting> = new Map();
        const lines = [];
        for (const slot of slots){
            const hiding = hidingSettings(slot);
            if (hiding.length === 0) continue;
            for (const setting of hiding) settings.set(setting.id, setting);
            lines.push(`${slot.name}: ${hiding.map((setting) => describe(setting)).join(", ")}`);
        }
        if (lines.length === 0) return false;

        this.asking = true;
        const turnOn = await confirmPopup({
            title: "Hidden by your Krunker settings",
            paragraphs: [
                lines.length === 1 ? "This Kute icon will not show:" : "These Kute icons will not show:",
                ...lines,
                "Switch those Krunker settings on for you?",
            ],
            stay: "Leave them",
            leave: "Switch on",
        }).finally(() => {
            this.asking = false;
        });
        if (!turnOn) return false;

        for (const setting of settings.values()) window.setSetting(setting.id, setting.kind === "checkbox" ? true : "1");
        kute.showNotification("Switched on in your Krunker settings", false, 3);
        return true;
    }

    customize(): void{
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = panelHtml;

        const element = (id: string): HTMLElement => (shadow.querySelector(`#${id}`) as HTMLElement);

        const supported = hostSupports();
        const on = kute.settings.data.kuteIcons === true;
        let hint = "Ticked icons show Kute's version. Your Krunker settings stay as they are.";
        if (!on) hint = "Use Kute Icons is off, so none of these show yet.";
        if (!supported) hint = "This needs a newer Kute. Update the client to use Kute icons.";
        element("kiHint").textContent = hint;

        let changed = false;
        const rows: { slot: IconSlot; box: HTMLInputElement; note: HTMLElement; }[] = [];

        const renderNotes = (): void => {
            for (const { slot, box, note } of rows){
                const hiding = box.checked ? hidingSettings(slot) : [];
                note.replaceChildren();
                if (hiding.length === 0) continue;
                note.append(`Hidden: ${hiding.map((setting) => describe(setting)).join(", ")} `);
                const show = document.createElement("span");
                show.className = "kiShow";
                show.textContent = "Show it";
                show.onclick = async(event): Promise<void> => {
                    event.preventDefault();
                    event.stopPropagation();
                    await this.warnHidden([slot]);
                    renderNotes();
                };
                note.append(show);
            }
        };

        const choose = (slot: IconSlot, value: boolean): void => {
            changed = true;
            const chosen = { ...chosenSlots(), [slot.id]: value };
            kute.settings.data[SLOTS_SETTING] = chosen;
            window.chrome.webview.postMessage(`set-config-json ${SLOTS_SETTING} ${JSON.stringify(chosen)}`);
        };

        for (const slot of SLOTS){
            const row = document.createElement("label");
            row.className = "kiRow";
            const image = document.createElement("img");
            image.src = PREVIEW + slot.file;
            image.alt = "";
            const name = document.createElement("span");
            name.textContent = slot.name;
            const note = document.createElement("span");
            note.className = "kiHidden";
            name.append(note);
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = slotOn(slot);
            box.onchange = async(): Promise<void> => {
                choose(slot, box.checked);
                if (box.checked) await this.warnHidden([slot]);
                renderNotes();
            };
            row.append(image, name, box);
            element("kiRows").append(row);
            rows.push({ slot, box, note });
        }
        renderNotes();

        element("kiAll").onclick = async(): Promise<void> => {
            const ticked = rows.filter(({ box }) => !box.checked);
            for (const { slot, box } of ticked){
                box.checked = true;
                choose(slot, true);
            }
            await this.warnHidden(ticked.map(({ slot }) => slot));
            renderNotes();
        };

        const controller = new AbortController();
        const close = (): void => {
            controller.abort();
            overlay.remove();
            if (changed && supported && kute.settings.data.kuteIcons === true) offerReload("Your Kute icons changed.");
        };
        element("kiDone").onclick = close;
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape" || this.asking) return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );
        document.body.append(overlay);
    }
}

export default new KuteIcons();
