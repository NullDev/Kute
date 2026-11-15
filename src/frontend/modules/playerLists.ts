export type ListKind = "leader" | "ingame" | "alt" | "end";

export interface Row {
    element: Element;
    name: string;
    kind: ListKind;
}

type Decorator = (row: Row) => void;

type WalkEnd = (kind: ListKind) => void;

type Watched = { observer: MutationObserver, target: Element, list: string, kind: ListKind };

const CLAN_TAG = /^\s*\[(.+)\]\s*$/;

export function clanTag(nameElement: Element): { span: Element, tag: string } | null{
    for (const span of nameElement.children){
        if (span.tagName !== "SPAN") continue;
        const match = CLAN_TAG.exec(span.textContent ?? "");
        if (match) return { span, tag: match[1] };
    }
    return null;
}

const LISTS = [
    { list: "leaderContainer", kind: "leader", root: "leaderboardHolder" },
    { list: "ingameTable", kind: "ingame", root: "centerLeaderDisplay" },
    { list: "endTable", kind: "end", root: "endUI" },
    { list: "playerListH", kind: "alt", root: "menuWindow" },
] as { list: string, kind: ListKind, root: string }[];

const DISCOVERY_MS = 1000;

const NAME_ELEMENTS = ".pListName, [class^=\"newLeaderName\"], [class^=\"leaderName\"], .endTableN";

function nameOf(nameElement: Element): string{
    let name = "";
    for (const node of nameElement.childNodes){
        if (node.nodeType === Node.TEXT_NODE) name += node.textContent ?? "";
    }
    return name.trim();
}

class PlayerLists {
    decorators: Map<Decorator, WalkEnd | undefined> = new Map();
    watched: Watched[] = [];
    timer = 0;

    add(decorator: Decorator, onWalkEnd?: WalkEnd): void{
        this.decorators.set(decorator, onWalkEnd);
        if (this.watched.length === 0) this.observe();
        this.refresh();
    }

    remove(decorator: Decorator): void{
        this.decorators.delete(decorator);
        if (this.decorators.size > 0) return;
        for (const { observer } of this.watched) observer.disconnect();
        this.watched = [];
        clearInterval(this.timer);
        this.timer = 0;
    }

    observe(): void{
        for (const { root, list, kind } of LISTS){
            const element = document.getElementById(root);
            if (element) this.watch(element, list, kind);
        }
        this.timer = setInterval(() => this.discover(), DISCOVERY_MS);
    }

    watch(target: Element, list: string, kind: ListKind): void{
        const entry = { observer: new MutationObserver(() => this.walk(entry)), target, list, kind };
        entry.observer.observe(target, { childList: true, subtree: true });
        this.watched.push(entry);
        this.walk(entry);
    }

    discover(): void{
        this.watched = this.watched.filter((entry) => {
            if (entry.target.isConnected) return true;
            entry.observer.disconnect();
            return false;
        });
        for (const { list, kind } of LISTS){
            const element = document.getElementById(list);
            if (element && !this.watched.some((entry) => entry.target.contains(element))) this.watch(element, list, kind);
        }
    }

    refresh(): void{
        for (const entry of this.watched) this.walk(entry);
    }

    walk(entry: Watched): void{
        const lists = document.querySelectorAll(`#${entry.list}`);
        if (lists.length > 0){
            for (const list of lists){
                for (const element of list.querySelectorAll(NAME_ELEMENTS)){
                    const row = { element, name: nameOf(element), kind: entry.kind };
                    for (const decorator of this.decorators.keys()) decorator(row);
                }
            }
            for (const onWalkEnd of this.decorators.values()) onWalkEnd?.(entry.kind);
        }
        entry.observer.takeRecords();
    }
}

export default new PlayerLists();
