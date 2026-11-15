import { kute } from "../client";
import { claimAltShoot, syncLeftClick } from "./leftClick";

window.chrome.webview.postMessage("drag, true");
window.chrome.webview.postMessage("throttle, menu");

const originalExportSettings = window.exportSettings;
window.exportSettings = (asString?: boolean): any => {
    if (!asString) kute.showNotification("Settings exported to Downloads!", false, 3);
    return originalExportSettings(asString);
};

const originalshowWindow = window.showWindow;
window.showWindow = (...args: any[]): any => {
    const number = args[0];
    switch (number){
        case 3:
        case 53:
            window.chrome.webview.postMessage("throttle, game");
            break;
        case 15:
        case 26:
        case 52:
        case 9:
        case 44:
        case 43:
        case 40:
        case 38:
        case 50:
        case 17:
        case 39:
        case 51:
        case 16:
        case 34:
            window.chrome.webview.postMessage("throttle, menu");
            break;
        default:
            break;
    }
    return originalshowWindow(...args);
};

const originalclosWind = window.closWind;
window.closWind = (...args: any[]): any => {
    window.chrome.webview.postMessage("drag, true");
    window.chrome.webview.postMessage("throttle, menu");
    return originalclosWind(...args);
};

kute.bindShoot = (): void => {
    if (claimAltShoot()){
        window.changeCont("shoot", 1, undefined);
        const eventOptions = {
            key: "F20",
            code: "F20",
            keyCode: 131,
            which: 131,
            bubbles: true,
            cancelable: true,
        };
        window.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
        window.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
    }
    syncLeftClick();
};
