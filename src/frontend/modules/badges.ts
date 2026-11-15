import { kute } from "../client";
import playerLists, { clanTag, type Row } from "./playerLists";
import presence, { playerHash } from "./presence";
import badge from "../components/badge.webp";
import devBadge from "../components/devBadge.webp";

type Candidate = { row: Row, hash: string, tag: string | undefined };

const ICON_GAP = "2px";
const PLACEMENT = {
    leader: "margin-top:5px;vertical-align:middle;height:21px;margin-left:2px",
    ingame: "margin-top:3px;vertical-align:middle;height:21px;margin-left:2px",
    end: "margin-top:-12px;vertical-align:middle;width:26px;margin-left:2px",
    alt: "vertical-align:middle;height:21px;margin-left:6px;position:relative;top:-0.35em",
};

const ART = { kute: badge, dev: devBadge };
const TITLE = { kute: "Kute", dev: "Kute Developer" };

function removeBadges(kind?: "kute" | "dev"): void{
    const badges = kind ? `[data-kute-badge="${kind}"]` : "[data-kute-badge]";
    for (const img of document.querySelectorAll(badges)) img.remove();
    const rows = kind ? `[data-kute-badged="${kind}"]` : "[data-kute-badged]";
    for (const element of document.querySelectorAll(rows)) element.removeAttribute("data-kute-badged");
}

function removeBadgeOf(element: Element): void{
    const img = element.querySelector("[data-kute-badge]") ?? element.parentElement?.querySelector("[data-kute-badge]");
    img?.remove();
    element.removeAttribute("data-kute-badged");
}

class Badges {
    game = "";
    hashes: Map<string, string> = new Map();
    pending: Set<string> = new Set();
    found = false;
    candidates: Candidate[] = [];
    enabled = kute.settings.data.cuteBadge !== false;
    decorator: (row: Row) => void = (row): void => this.decorate(row);
    finisher = (): void => this.finish();

    constructor(){
        kute.settings.toggleCuteBadge = (enabled): void => this.toggle(enabled);
        presence.listeners.add(() => this.rosterChanged());
    }

    toggle(enabled: boolean): void{
        this.enabled = enabled;
        if (!enabled) removeBadges("kute");
        playerLists.refresh();
    }

    rosterChanged(): void{
        if (presence.game !== this.game){
            this.game = presence.game;
            this.hashes.clear();
            this.pending.clear();
        }
        removeBadges();
        if (presence.roster.size === 0){
            playerLists.remove(this.decorator);
            return;
        }
        playerLists.add(this.decorator, this.finisher);
    }

    decorate(row: Row): void{
        if (presence.roster.size === 0 || row.name === "") return;
        const hash = this.hashes.get(row.name);
        if (hash === undefined){
            this.learn(row.name);
            return;
        }
        if (presence.devs.has(hash)){
            this.candidates.push({ row, hash, tag: clanTag(row.element)?.tag });
            return;
        }
        if (this.enabled && !row.element.hasAttribute("data-kute-badged") && presence.roster.has(hash)) this.insert(row, "kute");
    }

    finish(): void{
        if (this.candidates.length === 0) return;
        const claims: Map<string, Candidate[]> = new Map();
        for (const candidate of this.candidates){
            const group = claims.get(candidate.hash);
            if (group) group.push(candidate);
            else claims.set(candidate.hash, [candidate]);
        }

        for (const [hash, group] of claims){
            const tagged = group.filter((candidate) => candidate.tag === presence.devs.get(hash));
            let winner = null;
            if (tagged.length === 1) winner = tagged[0].row;
            else if (tagged.length === 0 && group.length === 1) winner = group[0].row;

            for (const candidate of group){
                const drawn = candidate.row.element.getAttribute("data-kute-badged");
                if (candidate.row !== winner){
                    if (drawn) removeBadgeOf(candidate.row.element);
                    continue;
                }
                if (drawn === "dev") continue;
                if (drawn) removeBadgeOf(candidate.row.element);
                this.insert(candidate.row, "dev");
            }
        }
        this.candidates.length = 0;
    }

    async learn(name: string): Promise<void>{
        if (this.pending.has(name)) return;
        this.pending.add(name);
        const { game } = this;
        const hash = await playerHash(game, name);
        if (game !== this.game) return;
        this.pending.delete(name);
        this.hashes.set(name, hash);
        if (presence.roster.has(hash)) this.found = true;
        if (this.pending.size > 0 || !this.found) return;
        this.found = false;
        playerLists.refresh();
    }

    insert(row: Row, kind: "kute" | "dev"): void{
        const { element } = row;
        const parent = element.parentElement;
        if (!parent) return;
        const img = document.createElement("img");
        img.src = ART[kind];
        img.setAttribute("data-kute-badge", kind);
        img.alt = "";
        img.title = TITLE[kind];
        img.style.cssText = PLACEMENT[row.kind];
        if (row.kind === "alt") element.append(img);
        else if (row.kind === "end") parent.insertBefore(img, element.nextSibling);
        else parent.insertBefore(img, parent.firstElementChild?.nextSibling ?? element);
        if (img.nextElementSibling?.tagName === "I") img.style.marginRight = ICON_GAP;
        element.setAttribute("data-kute-badged", kind);
    }
}

const badges = new Badges();
kute.badges = badges;
export default badges;
