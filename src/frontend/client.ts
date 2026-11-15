import cSettings from "../cSettings.json";
import { overridePerformance } from "./performance";

function randomKey(length: number): string{
    const chars = "abcdefghijklmnopqrstuvwxyz";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

export const kute: Kute = {} as Kute;

export const ready: Promise<Kute> = new Promise((resolve) => {
    function handler(event: MessageEvent): void{
        if (event?.data?.settings || event?.data?.version){
            window.chrome.webview.removeEventListener("message", handler);
            Object.assign(kute, event.data);
            if (kute.settings?.data){
                for (const setting of Object.values(cSettings as Record<string, { id: string, defaultValue?: unknown }>)){
                    if (setting.defaultValue !== undefined && !(setting.id in kute.settings.data)) kute.settings.data[setting.id] = setting.defaultValue;
                }
            }
            if (kute.settings?.data) overridePerformance(kute.settings.data, kute.settings.data.performanceMode === true);
            resolve(kute);
        }
    }

    window.chrome.webview.addEventListener("message", handler);
    window.chrome.webview.postMessage("get-info");
});

const globalKey = randomKey(12);
Object.defineProperty(window, globalKey, {
    value: kute,
    enumerable: false,
    writable: false,
    configurable: false,
});

export const globalRef = `window["${globalKey}"]`;
