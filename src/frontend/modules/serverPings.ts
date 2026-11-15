import { request } from "../utils";

const PING_ATTR = "data-kute-ping";
const MAX_AGE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const PREFIX_REGIONS: Record<string, string> = {
    FRA: "de-fra", NY: "us-nj", DAL: "us-tx", SV: "us-ca-sv", BRZ: "brz", SIN: "sgp", TOK: "jb-hnd", SYD: "au-syd",
    MBI: "as-mb", BHN: "me-bhn", SSS: "sss",
};

const NAME_REGIONS: Record<string, string> = {
    "New York": "us-nj", Dallas: "us-tx", Frankfurt: "de-fra", "Silicon Valley": "us-ca-sv", Sydney: "au-syd",
    Tokyo: "jb-hnd", Singapore: "sgp", Mumbai: "as-mb", Brazil: "brz", "Middle East": "me-bhn",
    "EU Super Secret Servers": "sss",
};

const STYLE = `
#serverHolder .settNameIn .kutePing { float: right; margin-right: 8px; color: #35e0e8; font-size: 13px; line-height: 44px; }
#serverHolder .setHed .kutePing { float: right; margin-right: 14px; color: #35e0e8; font-size: 0.75em; line-height: 42px; }
`;

const label = (ping: number | undefined): string => (ping === undefined ? "" : `${ping} ms`);

class ServerPings {
    pings: Record<string, number> = {};
    fetchedAt = 0;
    fetching = false;
    pending: number | null = null;
    observer = new MutationObserver(() => {
        if (this.pending === null) this.pending = setTimeout(() => this.scan(), 150);
    });
    menu: HTMLElement | undefined;

    constructor(){
        const style = document.createElement("style");
        style.textContent = STYLE;
        document.head.append(style);
        const menu = document.getElementById("menuWindow");
        if (!menu) return;
        this.menu = menu;
        this.observer.observe(menu, { childList: true, subtree: true });
    }

    refresh(): void{
        if (this.fetching || Date.now() - this.fetchedAt < MAX_AGE_MS) return;
        this.fetching = true;
        request("ping-regions", "regionPings", REQUEST_TIMEOUT_MS).then((pings) => {
            this.fetching = false;
            this.fetchedAt = Date.now();
            if (!pings) return;
            this.pings = pings;
            this.menu?.querySelectorAll(".kutePing").forEach((element) => element.remove());
            this.menu?.querySelectorAll(`[${PING_ATTR}]`).forEach((element) => element.removeAttribute(PING_ATTR));
            this.scan();
        });
    }

    scan(): void{
        this.pending = null;
        const holder = document.getElementById("serverHolder");
        if (!holder) return;
        this.refresh();
        if (Object.keys(this.pings).length === 0) return;
        this.observer.disconnect();
        this.labelRows(holder);
        this.sortRegions(holder);
        if (this.menu) this.observer.observe(this.menu, { childList: true, subtree: true });
    }

    labelRows(holder: HTMLElement): void{
        for (const row of holder.querySelectorAll(`.settNameIn:not([${PING_ATTR}])`)){
            row.setAttribute(PING_ATTR, "");
            const prefix = /checkedSwitchServer\("([A-Z]+):/.exec(row.getAttribute("onclick") ?? "")?.[1];
            const ping = prefix ? this.pings[PREFIX_REGIONS[prefix]] : undefined;
            const icon = row.querySelector(".serverPing");
            if (ping === undefined || !icon) continue;
            const text = document.createElement("span");
            text.className = "kutePing";
            text.textContent = label(ping);
            icon.after(text);
        }
    }

    sortRegions(holder: HTMLElement): void{
        const blocks: { nodes: Element[], ping: number }[] = [];
        for (const child of holder.children){
            if (child.classList.contains("setHed")){
                const name = Array.from(child.childNodes, (node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : "")).join("").trim();
                const ping = this.pings[NAME_REGIONS[name]];
                if (ping !== undefined && !child.hasAttribute(PING_ATTR)){
                    child.setAttribute(PING_ATTR, "");
                    const text = document.createElement("span");
                    text.className = "kutePing";
                    text.textContent = label(ping);
                    child.querySelector(".quickJoin")?.before(text);
                }
                blocks.push({ nodes: [child], ping: ping ?? -1 });
            }
            else blocks.at(-1)?.nodes.push(child);
        }
        if (blocks.length < 2) return;
        const sorted = blocks.map((block, index) => ({ ...block, index })).sort((a, b) => (a.ping - b.ping) || (a.index - b.index));
        if (sorted.every((block, index) => block.index === index)) return;
        for (const block of sorted) holder.append(...block.nodes);
    }
}

export default new ServerPings();
