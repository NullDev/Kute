import { kute } from "../../client";
import html from "../../components/managers/userscripts.html";
import { registry, canLoadLive, loadScripts } from "./registry";
import { openManagerPopup, makeDropTarget, askText, askConfirm, hostSupportsManagers, formatSize, type ManagerPopup, type DroppedFile } from "./popup";
import { createEditorView, type CodeEditor } from "./editor";

export interface ListedScript {
    key: string;
    group: string;
    file: string;
    enabled: boolean;
    runAt: string;
    priority: number;
    meta: Record<string, string>;
    size: number;
}

interface ListedGroup {
    id: string;
    label: string;
    runs: string;
    scripts: ListedScript[];
}

interface OpenEditor {
    group: string;
    file: string;
    editor: CodeEditor;
    closeAfterSave: boolean;
}

const MAX_SCRIPT_SIZE = 4 * 1024 * 1024;

const TEMPLATE = `// ==UserScript==
// @name        {{name}}
// @author
// @version     1.0
// @desc
// @run-at      document-end
// ==/UserScript==

this._console.log("{{name}} is running");

// undo everything the script did, so it can be switched off without a refresh
this.unload = () => {};

return this;
`;

const element = (tag: string, className = "", text = ""): HTMLElement => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text) created.textContent = text;
    return created;
};

const iconButton = (icon: string, title: string, onClick: () => void, extraClass = ""): HTMLElement => {
    const button = element("div", `iconBtn ${extraClass}`);
    button.title = title;
    button.append(element("span", "mi", icon));
    button.onclick = onClick;
    return button;
};

class UserscriptManager {
    popup: ManagerPopup | null = null;
    groups: ListedGroup[] = [];
    openSettings: Set<string> = new Set();
    editing: OpenEditor | null = null;
    pendingRead: string | null = null;
    pendingSave: { closeAfter: boolean } | null = null;
    needsRefresh = false;
    renderQueued = false;
    forceClose = false;
    prefsTimers: Map<string, number> = new Map();

    constructor(){
        if (registry) registry.onChange = (): void => this.queueRender();
        kute.userscriptManager.masterChanged = (on): void => this.onMasterChanged(on);
    }

    masterOn(): boolean{
        return kute.settings?.data?.userscripts !== false;
    }

    onMasterChanged(on: boolean): void{
        if (on && !registry){
            this.needsRefresh = true;
        }
        else if (on && !canLoadLive()){
            for (const script of this.groups.filter((group) => group.id === "game").flatMap((group) => group.scripts)){
                const entry = this.entryFor(script.key);
                if (!entry || !script.enabled) continue;
                entry.start();
                if (entry.tainted || (entry.state !== "running" && entry.state !== "waiting" && entry.state !== "error")) this.needsRefresh = true;
            }
        }
        this.updateNotice();
        if (!this.editing) this.render();
    }

    reload(keys: string[]): boolean{
        if (!keys.length) return true;
        if (!canLoadLive()) return false;
        loadScripts(keys, true, this.masterOn());
        return true;
    }

    applyMaster(): void{
        const shadow = this.popup?.shadow;
        if (!shadow) return;
        const on = this.masterOn();
        shadow.querySelector(".managerPopup")?.classList.toggle("scriptsOff", !on);
        const master = shadow.querySelector("#usMaster");
        if (!master) return;
        master.classList.toggle("on", on);
        master.querySelector(".toggle")?.classList.toggle("on", on);
        (master.querySelector("span") as HTMLElement).textContent = on ? "Userscripts on" : "Userscripts off";
    }

    open(): void{
        if (this.popup) return;
        if (!hostSupportsManagers()){
            window.chrome.webview.postMessage("open, userscripts");
            kute.showNotification("This Kute version can only open the scripts folder. Update Kute for the script manager.", false, 6);
            return;
        }

        this.popup = openManagerPopup(html, {
            onMessage: (data) => this.receive(data),
            canClose: () => this.canClose(),
            onEscape: () => {
                if (!this.editing) return false;
                this.leaveEditor();
                return true;
            },
        });
        this.popup.signal.addEventListener("abort", () => {
            this.popup = null;
            this.editing = null;
            this.forceClose = false;
        });
        const { shadow } = this.popup;
        (shadow.querySelector("#usFolder") as HTMLElement).onclick = (): void => this.send("reveal", {});
        (shadow.querySelector("#usRefreshNow") as HTMLElement).onclick = (): void => location.reload();
        (shadow.querySelector("#usMaster") as HTMLElement).onclick = (): void => kute.settings.changeSetting("userscripts", !this.masterOn(), false);
        this.applyMaster();
        this.body().textContent = "Loading...";
        this.send("list", {});
    }

    send(command: string, payload: object): void{
        window.chrome.webview.postMessage(`scripts-${command} ${JSON.stringify(payload)}`);
    }

    body(): HTMLElement{
        return this.popup?.shadow.querySelector("#usBody") as HTMLElement;
    }

    receive(data: any): void{
        if (data.managerError){
            this.popup?.showError(data.managerError);
            if (this.pendingSave) this.pendingSave = null;
        }
        if (data.userscripts){
            this.groups = data.userscripts.groups ?? [];
            if (this.pendingSave && this.editing){
                const { closeAfter } = this.pendingSave;
                this.pendingSave = null;
                this.editing.editor.markSaved();
                if (this.editing.group === "game" && !this.reload([this.editing.file])) this.needsRefresh = true;
                if (closeAfter) this.editing = null;
            }
            if (!this.editing) this.render();
            this.updateNotice();
        }
        if (data.userscriptSource && data.userscriptSource.key === this.pendingRead){
            this.pendingRead = null;
            const script = this.findScript(data.userscriptSource.key);
            if (script && typeof data.userscriptSource.content === "string"){
                this.showEditor(script.group, script.file, data.userscriptSource.content);
            }
            else this.popup?.showError("The script could not be read.");
        }
    }

    findScript(key: string): ListedScript | undefined{
        for (const group of this.groups){
            const script = group.scripts.find((candidate) => candidate.key === key);
            if (script) return script;
        }
        return undefined;
    }

    entryFor(key: string): ScriptEntry | undefined{
        return registry?.entries?.find((entry) => entry.key === key);
    }

    queueRender(): void{
        if (!this.popup || this.renderQueued) return;
        this.renderQueued = true;
        queueMicrotask(() => {
            this.renderQueued = false;
            this.updateNotice();
            if (this.popup && !this.editing) this.render();
        });
    }

    updateNotice(): void{
        const notice = this.popup?.shadow.querySelector("#usRefresh") as HTMLElement | null;
        if (!notice) return;
        const on = this.masterOn();
        const stuck = registry?.entries?.some((entry) => entry.outdated || (!on && entry.state === "running"));
        notice.hidden = !this.needsRefresh && !stuck;
    }

    render(): void{
        const body = this.body();
        if (!body || !this.popup) return;
        this.applyMaster();
        body.textContent = "";
        for (const group of this.groups) body.append(this.renderGroup(group));
    }

    renderGroup(group: ListedGroup): HTMLElement{
        const section = element("div", "group");
        const head = element("div", "groupHead");
        head.append(element("div", "groupTitle", group.label), element("div", "groupRuns", `runs in ${group.runs}`));
        const create = element("div", "btn small");
        create.append(element("span", "mi", "add"), "New script");
        create.onclick = (): Promise<void> => this.createScript(group.id);
        head.append(create);
        section.append(head);

        if (group.scripts.length === 0) section.append(element("div", "empty", "No scripts yet."));
        for (const script of group.scripts) this.renderScript(section, group, script);

        section.append(element("div", "dropZone", `Drop .js files here to add them to ${group.label}`));
        makeDropTarget(section, (files) => this.importFiles(group, files));
        return section;
    }

    async importFiles(group: ListedGroup, files: DroppedFile[]): Promise<void>{
        if (!this.popup) return;
        const problems: string[] = [];
        const scripts = files.filter(({ file }) => {
            if (!/\.js$/i.test(file.name)) problems.push(`${file.name}: not a .js file`);
            else if (file.size > MAX_SCRIPT_SIZE) problems.push(`${file.name}: larger than 4 MB`);
            else return true;
            return false;
        });
        const existing = new Set(group.scripts.map((script) => script.file.toLowerCase()));
        const replaced = scripts.filter(({ file }) => existing.has(file.name.toLowerCase())).map(({ file }) => file.name);
        if (replaced.length){
            const text = `${replaced.join(", ")} already exist in ${group.label}. Replace them with the dropped files?`;
            if (!await askConfirm(this.popup.shadow, "Replace scripts?", text, "Replace")) return;
        }
        for (const { file } of scripts){
            this.send("write", { group: group.id, file: file.name, content: await file.text(), noList: true });
        }
        this.send("list", {});
        if (group.id === "game" && !this.reload(scripts.map(({ file }) => file.name))) this.needsRefresh = true;
        this.updateNotice();
        if (problems.length) this.popup?.showError(problems.join("\n"));
    }

    stateOf(script: ListedScript, entry: ScriptEntry | undefined, social: boolean): [string, string, string]{
        if (entry?.state === "error") return ["Error", "bad", entry.error];
        if (entry?.outdated) return ["Old version", "warn", "Your changes apply after a refresh, this script has no unload to stop the running version"];
        if (!this.masterOn()){
            if (entry?.state === "running") return ["Until refresh", "warn", "This script has no unload, it stops with the next page load"];
            return script.enabled ? ["On", "", "Runs once userscripts are on"] : ["Off", "", ""];
        }
        if (social || !registry) return script.enabled ? ["On", "ok", ""] : ["Off", "", ""];
        if (script.enabled){
            if (entry?.state === "running") return ["Running", "ok", entry.late ? "Started after the page loaded. It is a document-start script, refresh if it misses something" : ""];
            if (entry?.state === "waiting") return ["Starting", "ok", "Starts once the page has loaded"];
            if (!entry && canLoadLive()) return ["Starting", "ok", ""];
            return ["After refresh", "warn", "On, starts with the next page load"];
        }
        if (entry?.state === "running") return ["Until refresh", "warn", "This script has no unload, it stops with the next page load"];
        return ["Off", "", ""];
    }

    renderScript(section: HTMLElement, group: ListedGroup, script: ListedScript): void{
        const social = group.id !== "game";
        const entry = social ? undefined : this.entryFor(script.key);
        const meta = entry?.meta ?? script.meta;
        const row = element("div", "scriptRow");

        const toggle = element("div", `toggle${script.enabled ? " on" : ""}`);
        toggle.title = script.enabled ? "Turn off" : "Turn on";
        toggle.onclick = (): void => this.toggle(script, entry, social);

        const info = element("div", "scriptInfo");
        const name = element("div", "scriptName", meta.name || script.file);
        if (meta.version) name.append(element("span", "version", `v${meta.version}`));
        if (meta.author) name.append(element("span", "author", `by ${meta.author}`));
        info.append(name);
        const details = [meta.desc, meta.name ? script.file : "", formatSize(script.size)].filter(Boolean).join("  ·  ");
        info.append(element("div", "scriptDesc", details));
        info.title = [meta.desc, `${script.file}, ${script.runAt}${script.priority ? `, priority ${script.priority}` : ""}`].filter(Boolean).join("\n");

        const [label, stateClass, tooltip] = this.stateOf(script, entry, social);
        const state = element("div", `state ${stateClass}`, label);
        if (tooltip) state.title = tooltip;

        const actions = element("div", "scriptActions");
        if (entry?.settings && Object.keys(entry.settings).length){
            actions.append(iconButton("tune", "Script settings", () => {
                if (this.openSettings.has(script.key)) this.openSettings.delete(script.key);
                else this.openSettings.add(script.key);
                this.render();
            }));
        }
        actions.append(
            iconButton("edit", "Edit", () => {
                this.pendingRead = script.key;
                this.send("read", { key: script.key });
            }),
            iconButton("swap_horiz", `Move to ${social ? "Game" : "Social"}`, () => this.move(script, entry, social)),
            iconButton("folder_open", "Show in folder", () => this.send("reveal", { key: script.key })),
            iconButton("delete", "Delete (goes to the recycle bin)", () => this.deleteScript(script, entry), "danger"),
        );

        row.append(toggle, info, state, actions);
        section.append(row);

        if (entry?.settings && this.openSettings.has(script.key)) section.append(this.renderSettings(script, entry));
    }

    toggle(script: ListedScript, entry: ScriptEntry | undefined, social: boolean): void{
        script.enabled = !script.enabled;
        this.send("toggle", { key: script.key, enabled: script.enabled });
        if (!social && this.masterOn()){
            if (!entry){
                if (script.enabled && canLoadLive()) loadScripts([script.key], false, true);
                else if (script.enabled) this.needsRefresh = true;
            }
            else if (script.enabled){
                entry.start();
                if (entry.tainted || (entry.state !== "running" && entry.state !== "waiting" && entry.state !== "error")) this.needsRefresh = true;
            }
            else if (!entry.stop()) this.needsRefresh = true;
        }
        this.updateNotice();
        this.render();
    }

    move(script: ListedScript, entry: ScriptEntry | undefined, social: boolean): void{
        if (entry && !entry.stop() && entry.state === "running") this.needsRefresh = true;
        this.send("move", { key: script.key, group: social ? "game" : "social" });
        if (social && !this.reload([script.file])) this.needsRefresh = true;
        this.updateNotice();
    }

    async deleteScript(script: ListedScript, entry: ScriptEntry | undefined): Promise<void>{
        if (!this.popup) return;
        const sure = await askConfirm(this.popup.shadow, `Delete ${script.file}?`, "It goes to the recycle bin, so you can still get it back.", "Delete");
        if (!sure) return;
        if (entry && !entry.stop() && entry.state === "running") this.needsRefresh = true;
        this.send("delete", { key: script.key });
    }

    async createScript(group: string): Promise<void>{
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "New script", "my-script.js", "The file name. It ends up in the scripts folder of this group.");
        if (!answer) return;
        const file = /\.js$/i.test(answer) ? answer : `${answer}.js`;
        const exists = this.groups.some((candidate) => candidate.id === group && candidate.scripts.some((script) => script.file.toLowerCase() === file.toLowerCase()));
        if (exists){
            this.popup.showError(`${file} already exists in this group.`);
            return;
        }
        this.showEditor(group, file, TEMPLATE.replaceAll("{{name}}", file.replace(/\.js$/i, "")), true);
    }

    renderSettings(script: ListedScript, entry: ScriptEntry): HTMLElement{
        const panel = element("div", "scriptSettings");
        const settings = entry.settings ?? {};

        const save = (): void => {
            clearTimeout(this.prefsTimers.get(script.key));
            this.prefsTimers.set(script.key, setTimeout(() => {
                this.prefsTimers.delete(script.key);
                const prefs = Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.value]));
                this.send("prefs", { key: script.key, prefs });
            }, 300));
        };
        const change = (key: string, value: any): void => {
            entry.setPref(key, value);
            save();
        };

        for (const [key, setting] of Object.entries(settings)){
            const row = element("div", "settingRow");
            const label = element("div", "settingLabel", setting.title || key);
            if (setting.desc) label.append(element("small", "", setting.desc));
            row.append(label, this.settingControl(key, setting, change));
            panel.append(row);
        }
        return panel;
    }

    settingControl(key: string, setting: ScriptSetting, change: (key: string, value: any) => void): HTMLElement{
        switch (setting.type){
            case "bool": {
                const toggle = element("div", `toggle${setting.value ? " on" : ""}`);
                toggle.onclick = (): void => {
                    change(key, !setting.value);
                    toggle.classList.toggle("on", Boolean(setting.value));
                };
                return toggle;
            }
            case "num": {
                const wrap = element("div");
                wrap.style.cssText = "display:flex;gap:.6em;align-items:center";
                const number = element("input") as HTMLInputElement;
                number.type = "number";
                number.style.width = "90px";
                number.value = String(setting.value);
                if (setting.min !== undefined) number.min = String(setting.min);
                if (setting.max !== undefined) number.max = String(setting.max);
                number.step = String(setting.step ?? "any");
                if (setting.min !== undefined && setting.max !== undefined){
                    const range = element("input") as HTMLInputElement;
                    range.type = "range";
                    range.min = String(setting.min);
                    range.max = String(setting.max);
                    range.step = String(setting.step ?? "any");
                    range.value = String(setting.value);
                    range.oninput = (): void => {
                        number.value = range.value;
                        change(key, Number(range.value));
                    };
                    number.onchange = (): void => {
                        range.value = number.value;
                    };
                    wrap.append(range);
                }
                number.addEventListener("change", () => {
                    if (number.value !== "" && Number.isFinite(Number(number.value))) change(key, Number(number.value));
                });
                wrap.append(number);
                return wrap;
            }
            case "sel": {
                const select = element("select") as HTMLSelectElement;
                for (const option of setting.opts ?? []){
                    const item = element("option", "", String(option)) as HTMLOptionElement;
                    item.value = String(option);
                    item.selected = option === setting.value;
                    select.append(item);
                }
                select.onchange = (): void => {
                    const picked = (setting.opts ?? []).find((option) => String(option) === select.value);
                    change(key, picked ?? select.value);
                };
                return select;
            }
            case "color": {
                const color = element("input") as HTMLInputElement;
                color.type = "color";
                color.value = String(setting.value);
                color.onchange = (): void => change(key, color.value);
                return color;
            }
            case "text": {
                const text = element("input") as HTMLInputElement;
                text.type = "text";
                text.value = String(setting.value ?? "");
                text.onchange = (): void => change(key, text.value);
                return text;
            }
            case "keybind": {
                const describe = (bind: any): string => [bind?.ctrl && "Ctrl", bind?.alt && "Alt", bind?.shift && "Shift", bind?.key || "none"].filter(Boolean).join(" + ");
                const button = element("div", "btn small", describe(setting.value));
                button.onclick = (): void => {
                    button.textContent = "Press a key...";
                    const listener = (event: KeyboardEvent): void => {
                        if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        window.removeEventListener("keydown", listener, true);
                        const bind = { key: event.key.toLowerCase(), ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey };
                        change(key, bind);
                        button.textContent = describe(bind);
                    };
                    window.addEventListener("keydown", listener, true);
                };
                return button;
            }
            default:
                return element("div", "scriptFile", `unsupported type "${setting.type}"`);
        }
    }

    showEditor(group: string, file: string, content: string, isNew = false): void{
        const body = this.body();
        if (!body) return;
        const { editor } = createEditorView(body, {
            title: file,
            content,
            language: "js",
            isNew,
            onSave: (closeAfter) => {
                if (!this.editing) return;
                this.pendingSave = { closeAfter };
                this.editing.closeAfterSave = closeAfter;
                this.send("write", { group, file, content: this.editing.editor.getValue() });
            },
            onClose: () => this.leaveEditor(),
        });
        this.editing = { group, file, editor, closeAfterSave: false };
    }

    async leaveEditor(): Promise<void>{
        if (!this.editing || !this.popup) return;
        if (this.editing.editor.isDirty()){
            const discard = await askConfirm(this.popup.shadow, "Unsaved changes", "Close the editor and throw the changes away?", "Discard");
            if (!discard) return;
        }
        this.editing = null;
        this.render();
    }

    canClose(): boolean{
        if (this.forceClose || !this.editing?.editor.isDirty() || !this.popup) return true;
        askConfirm(this.popup.shadow, "Unsaved changes", "Close and throw the changes away?", "Discard").then((discard) => {
            if (!discard) return;
            this.forceClose = true;
            this.popup?.close();
        });
        return false;
    }
}

const manager = new UserscriptManager();

export const open = (): void => manager.open();
