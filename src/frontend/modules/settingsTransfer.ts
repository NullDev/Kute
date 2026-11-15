import cSettings from "../../cSettings.json";
import { kute } from "../client";
import { playerValues } from "../performance";
import { confirmPopup } from "./confirmPopup";

const FORMAT = "kute-settings";
const VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_VALUE_CHARS = 16 * 1024;

const OBJECT_SETTINGS: string[] = ["hudLayout", "matchmakerFilter", "hotkeys", "nukeCounterConfig", "customSkyConfig", "kuteIconSlots", "kuteIconUrls"];

interface SettingDef {
    id: string;
    defaultValue?: any;
    type?: string;
    options?: string[];
}

const VALUE_SETTINGS: SettingDef[] = Object.values(cSettings as Record<string, SettingDef>).filter((setting) => "defaultValue" in setting);

function acceptable(id: string, value: any): boolean{
    if (JSON.stringify(value)?.length > MAX_VALUE_CHARS) return false;
    if (OBJECT_SETTINGS.includes(id)) return value === null || (typeof value === "object" && !Array.isArray(value));
    const setting = VALUE_SETTINGS.find((candidate) => candidate.id === id);
    if (!setting || typeof value !== typeof setting.defaultValue) return false;
    if (setting.options && !setting.options.includes(value)) return false;
    return typeof value !== "number" || Number.isFinite(value);
}

function today(): string{
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

class SettingsTransfer {
    constructor(){
        kute.settingsTransfer = {
            exportFile: (): void => this.export(),
            importFile: (): void => this.pick(),
        };
    }

    export(): void{
        const data = playerValues(kute.settings.data);
        const ids = [...VALUE_SETTINGS.map((setting) => setting.id), ...OBJECT_SETTINGS];
        const settings = Object.fromEntries(ids.filter((id) => data[id] !== undefined).map((id) => [id, data[id]]));
        const file = { format: FORMAT, version: VERSION, kute: kute.version, exported: today(), settings };

        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
        link.download = `kute-settings-${today()}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        kute.showNotification(`Exported ${Object.keys(settings).length} settings to your Downloads folder`, false, 4);
    }

    pick(): void{
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = (): void => {
            const file = input.files?.[0];
            if (file) this.read(file).catch((error) => console.error("[kute] settings import:", error));
        };
        input.click();
    }

    async read(file: File): Promise<void>{
        if (file.size > MAX_FILE_BYTES){
            kute.showNotification("That file is too big for a Kute settings file", false, 4);
            return;
        }
        let parsed: any = null;
        try {
            parsed = JSON.parse(await file.text());
        }
        catch {
            parsed = null;
        }
        if (parsed?.format !== FORMAT || typeof parsed.settings !== "object" || parsed.settings === null){
            kute.showNotification("That is not a Kute settings file", false, 4);
            return;
        }
        if (typeof parsed.version !== "number" || parsed.version > VERSION){
            kute.showNotification("That file comes from a newer Kute, update first", false, 4);
            return;
        }

        const entries = Object.entries(parsed.settings as Record<string, any>).filter(([id, value]) => acceptable(id, value));
        if (entries.length === 0){
            kute.showNotification("That file holds no settings this Kute knows", false, 4);
            return;
        }
        const from = typeof parsed.kute === "string" ? ` from Kute ${parsed.kute}` : "";
        const confirmed = await confirmPopup({
            title: "Import Kute settings",
            paragraphs: [
                `${entries.length} settings${from} in ${file.name}.`,
                "They replace your client settings, HUD positions, matchmaker filters and hotkeys. Kute restarts to apply them.",
                "Userscripts, swapper files, custom CSS and your own sky images are files in Documents\\kute and are not part of it.",
            ],
            stay: "Cancel",
            leave: "Import and restart",
        });
        if (!confirmed) return;

        for (const [id, value] of entries){
            kute.settings.data[id] = value;
            window.chrome.webview.postMessage(`set-config-json ${id} ${JSON.stringify(value)}`);
        }
        window.chrome.webview.postMessage("restart");
    }
}

export default new SettingsTransfer();
