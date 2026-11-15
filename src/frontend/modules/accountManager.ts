import { kute } from "../client";
import { getElement, getInput, checkCompMode, request } from "../utils";
import { confirmPopup } from "./confirmPopup";
import { holdRestart, restart } from "./sessionRecovery";
import { bindings } from "./hotkeys";

interface Account {
    username: string;
    color: string;
}

interface LegacyAccount {
    username: string;
    password: string;
    color: string;
}

const LEGACY_KEY = "accounts";
const DEFAULT_COLOR = "#35e0e8";
const SWITCH_KEY = "kute_account_switch";
const SWITCH_MAX_MS = 120000;
const SWITCH_HOLD_MS = 30000;
const FRVR_LOGOUT_WAIT_MS = 3000;
const LOGIN_WAIT_MS = 20000;
const SOCKET_LOGIN_MS = 3000;
const QUICK_LOGIN_COOLDOWN_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

function legacyDecode(encoded: string): string{
    const text = decodeURIComponent(encoded);
    const key = text.length;
    return text
        .split("")
        .map((char) => String.fromCharCode(char.charCodeAt(0) - key))
        .join("");
}

function legacyEncode(decoded: string): string{
    const key = decoded.length;
    const encoded = decoded
        .split("")
        .map((char) => String.fromCharCode(char.charCodeAt(0) + key))
        .join("");
    return encodeURIComponent(encoded);
}

function legacyAccounts(): LegacyAccount[]{
    try {
        const list = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]");
        return Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
}

function safeColor(color: string | undefined): string{
    return typeof color === "string" && /^#[\da-f]{6}$/i.test(color) ? color : DEFAULT_COLOR;
}

function readableOn(color: string): string{
    const value = Number.parseInt(color.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#111" : "#fff";
}

function paintAvatar(avatar: HTMLElement, color: string, username: string): void{
    const background = safeColor(color);
    avatar.style.background = background;
    avatar.style.color = readableOn(background);
    avatar.textContent = username.trim().slice(0, 1) || "?";
}

class AccountManager {
    button: HTMLDivElement;
    headerSeparator: HTMLDivElement;
    headerItem: HTMLDivElement;
    headerObserver: MutationObserver;
    overlay: HTMLDivElement | null;
    shadow: ShadowRoot | null;
    menuController: AbortController | null;
    asking: boolean;
    accounts: Account[];
    legacy: boolean;
    lastQuickLogin: number;
    suppressClick: boolean;

    constructor(){
        this.button = document.createElement("div");
        this.button.textContent = "Accounts";
        this.button.classList.add("button", "buttonB", "bigShadowT");
        this.button.style.cssText =
            "display: block; padding-top: 7px; padding-bottom: 22px; font-size: 25px!important; padding-bottom: 22px; margin-top: 7px; height: 21px; line-height: 35px; width: 162px; font-size:20px!important; margin-left: 3px;";

        this.headerSeparator = document.createElement("div");
        this.headerSeparator.style.cssText = "width: 4px; height: 35px; margin: 0 6px; background: rgba(255, 255, 255, 0.12); flex-shrink: 0;";
        this.headerItem = document.createElement("div");
        this.headerItem.style.cssText =
            "display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; color: #fff; font-weight: 700; font-size: 16px; white-space: nowrap;";
        this.headerItem.innerHTML = '<span class="material-icons" style="font-size: 20px;">switch_account</span><span>Accounts</span>';

        this.headerObserver = new MutationObserver(() => this.placeButton());

        this.overlay = null;
        this.shadow = null;
        this.menuController = null;
        this.asking = false;

        this.accounts = [];
        this.legacy = false;
        this.lastQuickLogin = 0;
        this.suppressClick = false;

        kute.settings.toggleAccountManager = (enabled): void => this.toggle(enabled);
        kute.accounts = { loginSlot: (index): void => this.loginSlot(index) };

        this.toggle(true);
        this.load();
    }

    async load(): Promise<void>{
        const legacy = legacyAccounts();
        let accounts = null;
        if (legacy.length > 0){
            const migrated = legacy
                .filter((account) => typeof account?.username === "string" && typeof account?.password === "string")
                .map((account) => ({ username: legacyDecode(account.username), password: legacyDecode(account.password), color: account.color }));
            accounts = await request(`accounts-migrate ${JSON.stringify(migrated)}`, "accounts", 5000);
            if (accounts !== null) localStorage.removeItem(LEGACY_KEY);
        }
        else {
            accounts = await request("accounts-list", "accounts");
        }
        if (accounts === null){
            this.legacy = true;
            this.accounts = legacy.map((account) => ({ username: legacyDecode(account.username), color: account.color }));
        }
        else {
            this.accounts = accounts;
        }
        this.renderAccounts();
        this.resumeSwitch();
    }

    resumeSwitch(): void{
        const raw = sessionStorage.getItem(SWITCH_KEY);
        if (raw === null) return;
        sessionStorage.removeItem(SWITCH_KEY);
        let pending: { username?: unknown, at?: unknown } = {};
        try {
            pending = JSON.parse(raw) ?? {};
        }
        catch {
            return;
        }
        if (Date.now() - Number(pending.at) > SWITCH_MAX_MS) return;
        if (localStorage.getItem("krunker_token") !== null) return;
        const account = this.accounts.find((entry) => entry.username === pending.username);
        if (account) this.login(account);
    }

    async send(command: string, payload: object): Promise<void>{
        const accounts = await request(`accounts-${command} ${JSON.stringify(payload)}`, "accounts");
        if (accounts === null) return;
        this.accounts = accounts;
        this.renderAccounts();
    }

    gameUpdateListener = (event: MessageEvent): void => {
        if (event.data === "game-updated"){
            setTimeout(() => {
                if (checkCompMode()){
                    window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                    this.button.style.cssText =
                        "display: block; padding: 14px 24px 22px; bottom: 0; right: 0; z-index: 9; font-size: 21px !important; position: absolute;";
                    getElement("#compBtnLst").append(this.button);
                }
            }, 2000);
        }
    };

    toggle(enabled: boolean): void{
        if (enabled){
            window.chrome.webview.addEventListener("message", this.gameUpdateListener);
            this.button.addEventListener("click", this.openMenu);
            this.headerItem.addEventListener("click", this.openMenu);
            if (checkCompMode()){
                window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                this.button.style.cssText =
                    "display: block; padding: 14px 24px 22px; bottom: 0; right: 0; z-index: 9; font-size: 21px !important; position: absolute;";
                getElement("#compBtnLst").append(this.button);
            }
            else {
                this.placeButton();
                const header = document.querySelector("#playerHeaderEl");
                if (header) this.headerObserver.observe(header, { childList: true, subtree: true });
            }
        }
        else {
            window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
            this.headerObserver.disconnect();
            this.button.removeEventListener("click", this.openMenu);
            this.headerItem.removeEventListener("click", this.openMenu);
            this.button.remove();
            this.headerSeparator.remove();
            this.headerItem.remove();
            this.closeMenu();
        }
    }

    placeButton(): void{
        const right = document.querySelector("#playerHeaderEl .headerBarRight");
        if (right){
            if (right.firstElementChild !== this.headerItem){
                const scope = [...(right.querySelector(".nav-item")?.classList ?? [])].find((name) => name.startsWith("svelte-")) ?? "";
                this.headerItem.style.cssText = "";
                this.headerItem.className = `nav-item ${scope}`;
                this.headerItem.innerHTML = `<span class="material-icons nav-mat-icon ${scope}">switch_account</span> <span class="nav-label ${scope}">Accounts</span>`;
                this.headerSeparator.className = "verticalSeparator";
                this.headerSeparator.style.cssText = "height: 35px;";
                right.prepend(this.headerItem, this.headerSeparator);
            }
            this.button.remove();
            return;
        }

        const signedIn = document.querySelector("#signedInHeaderBar");
        if (signedIn){
            if (!signedIn.contains(this.headerItem)) signedIn.append(this.headerSeparator, this.headerItem);
            return;
        }
        const signedOut = document.querySelector("#signedOutHeaderBar");
        if (signedOut && !signedOut.contains(this.button)) signedOut.append(this.button);
    }

    openMenu = (): void => {
        if (this.overlay) return;
        this.buildMenu().catch((error) => console.error("[kute] accounts:", error));
    };

    async buildMenu(): Promise<void>{
        const html = await import("../components/accountManager.html");
        if (this.overlay) return;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;
        this.overlay = overlay;
        this.shadow = shadow;

        const controller = new AbortController();
        this.menuController = controller;

        getElement("#accClose", shadow).onclick = (): void => this.closeMenu();
        getElement("#accAdd", shadow).onclick = (): void => this.showForm(true);
        getElement("#accCancel", shadow).onclick = (): void => this.showForm(false);
        getElement("#accSave", shadow).onclick = (): void => this.saveAccount();
        getElement("#accFormHint", shadow).textContent = this.legacy
            ? "Saved on this PC only"
            : "Saved encrypted on this PC, never sent anywhere";

        const username = getInput("#accUsername", shadow);
        const color = getInput("#accColor", shadow);
        username.oninput = (): void => this.updatePreview();
        color.oninput = (): void => this.updatePreview();
        for (const input of [username, getInput("#accPassword", shadow)]){
            input.onkeydown = (event): void => {
                if (event.key === "Enter") this.saveAccount();
            };
        }
        for (const type of ["keydown", "keyup", "keypress"]){
            shadow.addEventListener(type, (event) => event.stopPropagation());
        }

        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) this.closeMenu();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape" || this.asking) return;
                event.stopPropagation();
                if (getElement("#accFormView", shadow).hidden) this.closeMenu();
                else this.showForm(false);
            },
            { signal: controller.signal, capture: true },
        );

        this.renderAccounts();
        this.resetForm();
        document.body.append(overlay);
    }

    closeMenu(): void{
        this.menuController?.abort();
        this.menuController = null;
        this.overlay?.remove();
        this.overlay = null;
        this.shadow = null;
    }

    showForm(show: boolean): void{
        if (!this.shadow) return;
        getElement("#accListView", this.shadow).hidden = show;
        getElement("#accFormView", this.shadow).hidden = !show;
        if (!show) return;
        this.resetForm();
        getInput("#accUsername", this.shadow).focus();
    }

    renderAccounts(): void{
        const { shadow } = this;
        if (!shadow) return;

        const list = getElement("#accList", shadow);
        list.textContent = "";
        for (const account of this.accounts){
            const row = document.createElement("div");
            row.className = "accRow";
            row.dataset.username = account.username;
            row.title = `Log in as ${account.username}`;
            row.onclick = (): void => {
                if (!this.suppressClick) this.login(account);
            };

            const handle = document.createElement("div");
            handle.className = "accHandle";
            handle.textContent = "≡";
            handle.title = "Drag to reorder";
            handle.onclick = (event): void => event.stopPropagation();
            handle.onpointerdown = (event): void => this.startDrag(event, row);

            const index = document.createElement("div");
            index.className = "accIndex";

            const avatar = document.createElement("div");
            avatar.className = "accAvatar";
            paintAvatar(avatar, account.color, account.username);

            const name = document.createElement("div");
            name.className = "accName";
            name.textContent = account.username;

            const remove = document.createElement("div");
            remove.className = "accRemove";
            remove.textContent = "×";
            remove.title = "Remove";
            remove.onclick = (event): void => {
                event.stopPropagation();
                this.removeAccount(account).catch((error) => console.error("[kute] accounts:", error));
            };

            const key = document.createElement("div");
            key.className = "accKey";

            row.append(handle, index, avatar, name, key, remove);
            list.append(row);
        }
        this.renumber(list);

        const empty = this.accounts.length === 0;
        getElement("#accEmpty", shadow).hidden = !empty;
        getElement("#accListHint", shadow).hidden = empty;
    }

    renumber(list: HTMLElement): void{
        const keys = bindings();
        [...list.children].forEach((row, position) => {
            getElement(".accIndex", row as HTMLElement).textContent = String(position + 1);
            getElement(".accKey", row as HTMLElement).textContent = keys[`account${position + 1}`]?.name ?? "";
        });
    }

    canReorder(): boolean{
        return this.legacy || Boolean(kute.hostFeatures?.includes("accounts-order"));
    }

    startDrag(event: PointerEvent, row: HTMLElement): void{
        if (event.button !== 0) return;
        event.preventDefault();
        if (!this.canReorder()){
            kute.showNotification("Reordering accounts needs a newer Kute", false, 3);
            return;
        }
        const list = row.parentElement as HTMLElement;
        const before = [...list.children].map((entry) => (entry as HTMLElement).dataset.username);
        row.classList.add("accDragging");

        const onMove = (move: PointerEvent): void => {
            const others = ([...list.children] as HTMLElement[]).filter((entry) => entry !== row);
            const below = others.find((entry) => {
                const box = entry.getBoundingClientRect();
                return move.clientY < box.top + box.height / 2;
            });
            const target = below ? others.indexOf(below) : others.length;
            const current = others.filter((entry) => Boolean(row.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_PRECEDING)).length;
            if (target === current) return;
            for (const entry of others.slice(0, target)) list.insertBefore(entry, row);
            for (const entry of others.slice(target)) list.append(entry);
            this.renumber(list);
        };
        const onEnd = (): void => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onEnd, true);
            window.removeEventListener("pointercancel", onEnd, true);
            row.classList.remove("accDragging");
            this.suppressClick = true;
            setTimeout(() => {
                this.suppressClick = false;
            });
            const order = [...list.children].map((entry) => (entry as HTMLElement).dataset.username ?? "");
            if (order.some((username, position) => username !== before[position])) this.saveOrder(order);
        };
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onEnd, true);
        window.addEventListener("pointercancel", onEnd, true);
    }

    saveOrder(order: string[]): void{
        const rank = (username: string): number => {
            const position = order.indexOf(username);
            return position === -1 ? order.length : position;
        };
        this.accounts.sort((a, b) => rank(a.username) - rank(b.username));
        if (this.legacy){
            const list = legacyAccounts().sort((a, b) => rank(legacyDecode(a.username)) - rank(legacyDecode(b.username)));
            localStorage.setItem(LEGACY_KEY, JSON.stringify(list));
            return;
        }
        this.send("order", order);
    }

    loginSlot(index: number): void{
        const account = this.accounts[index];
        if (!account){
            kute.showNotification(`No account saved in slot ${index + 1}`, false, 3);
            return;
        }
        if (localStorage.getItem("krunker_token") !== null && localStorage.getItem("krunker_username") === account.username){
            kute.showNotification(`Already logged in as ${account.username}`, false, 2);
            return;
        }
        if (Date.now() - this.lastQuickLogin < QUICK_LOGIN_COOLDOWN_MS) return;
        this.lastQuickLogin = Date.now();
        kute.showNotification(`Logging in as ${account.username}`, false, 2);
        this.login(account).catch((error) => console.error("[kute] accounts:", error));
    }

    updatePreview(): void{
        if (!this.shadow) return;
        const username = getInput("#accUsername", this.shadow).value;
        const color = getInput("#accColor", this.shadow).value;
        paintAvatar(getElement("#accPreviewAvatar", this.shadow), color, username);
        getElement("#accPreviewName", this.shadow).textContent = username.trim() || "Username";
    }

    resetForm(): void{
        if (!this.shadow) return;
        getInput("#accColor", this.shadow).value = `#${Math.floor(Math.random() * 16777215)
            .toString(16)
            .padStart(6, "0")}`;
        getInput("#accUsername", this.shadow).value = "";
        getInput("#accPassword", this.shadow).value = "";
        getElement("#accError", this.shadow).textContent = "";
        this.updatePreview();
    }

    saveAccount(): void{
        if (!this.shadow) return;
        const username = getInput("#accUsername", this.shadow).value.trim();
        const password = getInput("#accPassword", this.shadow).value;
        const color = getInput("#accColor", this.shadow).value;
        const error = getElement("#accError", this.shadow);

        if (username === ""){
            error.textContent = "Enter a username";
            return;
        }
        if (password === ""){
            error.textContent = "Enter a password";
            return;
        }
        if (this.accounts.some((account) => account.username === username)){
            error.textContent = `${username} is already saved`;
            return;
        }

        if (this.legacy){
            const list = legacyAccounts();
            list.push({ username: legacyEncode(username), password: legacyEncode(password), color });
            localStorage.setItem(LEGACY_KEY, JSON.stringify(list));
            this.accounts.push({ username, color });
            this.renderAccounts();
        }
        else {
            this.send("add", { username, password, color });
        }
        this.showForm(false);
    }

    async removeAccount(account: Account): Promise<void>{
        this.asking = true;
        const confirmed = await confirmPopup({
            title: "Remove account",
            paragraphs: [`${account.username} gets removed from this list.`, "The Krunker account itself is not touched."],
            stay: "Keep",
            leave: "Remove",
        });
        this.asking = false;
        if (!confirmed) return;

        const index = this.accounts.findIndex((entry) => entry.username === account.username);
        if (index === -1) return;
        if (this.legacy){
            localStorage.setItem(
                LEGACY_KEY,
                JSON.stringify(legacyAccounts().filter((entry) => legacyDecode(entry.username) !== account.username)),
            );
            this.accounts.splice(index, 1);
            this.renderAccounts();
        }
        else {
            this.send("remove", { username: account.username });
        }
    }

    async login(account: Account): Promise<void>{
        this.closeMenu();
        const auth = window.FRVR?.auth;
        const signedIn = localStorage.getItem("krunker_token") !== null;
        if (typeof auth?.loginAsAnonymous !== "function" || typeof auth.isLoggedIn !== "function"){
            if (signedIn){
                sessionStorage.setItem(SWITCH_KEY, JSON.stringify({ username: account.username, at: Date.now() }));
                window.logoutAcc();
                restart();
                return;
            }
        }
        else {
            if (signedIn){
                holdRestart(SWITCH_HOLD_MS);
                window.logoutAcc();
                for (let waited = 0; waited < FRVR_LOGOUT_WAIT_MS && auth.isLoggedIn(); waited += 100) await sleep(100);
            }
            if (!auth.isLoggedIn()){
                try {
                    await auth.loginAsAnonymous();
                }
                catch (error){
                    console.error("[kute] accounts: anonymous frvr login failed:", error);
                }
            }
            this.finishSwitch(auth).catch((error) => console.error("[kute] accounts:", error));
        }
        window.loginOrRegister();

        queueMicrotask(() => {
            const authToggle = getElement(".auth-toggle-btn");
            if (authToggle.textContent?.includes("username")) authToggle.click();

            queueMicrotask(() => {
                if (this.legacy){
                    this.legacyLogin(account.username);
                    return;
                }
                this.send("login", { username: account.username });
            });
        });
    }

    async finishSwitch(auth: NonNullable<typeof window.FRVR>["auth"]): Promise<void>{
        let landed = 0;
        for (let waited = 0; waited < LOGIN_WAIT_MS; waited += 250){
            await sleep(250);
            if (localStorage.getItem("krunker_token") !== null) return;
            const inFrvr = typeof auth.getCurrentPlatform === "function" ? auth.getCurrentPlatform() !== "anonymous" : false;
            if (!inFrvr) continue;
            landed ||= Date.now();
            if (Date.now() - landed >= SOCKET_LOGIN_MS){
                holdRestart(SWITCH_HOLD_MS);
                restart();
                return;
            }
        }
    }

    legacyLogin(username: string): void{
        const stored = legacyAccounts().find((account) => legacyDecode(account.username) === username);
        if (!stored) return;
        const nameInput = getInput("#accName");
        const passInput = getInput("#accPass");
        nameInput.value = username;
        passInput.value = legacyDecode(stored.password);
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        passInput.dispatchEvent(new Event("input", { bubbles: true }));
        getElement(".io-button").click();
    }
}

export default new AccountManager();
