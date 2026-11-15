import cSettings from "../cSettings.json";
import { kute, globalRef } from "./client";
import { getElement, getInput, checkCompMode } from "./utils";
import { hiddenByPerformance, overridePerformance } from "./performance";
import { setRampBoost } from "./modules/rampBoost";

interface SettingOption {
    id: string;
    name: string;
    type: string;
    category: string;
    defaultValue?: string|number|boolean;
    description?: string;
    needsRestart?: boolean;
    needsRefresh?: boolean;
    button?: string;
    buttonAction?: string;
    requiresLogin?: boolean;
    requires?: string;
    disabledBy?: string;
    hostFeature?: string;
    platforms?: string[];
    performance?: boolean|null;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    html?: string;
}

const debounceTimers: Map<string, number> = new Map();

const BLOCKED_STYLE = "opacity: 0.35; cursor: not-allowed";

const RAW_MOUSE_SETTING = "window.setSetting(\"rawMouse\"";
const RAW_MOUSE_HINT = "Controlled by Kute's Raw Input setting";
const RAW_MOUSE_HINT_LINUX = "Not available on Linux";

const settings = cSettings as Record<string, SettingOption>;

function toggleName(id: string): `toggle${string}`{
    return `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
}

function blockerOf(option: SettingOption): SettingOption | null{
    const blocker = option.disabledBy ? settings[option.disabledBy] : null;
    return blocker && kute.settings.data[blocker.id] === true ? blocker : null;
}

function switchModule(id: string, on: boolean): void{
    const toggle = kute.settings[toggleName(id)];
    if (typeof toggle === "function"){
        toggle(on);
        return;
    }
    if (!on) return;
    try {
        import(`./modules/${id}.ts`).catch(() => {});
    }
    catch {}
}

function applyInterface(id: string, value: string | number | boolean): void{
    switch (id){
        case "exitButton":
            getElement("#clientExit").style.display = `${value ? "flex" : "none"}`;
            break;
        case "menuTimer":
            if (value){
                import("./components/menuTimer.css").then((css) => {
                    const menuTimerCSS = document.createElement("style");
                    menuTimerCSS.id = "kute_menuTimerCSS";
                    menuTimerCSS.textContent = css.default;
                    document.head.append(menuTimerCSS);
                });
            }
            else {
                document.querySelector("#kute_menuTimerCSS")?.remove();
            }
            break;
        case "classicMenu":
            if (value){
                import("./components/classicMenu.css").then((css) => {
                    const classicMenuCSS = document.createElement("style");
                    classicMenuCSS.id = "kute_classicMenuCSS";
                    classicMenuCSS.textContent = css.default;
                    document.head.append(classicMenuCSS);
                });
            }
            else {
                document.querySelector("#kute_classicMenuCSS")?.remove();
            }
            break;
        case "cleanUI": {
            if (value){
                import("./components/clean.css").then((css) => {
                    const cleanCSS = document.createElement("style");
                    cleanCSS.id = "kute_cleanCSS";
                    cleanCSS.textContent = css.default;
                    document.head.append(cleanCSS);
                });
            }
            else {
                document.querySelector("#kute_cleanCSS")?.remove();
            }
            break;
        }
        case "textSelect": {
            if (value){
                const textSelectCSS = document.createElement("style");
                textSelectCSS.id = "kute_textSelectCSS";
                textSelectCSS.textContent = "#chatHolder * { user-select: text }";
                document.head.append(textSelectCSS);
            }
            else {
                document.querySelector("#kute_textSelectCSS")?.remove();
            }
            break;
        }
        default:
            break;
    }
}

function applyBlocker(id: string, blocking: boolean): void{
    for (const dependent of Object.values(settings)){
        if (dependent.disabledBy !== id) continue;
        const on = !blocking && Boolean(kute.settings.data[dependent.id]);

        const input = document.querySelector(`#${dependent.id}`);
        if (input instanceof HTMLInputElement){
            input.checked = on;
            input.disabled = blocking;
            const label = input.closest("label");
            if (label){
                label.style.cssText = blocking ? BLOCKED_STYLE : "";
                label.title = blocking ? `Off while ${settings[id].name} is on` : "";
            }
        }

        switchModule(dependent.id, on);
    }
}

kute.settings.changeSetting = (id: string, rawValue: string | number | boolean, slider: boolean): void => {
    if (rawValue === "") return;

    const input = document.querySelector(`#${id}`);
    if (input instanceof HTMLInputElement){
        input.value = String(rawValue);
        if (input.type === "checkbox") input.checked = rawValue === true;
    }
    let value = rawValue;

    if (typeof value === "string"){
        const numberRegex = /^-?\d*\.?\d+$/;
        if (numberRegex.test(value)){
            if (value.includes(".")) value = Number.parseFloat(value);
            else value = Number.parseInt(value, 10);
        }
    }

    const sliderInput = document.querySelector(`#slid_input_${id}`) as HTMLInputElement|null;
    if (sliderInput && slider){
        sliderInput.value = String(value);

        clearTimeout(debounceTimers.get(id));

        debounceTimers.set(id, setTimeout(() => {
            kute.settings.data[id] = value;
            window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);

            debounceTimers.delete(id);
        }, 500));
        return;
    }

    switch (id){
        case "obsCapturePlugin":
            if (
                value &&
                // eslint-disable-next-line no-alert
                !confirm(
                    "Install the Kute Capture plugin into OBS? OBS must be closed, and Windows may ask for administrator permission.",
                )
            ){
                getInput("#obsCapturePlugin").checked = false;
                return;
            }
            window.chrome.webview.postMessage(`obs-plugin, ${value}`);
            break;
        case "rampBoost":
            if (value){
                if (!checkCompMode()) setRampBoost(true);
            }
            else setRampBoost(false);
            break;
        default:
            applyInterface(id, value);
            break;
    }

    const toggleFunctionName = toggleName(id);
    if (typeof kute.settings[toggleFunctionName] !== "function"){
        try {
            import(`./modules/${id}.ts`).catch(() => {});
        }
        catch {}
    }
    else {
        kute.settings[toggleFunctionName](value);
    }

    kute.settings.data[id] = value;
    window.chrome.webview.postMessage(`set-config, ${id}, ${value}`);
    applyBlocker(id, value === true);
};

const REFRESH_MARK = ' <span style="color: #3244a8" title="Requires Refresh">*</span>';
const RESTART_MARK = ' <span style="color: #eb5656" title="Requires Restart">*</span>';

const topButtons = (): [string, string, string, string][] => {
    const openUrl = (url: string): string => `window.chrome.webview.postMessage('open-url, ${url}')`;
    return [
        ["About", "info", "kuteTopBlue", `${globalRef}.showAboutPopup()`],
        ["Website", "language", "kuteTopBlue", openUrl("https://kute.lol")],
        ["Source Code", "code", "kuteTopPink", openUrl("https://github.com/NullDev/Kute")],
        ["Report Issue", "bug_report", "kuteTopPink", openUrl("https://github.com/NullDev/Kute/issues/choose")],
        ["Manage Swapper", "swap_horiz", "kuteTopOrange", `${globalRef}.swapperManager.open()`],
        ["Manage Userscripts", "extension", "kuteTopOrange", `${globalRef}.userscriptManager.open()`],
    ];
};

class SettingsManager {
    settingsWindow: any = window.windows[0];

    constructor(){
        this.init();
    }
    init(): void{
        const origGetSettings = this.settingsWindow.getSettings;
        this.settingsWindow.getSettings = (...args: any[]): string => {
            const original = this.lockRawMouse(origGetSettings.call(this.settingsWindow, ...args));
            const ours = this.getCSettings();
            if (!ours) return original;
            const closesFirst = original.startsWith("</div>");
            return (closesFirst ? original.slice("</div>".length) : original) + ours + (closesFirst ? "</div>" : "");
        };

        this.settingsWindow.getCSettings = (): string => this.getCSettings();
        kute.settings.togglePerformanceMode = (enabled): void => {
            for (const id of overridePerformance(kute.settings.data, enabled)){
                const value = kute.settings.data[id];
                applyInterface(id, value);
                switchModule(id, value === true && !blockerOf(settings[id]));
            }
            setTimeout(() => this.rerender(), 0);
        };
        kute.openKuteSettings = (): void => {
            window.showWindow(1);
            this.settingsWindow.changeTab(this.settingsWindow.tabs[this.settingsWindow.settingType].length - 1);
        };
        window.chrome.webview.addEventListener("message", (event) => {
            const response = event.data;
            if (response?.type !== "obs-plugin") return;
            if (!response.ok){
                kute.settings.data.obsCapturePlugin = false;
                const checkbox = document.querySelector("#obsCapturePlugin") as HTMLInputElement|null;
                if (checkbox) checkbox.checked = false;
            }
            kute.showNotification(response.message, false, 5);
        });
    }

    rerender(): void{
        const tabs = this.settingsWindow.tabs[this.settingsWindow.settingType];
        if (this.settingsWindow.tabIndex === tabs.length - 1 || this.settingsWindow.settingSearch) this.settingsWindow.changeTab(this.settingsWindow.tabIndex);
    }

    lockRawMouse(html: string): string{
        const anchor = html.indexOf(RAW_MOUSE_SETTING);
        if (anchor < 0) return html;
        const tagStart = html.lastIndexOf("<input", anchor);
        const tagEnd = html.indexOf(">", anchor);
        const label = html.lastIndexOf("<label", anchor);
        if (tagStart < 0 || tagEnd < 0 || label < 0) return html;
        const labelEnd = html.indexOf(">", label);
        if (labelEnd < 0 || labelEnd > tagStart) return html;
        const input = html.slice(tagStart, tagEnd).replace(/\s+checked\b/, "")
            + (kute.settings.data.rawInput && kute.platform !== "linux" ? " checked" : "") + " disabled>";
        const hint = kute.platform === "linux" ? RAW_MOUSE_HINT_LINUX : RAW_MOUSE_HINT;
        return html.slice(0, labelEnd) + ` title="${hint}">`
            + html.slice(labelEnd + 1, tagStart) + input + html.slice(tagEnd + 1);
    }

    searchMatches(setting: SettingOption): boolean{
        const query = this.settingsWindow.settingSearch.toLowerCase() || "";
        return [setting.name, setting.category, setting.description ?? ""].some((text) => text.toLowerCase().includes(query));
    }

    generateHtml(option: SettingOption): string{
        const value = kute.settings.data[option.id];
        const buttonAction = option.buttonAction?.replaceAll("{{kute}}", globalRef).replaceAll('"', "&quot;") ?? "";
        const locked = option.requiresLogin && document.querySelector("#signedInHeaderBar") === null;
        let button = "";
        const gap = option.type === "checkbox" ? "margin-right: 8px; " : "";
        if (option.button && locked){
            button = `<div class="settingsBtn" style="${gap}width: auto; opacity: 0.35; cursor: not-allowed" title="Log in first">${option.button}</div>`;
        }
        else if (option.button){
            button = `<div class="settingsBtn" style="${gap}width: auto" onclick="${buttonAction}">${option.button}</div>`;
        }
        switch (option.type){
            case "checkbox": {
                const blocker = blockerOf(option);
                if (blocker){
                    return `<label class='switch' style="${BLOCKED_STYLE}" title="Off while ${blocker.name} is on">
                        <input id="${option.id}" type='checkbox' disabled
                            onclick='${globalRef}.settings.changeSetting("${option.id}", this.checked, false)'>
                        <span class='slider'></span>
                    </label>
                    ${button}`;
                }
                if (locked){
                    return `<label class='switch' style="${BLOCKED_STYLE}" title="Log in first">
                        <input id="${option.id}" type='checkbox' disabled ${value ? "checked" : ""}>
                        <span class='slider'></span>
                    </label>
                    ${button}`;
                }
                const required = option.requires ? settings[option.requires] : null;
                if (required && kute.settings.data[required.id] === false){
                    return `<label class='switch' style="${BLOCKED_STYLE}" title="Needs ${required.name}, which is off">
                        <input id="${option.id}" type='checkbox' disabled ${value ? "checked" : ""}>
                        <span class='slider'></span>
                    </label>
                    ${button}`;
                }
                return `<label class='switch'>
                    <input id="${option.id}" type='checkbox'
                        onclick='${globalRef}.settings.changeSetting("${option.id}", this.checked, false)'
                        ${value ? "checked" : ""}>
                    <span class='slider'></span>
                </label>
                ${button}`;
            }
            case "slider":
                return `<input type="number" class="sliderVal" id="slid_input_${option.id}" min="${option.min}" value="${value || option.min}"
                    step="${option.step}" oninput='${globalRef}.settings.changeSetting("${option.id}", this.value, true)' style="margin-right:0px;border-width:0px">
                <div class="slidecontainer" style="margin-top: -8px;"><input type="range" id="${option.id}" min="${option.min}" max="${option.max}"
                    step="${option.step}" value="${value}" class="sliderM" oninput='${globalRef}.settings.changeSetting("${option.id}", this.value, true)'></div>`;
            case "select":
                return `<select id="${option.id}" class="inputGrey2" onchange='${globalRef}.settings.changeSetting("${option.id}", this.value, false)'>
                    ${(option.options ?? []).map((opt) => `<option value="${opt}" ${opt === value ? "selected" : ""}>${opt}</option>`).join("")}</select>`;
            case "none":
                return button;
            default:
                return "";
        }
    }

    getCSettings(): string{
        if (
            this.settingsWindow.tabs[this.settingsWindow.settingType].length !== this.settingsWindow.tabIndex + 1 &&
            !this.settingsWindow.settingSearch
        ){
            return "";
        }

        let tempHTML = "<div class='kuteSettings'>";
        if (!this.settingsWindow.settingSearch){
            tempHTML += `<div class="kuteTopButtons">${topButtons()
                .map(([label, icon, color, action]) => `<div class="kuteTopButton ${color}" onclick="${action.replaceAll('"', "&quot;")}">
                    ${label}<span class="material-icons">${icon}</span></div>`)
                .join("")}</div>`;
        }
        const banner = kute.settings.data.performanceMode === true && kute.hostFeatures?.includes(settings.performanceMode.hostFeature ?? "");
        if (banner){
            tempHTML += `<div class="kuteHiddenBanner"><span class="material-icons">warning</span>
                <div>Some settings are hidden because "${settings.performanceMode.name}" is on. Turn it off in General to see them again.</div></div>`;
        }
        let previousCategory = null;
        let rendered = false;

        for (const setting of Object.values(settings)){
            if (setting.hostFeature && !kute.hostFeatures?.includes(setting.hostFeature)) continue;
            if (setting.platforms && !setting.platforms.includes(kute.platform ?? "windows")) continue;
            if (hiddenByPerformance(kute.settings.data, setting.id)) continue;
            if (this.settingsWindow.settingSearch && !this.searchMatches(setting)) continue;

            setting.html = this.generateHtml(setting);

            if (previousCategory !== setting.category){
                if (previousCategory) tempHTML += "</div>";

                const legend = previousCategory === null
                    ? `<span class="kuteLegend">${REFRESH_MARK} Requires refresh ${RESTART_MARK} Requires restart</span>`
                    : "";
                previousCategory = setting.category;
                tempHTML += `<div class='setHed' id="setHed_kute_${setting.category}" onclick='window.windows[0].collapseFolder(this)'>
										<span class='material-icons plusOrMinus'>keyboard_arrow_down</span> ${setting.category}${legend}</div>
										<div class='setBodH' id="setBod_kute_${setting.category}">`;
            }

            rendered = true;
            tempHTML += `<div class='settName'>
								${setting.name.replaceAll("{{version}}", kute.version ?? "")}
								${setting.needsRestart ? RESTART_MARK : ""}
								${setting.needsRefresh ? REFRESH_MARK : ""}
								${setting.html}
								${setting.description ? `<div class="kuteDesc">${setting.description.replaceAll("<", "&lt;")}</div>` : ""}</div>`;
        }

        if (rendered) return `${tempHTML}</div></div>`;
        return banner ? `${tempHTML}</div>` : "";
    }
}

export default new SettingsManager();
