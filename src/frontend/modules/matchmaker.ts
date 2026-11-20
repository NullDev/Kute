import styles from "../components/matchmaker.css";
import { kute } from "../client";
import { request } from "../utils";
import { matches } from "./hotkeys";
import { OFFICIAL_MAPS, mapImageUrl } from "./maps";
import {
    DEFAULT_FILTER, MAP_FILTER, MAX_SKIP_RECENT, MODE_FILTER, normalizeMap, readLobbies, rememberLobby, skippedLobbies,
    type MatchmakerFilter, type Lobby,
} from "./matchmakerFilter";
import { SEARCH_INTERVAL_MS, cooldownMs, nextRetryMs, retryAfterMs } from "./matchmakerPacing";

const REGIONS: Record<string, string> = {
    SV: "Silicon Valley", TOK: "Tokyo", FRA: "Frankfurt", MBI: "Mumbai", SYD: "Sydney",
    SIN: "Singapore", DAL: "Dallas", BHN: "Bahrain", BRZ: "Brazil", NY: "New York",
};

const MAP_NAMES: Record<string, string> = { SkyTemple: "Sky Temple", Krunk_Plaza: "Krunk Plaza", Old_Burg: "Old Burg" };

const MAP_ICON_BY_NAME = new Map(OFFICIAL_MAPS.map((name, index) => [normalizeMap(name), index]));

const GAME_LIST_URL = "https://matchmaker.krunker.io/game-list?hostname=krunker.io";
const FETCH_TIMEOUT_MS = 10000;
const MAX_FEED_ENTRIES = 4;
const MAX_ANIMATION_MS = 1100;
const BASE_TICK_MS = 80;
const MIN_TICK_MS = 20;
const POST_SCAN_PAUSE_MS = 180;
const FOUND_HOLD_MS = 1200;
const NOT_FOUND_HOLD_MS = 1100;
const FAILED_HOLD_MS = 2000;
const SCAN_LABEL = "Scanning lobbies...";
const JOIN_KEY = "kute_mm_join";
const RECENT_KEY = "kute_mm_recent";
const JOIN_MAX_AGE_MS = 120000;
const JOIN_WATCH_MS = 20000;
const JOIN_POLL_MS = 250;
const MAX_RECOVERIES = 3;
const REJECTIONS: [RegExp, string][] = [
    [/game is full/i, "Lobby was full, scanning..."],
    [/game not found/i, "Lobby is gone, scanning..."],
];
const MIN_WAIT_MS = 1000;
const COLLECT_WAIT_MS = 6000;
const COLLECT_POLL_MS = 200;
const COLLECT_GRACE_MS = 3000;
const CONFIRM_DELAY_MS = 1000;
const CONFIRM_WAIT_MS = 3000;

type Outcome = "joined" | "none" | "stale" | "failed";

class GameListError extends Error {
    status: number;
    retryAfter: number | null;

    constructor(status: number, retryAfter: number | null){
        super(`game list: HTTP ${status}`);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readSession(key: string): any{
    try {
        return JSON.parse(sessionStorage.getItem(key) ?? "null");
    }
    catch {
        return null;
    }
}

function writeSession(key: string, value: unknown): void{
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        return;
    }
}

function takeSession(key: string): any{
    const value = readSession(key);
    try {
        sessionStorage.removeItem(key);
    }
    catch {
        return value;
    }
    return value;
}

function mapIconUrl(map: string): string | null{
    const index = MAP_ICON_BY_NAME.get(normalizeMap(map));
    return index === undefined ? null : mapImageUrl(index);
}

function mapIcon(map: string, className: string): HTMLImageElement | null{
    const url = mapIconUrl(map);
    if (!url) return null;
    const img = document.createElement("img");
    img.className = className;
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = (): void => img.remove();
    return img;
}

function visible(element: HTMLElement | null): element is HTMLElement{
    return !!element?.checkVisibility({ visibilityProperty: true });
}

function span(className: string, text: string): HTMLSpanElement{
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
}

function lobbyEntry(lobby: Lobby, className: string): HTMLDivElement{
    const entry = document.createElement("div");
    entry.className = `mm-entry ${className}`;
    const icon = mapIcon(lobby.map, "mm-icon");
    if (icon) entry.append(icon);
    entry.append(span("mm-region", lobby.region), span("mm-map", lobby.map), span("mm-players", `${lobby.players}/${lobby.limit}`));
    return entry;
}

async function fetchGameList(): Promise<any[]>{
    const response = await fetch(GAME_LIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new GameListError(response.status, retryAfterMs(response.headers.get("Retry-After"), Date.now()));
    const result = await response.json();
    return Array.isArray(result?.games) ? result.games : [];
}

class Matchmaker {
    activeRun = 0;
    runCounter = 0;
    candidates: Lobby[] = [];
    pausedUntil = 0;
    lastFetch = 0;
    collecting: Promise<void> | null = null;
    rejected: string[] = [];
    skip: ReadonlySet<string> = new Set();
    scanLabel = SCAN_LABEL;
    popup = document.createElement("div");
    status: HTMLDivElement;
    feed: HTMLDivElement;
    counter: HTMLDivElement;
    cancelKey: (event: KeyboardEvent) => void;

    constructor(){
        this.popup.id = "kuteMatchmaker";
        this.status = document.createElement("div");
        this.status.id = "kuteMmStatus";
        this.feed = document.createElement("div");
        this.feed.id = "kuteMmFeed";
        this.counter = document.createElement("div");
        this.counter.id = "kuteMmCounter";
        const cancel = document.createElement("div");
        cancel.id = "kuteMmCancel";
        cancel.textContent = "Cancel";
        cancel.onmouseenter = (): void => {
            window.SOUND?.play("tick_0", 0.1);
        };
        cancel.onclick = (): void => this.abort();
        this.popup.append(this.status, this.feed, this.counter, cancel);

        this.cancelKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || document.pointerLockElement) return;
            event.preventDefault();
            event.stopPropagation();
            this.abort();
        };

        kute.matchmaker = { showFilters: (): Promise<void> => this.showFilters() };
        kute.settings.toggleMatchmaker = (): void => {};

        if (!kute.hostFeatures?.includes("matchmaker")) return;
        window.addEventListener(
            "keydown",
            (event) => {
                if (!matches(event, "matchmaker") || event.repeat || !kute.settings.data.matchmaker) return;
                if (document.activeElement?.tagName === "INPUT") return;
                if (this.activeRun !== 0 && this.filter.keepSearching){
                    this.abort();
                    return;
                }
                this.start().catch((error) => console.error("[kute] matchmaker:", error));
            },
            true,
        );
        this.watchEndScreen();
        this.watchJoin();
    }

    watchJoin(): void{
        const marker = takeSession(JOIN_KEY);
        const screen = document.getElementById("instructionsUpdate");
        if (!screen || typeof marker?.id !== "string" || !Array.isArray(marker.rejected)) return;
        if (Date.now() - Number(marker.at) > JOIN_MAX_AGE_MS || !location.href.includes(marker.id)) return;

        const deadline = Date.now() + JOIN_WATCH_MS;
        const timer = setInterval(() => {
            if (document.pointerLockElement || Date.now() > deadline){
                clearInterval(timer);
                return;
            }
            if (screen.style.display === "none") return;
            const text = screen.textContent;
            const rejection = REJECTIONS.find(([pattern]) => pattern.test(text));
            if (!rejection) return;
            clearInterval(timer);

            this.rejected = [...marker.rejected.filter((id: unknown) => typeof id === "string"), marker.id];
            if (this.rejected.length > MAX_RECOVERIES || !kute.settings.data.matchmaker) return;
            [, this.scanLabel] = rejection;
            this.start().catch((error) => console.error("[kute] matchmaker:", error));
        }, JOIN_POLL_MS);
    }

    watchEndScreen(): void{
        const endUI = document.getElementById("endUI");
        if (!endUI) return;
        let played = false;
        let shown = endUI.style.display !== "none";
        document.addEventListener("pointerlockchange", () => {
            if (document.pointerLockElement) played = true;
        });
        new MutationObserver(() => {
            const up = endUI.style.display !== "none";
            if (up === shown) return;
            shown = up;
            if (!up || !played) return;
            played = false;
            if (!kute.settings.data.matchmaker) return;
            this.afterMatch(endUI, !!window.getGameActivity?.()?.custom).catch((error) => console.error("[kute] matchmaker:", error));
        }).observe(endUI, { attributes: true, attributeFilter: ["style"] });
    }

    async afterMatch(endUI: HTMLElement, custom: boolean): Promise<void>{
        const { collectRewards, collectDoubleXp } = this.filter;
        if ((collectRewards || collectDoubleXp) && !this.collecting){
            this.collecting = this.collect(endUI, collectRewards, collectDoubleXp).finally(() => (this.collecting = null));
            await this.collecting;
        }
        if (custom || !this.filter.searchAfterMatch || endUI.style.display === "none") return;
        await this.start();
    }

    async collect(endUI: HTMLElement, rewardItems: boolean, doubleXpBonus: boolean): Promise<void>{
        const open = (): boolean => endUI.style.display !== "none";
        const deadline = Date.now() + COLLECT_WAIT_MS;

        while (rewardItems && open() && Date.now() < deadline){
            const rewards = document.querySelector("#collectRewardsButtonContainer button.collect-rewards-button") as HTMLButtonElement | null;
            if (visible(rewards) && !rewards.disabled && rewards.getAttribute("aria-disabled") !== "true"){
                rewards.click();
                await sleep(COLLECT_GRACE_MS);
                break;
            }
            await sleep(COLLECT_POLL_MS);
        }

        if (!doubleXpBonus) return;
        let doubleXp = document.getElementById("doubleXPButton");
        while (open() && !visible(doubleXp) && Date.now() < deadline){
            await sleep(COLLECT_POLL_MS);
            doubleXp = document.getElementById("doubleXPButton");
        }
        if (!open() || !visible(doubleXp)) return;
        doubleXp.click();

        const started = Date.now();
        await sleep(CONFIRM_DELAY_MS);
        while (open() && Date.now() - started < CONFIRM_WAIT_MS){
            const confirm = Array.from(document.querySelectorAll(".button.dxp-btn") as NodeListOf<HTMLElement>).find(
                (button) => button.textContent.trim().toLowerCase() === "nice!" && visible(button),
            );
            if (confirm){
                confirm.click();
                break;
            }
            await sleep(COLLECT_POLL_MS);
        }
        await sleep(Math.max(0, started + COLLECT_GRACE_MS - Date.now()));
    }

    async gameList(): Promise<any[]>{
        this.lastFetch = Date.now();
        try {
            return await fetchGameList();
        }
        catch (error){
            if (error instanceof GameListError){
                const pause = cooldownMs(error.status, error.retryAfter);
                if (pause > 0) this.pausedUntil = Math.max(this.pausedUntil, Date.now() + pause);
            }
            throw error;
        }
    }

    get filter(): MatchmakerFilter{
        return { ...DEFAULT_FILTER, ...kute.settings.data.matchmakerFilter };
    }

    saveFilter(filter: MatchmakerFilter): void{
        kute.settings.data.matchmakerFilter = filter;
        window.chrome.webview.postMessage(`set-config-json matchmakerFilter ${JSON.stringify(filter)}`);
    }

    cancelled(run: number): boolean{
        return run !== this.activeRun;
    }

    abort(): void{
        this.activeRun = 0;
        window.playSelect?.();
        this.dismiss();
    }

    dismiss(): void{
        document.removeEventListener("keydown", this.cancelKey, true);
        this.popup.remove();
    }

    showPopup(): void{
        if (!document.querySelector("#kuteMatchmakerCSS")){
            const css = document.createElement("style");
            css.id = "kuteMatchmakerCSS";
            css.textContent = styles;
            document.head.append(css);
        }
        this.status.textContent = "Connecting...";
        this.status.classList.remove("mm-fail");
        this.feed.replaceChildren();
        this.feed.classList.remove("mm-result");
        this.counter.textContent = "";
        document.addEventListener("keydown", this.cancelKey, true);
        (document.querySelector("#uiBase") ?? document.body).append(this.popup);
    }

    pushEntry(entry: HTMLElement): void{
        this.feed.append(entry);
        while (this.feed.children.length > MAX_FEED_ENTRIES) this.feed.firstElementChild?.remove();
    }

    async animateScan(run: number, lobbies: Lobby[], best?: Lobby): Promise<void>{
        const total = lobbies.length;
        if (total === 0) return;
        this.status.textContent = this.scanLabel;
        this.scanLabel = SCAN_LABEL;

        const maxEntries = Math.floor(MAX_ANIMATION_MS / BASE_TICK_MS);
        const step = total > maxEntries ? total / maxEntries : 1;
        const tickMs = total > maxEntries ? BASE_TICK_MS : Math.max(MIN_TICK_MS, Math.min(BASE_TICK_MS, MAX_ANIMATION_MS / total));

        for (let f = 0; f < total; f += step){
            if (this.cancelled(run)) return;
            const index = Math.min(Math.floor(f), total - 1);
            this.pushEntry(lobbyEntry(lobbies[index], lobbies[index].passes ? "mm-pass" : "mm-skip"));
            this.counter.textContent = `Checked: ${index + 1} / ${total} lobbies`;
            await sleep(tickMs);
        }
        if (this.cancelled(run)) return;
        this.counter.textContent = `Checked: ${total} / ${total} lobbies`;
        if (best) this.pushEntry(lobbyEntry(best, "mm-pass mm-landed"));
        await sleep(POST_SCAN_PAUSE_MS);
    }

    async join(run: number, id: string): Promise<void>{
        if (this.collecting) await this.collecting;
        if (this.cancelled(run)) return;
        this.dismiss();
        window.chrome.webview.postMessage("throttle, off");
        window.chrome.webview.postMessage("drag, true");
        writeSession(JOIN_KEY, { id, at: Date.now(), rejected: this.rejected });
        location.href = `https://krunker.io/?game=${id}`;
    }

    openServerBrowser(filter: MatchmakerFilter): void{
        this.dismiss();
        if (filter.serverBrowser) window.openServerWindow?.(0);
    }

    async verifyAndJoin(run: number, best: Lobby, filter: MatchmakerFilter): Promise<Outcome>{
        let games;
        try {
            games = await this.gameList();
        }
        catch {
            await this.join(run, best.id);
            return "joined";
        }
        if (this.cancelled(run)) return "joined";

        const live = new Map(readLobbies(games, filter, this.skip).map((lobby) => [lobby.id, lobby]));
        const ordered = [best, ...this.candidates.filter((lobby) => lobby !== best)];
        const open = ordered.find((lobby) => live.get(lobby.id)?.passes);
        if (!open) return "stale";
        await this.join(run, open.id);
        return "joined";
    }

    async showFailure(run: number, filter: MatchmakerFilter, status: string, detail: string): Promise<void>{
        if (!filter.animation) return;
        this.status.textContent = status;
        this.status.classList.add("mm-fail");
        this.counter.textContent = detail;
        await sleep(FAILED_HOLD_MS);
        if (!this.cancelled(run)) this.dismiss();
    }

    async showNothing(run: number, filter: MatchmakerFilter): Promise<void>{
        if (filter.animation){
            this.showNote("No Lobby Found", "No matching lobbies");
            this.counter.textContent = filter.serverBrowser ? "Opening server browser..." : "";
            await sleep(NOT_FOUND_HOLD_MS);
            if (this.cancelled(run)) return;
        }
        this.openServerBrowser(filter);
    }

    showNote(status: string, detail: string): void{
        this.status.textContent = status;
        this.status.classList.add("mm-fail");
        this.feed.classList.add("mm-result");
        const note = document.createElement("div");
        note.className = "mm-entry mm-none";
        note.textContent = detail;
        this.feed.replaceChildren(note);
    }

    async wait(run: number, ms: number, status: string, detail: string): Promise<boolean>{
        if (!this.popup.isConnected) this.showPopup();
        this.showNote(status, detail);
        const until = Date.now() + ms;
        for (let left = ms, first = true; left > 0; left = until - Date.now(), first = false){
            if (first || !document.pointerLockElement) this.counter.textContent = `Searching again in ${Math.ceil(left / 1000)}s`;
            await sleep(Math.min(1000, left));
            if (this.cancelled(run)) return false;
        }
        return true;
    }

    async start(): Promise<void>{
        if (this.activeRun !== 0) return;
        const run = ++this.runCounter;
        this.activeRun = run;
        try {
            await this.search(run);
        }
        finally {
            if (this.activeRun === run) this.activeRun = 0;
        }
    }

    async search(run: number): Promise<void>{
        const { filter } = this;
        if (filter.animation) this.showPopup();

        const recent = rememberLobby(readSession(RECENT_KEY) ?? [], new URLSearchParams(location.search).get("game"));
        writeSession(RECENT_KEY, recent);
        this.skip = skippedLobbies(recent, filter.skipRecent, this.rejected);

        let retryMs = 0;
        for (let first = true; ; first = false){
            const paused = this.pausedUntil - Date.now();
            if (paused > 0){
                if (!filter.keepSearching){
                    await this.showFailure(run, filter, "Lobby list rate limited", `Try again in ${Math.ceil(paused / 1000)}s`);
                    return;
                }
                if (!(await this.wait(run, paused, "Lobby list rate limited", "Krunker asked for a pause"))) return;
            }

            const outcome = await this.attempt(run, filter, first);
            if (outcome === "joined" || this.cancelled(run)) return;

            if (!filter.keepSearching){
                if (outcome === "failed") await this.showFailure(run, filter, "Failed to fetch lobbies", "");
                else if (outcome === "stale") this.openServerBrowser(filter);
                else await this.showNothing(run, filter);
                return;
            }
            if (Date.now() < this.pausedUntil) continue;

            if (outcome === "failed"){
                retryMs = nextRetryMs(retryMs);
                if (!(await this.wait(run, retryMs, "Failed to fetch lobbies", "Lobby list unavailable"))) return;
                continue;
            }
            retryMs = 0;
            const delay = Math.max(MIN_WAIT_MS, this.lastFetch + SEARCH_INTERVAL_MS - Date.now());
            if (!(await this.wait(run, delay, "No Lobby Found", "No matching lobbies"))) return;
        }
    }

    async attempt(run: number, filter: MatchmakerFilter, first: boolean): Promise<Outcome>{
        if (!first && this.popup.isConnected){
            this.status.textContent = SCAN_LABEL;
            this.status.classList.remove("mm-fail");
            this.counter.textContent = "";
        }

        let lobbies: Lobby[];
        let pings: Record<string, number>;
        try {
            const [games, regionPings] = await Promise.all([this.gameList(), request("ping-regions", "regionPings", FETCH_TIMEOUT_MS)]);
            lobbies = readLobbies(games, filter, this.skip);
            pings = regionPings ?? {};
        }
        catch (error){
            console.error("[kute] matchmaker: no lobby list", error);
            return "failed";
        }
        if (this.cancelled(run)) return "joined";

        const ping = (lobby: Lobby): number => pings[lobby.server] ?? 999;
        const mapRanks = new Map(filter.preferredMaps.map((map, index) => [normalizeMap(map), index]));
        const modeRanks = new Map(filter.preferredModes.map((mode, index) => [mode, index]));
        const rank = (lobby: Lobby): number =>
            (modeRanks.get(lobby.mode) ?? modeRanks.size) * (mapRanks.size + 1) + (mapRanks.get(normalizeMap(lobby.map)) ?? mapRanks.size);
        const lastSlot = (lobby: Lobby): 0 | 1 => (lobby.limit - lobby.players <= 1 ? 1 : 0);
        const passing = lobbies.filter((lobby) => lobby.passes);
        passing.sort((a, b) => {
            const byRank = rank(a) - rank(b);
            const bySlot = lastSlot(a) - lastSlot(b);
            const byPing = ping(a) - ping(b);
            const byPlayers = b.players - a.players;
            if (filter.sortByPlayers) return byRank || bySlot || byPlayers || byPing;
            return byRank || bySlot || byPing || byPlayers;
        });
        this.candidates = passing;

        let best: Lobby | undefined;
        if (passing.length > 0){
            const top = passing[0];
            const pool = passing.filter(
                (lobby) =>
                    rank(lobby) === rank(top) &&
                    lastSlot(lobby) === lastSlot(top) &&
                    Math.abs(ping(lobby) - ping(top)) <= 20 &&
                    top.players - lobby.players <= 2,
            );
            best = pool[Math.floor(Math.random() * pool.length)];
        }

        if (filter.animation && first) await this.animateScan(run, lobbies, best);
        if (this.cancelled(run)) return "joined";
        if (!best) return "none";

        if (filter.animation){
            this.status.textContent = "Lobby Found!";
            this.status.classList.remove("mm-fail");
            this.feed.classList.add("mm-result");
            this.feed.replaceChildren(lobbyEntry(best, "mm-pass mm-found"));
            const pingText = pings[best.server] === undefined ? "?" : String(pings[best.server]);
            this.counter.textContent = `${best.mode} · ${REGIONS[best.region] ?? best.region} · ${pingText}ms`;
            await sleep(FOUND_HOLD_MS);
            if (this.cancelled(run)) return "joined";
        }
        return this.verifyAndJoin(run, best, filter);
    }

    async showFilters(): Promise<void>{
        const html = await import("../components/matchmakerFilters.html");
        const { filter } = this;

        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        const element = (id: string): HTMLInputElement => (shadow.querySelector(`#${id}`) as HTMLInputElement);

        const chips = (gridId: string, items: { value: string, label: string, icon?: string | null }[], picked: string[]): void => {
            const grid = element(gridId);
            grid.replaceChildren();
            for (const item of items){
                const chip = document.createElement("div");
                chip.className = `mmChip${picked.includes(item.value) ? " on" : ""}`;
                if (item.icon){
                    const img = document.createElement("img");
                    img.src = item.icon;
                    img.alt = "";
                    img.loading = "lazy";
                    img.onerror = (): void => img.remove();
                    chip.append(img);
                }
                chip.append(item.label);
                chip.onclick = (): void => {
                    const index = picked.indexOf(item.value);
                    if (index === -1) picked.push(item.value);
                    else picked.splice(index, 1);
                    chip.classList.toggle("on", index === -1);
                };
                grid.append(chip);
            }
        };

        interface RankedGroup {
            gridId: string;
            boxId: string;
            noun: string;
            values: string[];
            picked: string[];
            preferred: string[];
            label: (value: string) => string;
            icon: (value: string) => string | null;
        }

        const chipIcon = (url: string | null, chip: HTMLElement, lazy: boolean): void => {
            if (!url) return;
            const img = document.createElement("img");
            img.src = url;
            img.alt = "";
            if (lazy) img.loading = "lazy";
            else img.draggable = false;
            img.onerror = (): void => img.remove();
            chip.append(img);
        };

        const renderRanked = (group: RankedGroup): void => {
            const { preferred } = group;
            const box = element(group.boxId);
            box.hidden = preferred.length === 0;
            const list = box.querySelector(".mmGrid") as HTMLElement;
            list.replaceChildren();
            const renumber = (): void => list.querySelectorAll(".mmNum").forEach((num, index) => (num.textContent = String(index + 1)));

            for (const value of preferred){
                const chip = document.createElement("div");
                chip.className = "mmChip on mmRank";
                chip.append(span("mmNum", ""));
                chipIcon(group.icon(value), chip, false);
                chip.append(group.label(value));

                let drag: { x: number, y: number, moved: boolean } | null = null;
                chip.onpointerdown = (event): void => {
                    chip.setPointerCapture(event.pointerId);
                    drag = { x: event.clientX, y: event.clientY, moved: false };
                };
                chip.onpointermove = (event): void => {
                    if (!drag) return;
                    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
                    drag.moved = true;
                    chip.classList.add("dragging");
                    const children = [...list.children];
                    const target = children.findIndex((child) => {
                        const rect = child.getBoundingClientRect();
                        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
                    });
                    const from = children.indexOf(chip);
                    if (target === -1 || target === from) return;
                    preferred.splice(target, 0, ...preferred.splice(from, 1));
                    chip.remove();
                    list.insertBefore(chip, list.children[target] ?? null);
                    renumber();
                };
                chip.onpointerup = (): void => {
                    chip.classList.remove("dragging");
                    if (drag && !drag.moved){
                        preferred.unshift(...preferred.splice(preferred.indexOf(value), 1));
                        window.SOUND?.play("tick_0", 0.1);
                        renderRanked(group);
                    }
                    drag = null;
                };
                chip.onpointercancel = chip.onpointerup;
                list.append(chip);
            }
            renumber();
        };

        const renderStarred = (group: RankedGroup): void => {
            const { picked, preferred } = group;
            const grid = element(group.gridId);
            grid.replaceChildren();
            for (const value of group.values){
                const isPreferred = preferred.includes(value);
                const chip = document.createElement("div");
                chip.className = `mmChip${picked.includes(value) ? " on" : ""}${isPreferred ? " preferred" : ""}`;
                chipIcon(group.icon(value), chip, true);
                chip.append(group.label(value));
                const star = span("mmStar", "★");
                star.title = isPreferred ? "Preferred, click to remove" : `Prefer this ${group.noun}`;
                star.onclick = (event): void => {
                    event.stopPropagation();
                    if (isPreferred) preferred.splice(preferred.indexOf(value), 1);
                    else {
                        preferred.push(value);
                        if (picked.length > 0 && !picked.includes(value)) picked.push(value);
                    }
                    renderStarred(group);
                };
                chip.append(star);
                chip.onclick = (): void => {
                    const index = picked.indexOf(value);
                    if (index !== -1){
                        picked.splice(index, 1);
                        if (isPreferred) preferred.splice(preferred.indexOf(value), 1);
                    }
                    else if (picked.length === 0) picked.push(...new Set([...preferred, value]));
                    else picked.push(value);
                    renderStarred(group);
                };
                grid.append(chip);
            }
            renderRanked(group);
        };

        const fill = (): void => {
            chips("mmRegions", Object.entries(REGIONS).map(([value, label]) => ({ value, label })), filter.regions);
            renderStarred({
                gridId: "mmModes",
                boxId: "mmModeRanks",
                noun: "mode",
                values: MODE_FILTER,
                picked: filter.modes,
                preferred: filter.preferredModes,
                label: (value) => value,
                icon: () => null,
            });
            renderStarred({
                gridId: "mmMaps",
                boxId: "mmMapRanks",
                noun: "map",
                values: MAP_FILTER,
                picked: filter.maps,
                preferred: filter.preferredMaps,
                label: (value) => MAP_NAMES[value] ?? value,
                icon: mapIconUrl,
            });
            element("mmMinPlayers").value = String(filter.minPlayers);
            element("mmMaxPlayers").value = String(filter.maxPlayers);
            element("mmMinTime").value = String(filter.minTime);
            element("mmSkipRecent").value = String(filter.skipRecent);
            element("mmSortByPlayers").checked = filter.sortByPlayers;
            element("mmServerBrowser").checked = filter.serverBrowser;
            element("mmAnimation").checked = filter.animation;
            element("mmSearchAfterMatch").checked = filter.searchAfterMatch;
            element("mmCollectRewards").checked = filter.collectRewards;
            element("mmCollectDoubleXp").checked = filter.collectDoubleXp;
            element("mmKeepSearching").checked = filter.keepSearching;
            element("mmServerBrowser").disabled = filter.keepSearching;
        };
        element("mmKeepSearching").onchange = (): void => {
            element("mmServerBrowser").disabled = element("mmKeepSearching").checked;
        };
        filter.regions = [...filter.regions];
        filter.modes = [...filter.modes];
        filter.maps = [...filter.maps];
        filter.preferredMaps = [...filter.preferredMaps];
        filter.preferredModes = [...filter.preferredModes];
        fill();

        const number = (id: string, min: number, max: number, fallback: number): number => {
            const value = Number.parseInt(element(id).value, 10);
            return Number.isNaN(value) ? fallback : Math.min(max, Math.max(min, value));
        };

        const controller = new AbortController();
        const close = (): void => {
            controller.abort();
            overlay.remove();
            this.saveFilter({
                ...filter,
                minPlayers: number("mmMinPlayers", 0, 7, DEFAULT_FILTER.minPlayers),
                maxPlayers: number("mmMaxPlayers", 0, 7, DEFAULT_FILTER.maxPlayers),
                minTime: number("mmMinTime", 0, 480, DEFAULT_FILTER.minTime),
                skipRecent: number("mmSkipRecent", 0, MAX_SKIP_RECENT, DEFAULT_FILTER.skipRecent),
                sortByPlayers: element("mmSortByPlayers").checked,
                serverBrowser: element("mmServerBrowser").checked,
                animation: element("mmAnimation").checked,
                searchAfterMatch: element("mmSearchAfterMatch").checked,
                collectRewards: element("mmCollectRewards").checked,
                collectDoubleXp: element("mmCollectDoubleXp").checked,
                keepSearching: element("mmKeepSearching").checked,
            });
        };
        element("mmDone").onclick = close;
        element("mmReset").onclick = (): void => {
            Object.assign(filter, DEFAULT_FILTER, { regions: [], modes: [], maps: [], preferredMaps: [], preferredModes: [] });
            fill();
        };
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );
        document.body.append(overlay);
    }
}

export default new Matchmaker();
