import { kute } from "../client";
import playerLists, { clanTag, type Row } from "./playerLists";
import api from "./api";

const PAINT_PROPERTIES = new Set([
    "background",
    "background-image",
    "background-color",
    "background-clip",
    "-webkit-background-clip",
    "background-size",
    "background-position",
    "color",
    "-webkit-text-fill-color",
    "-webkit-text-stroke",
    "text-shadow",
    "text-decoration",
    "filter",
    "opacity",
    "animation",
]);

function paintOnly(css: string): string{
    return css
        .split(";")
        .map((declaration) => declaration.trim())
        .filter((declaration) => {
            const property = declaration.split(":")[0]?.trim().toLowerCase();
            return Boolean(property) && declaration.includes(":") && PAINT_PROPERTIES.has(property);
        })
        .join(";");
}

class ClanColors {
    styles: Record<string, string> = {};
    fetched: Record<string, string> = {};
    watching = false;
    decorator: (row: Row) => void = (row): void => this.restyle(row);

    constructor(){
        kute.settings.toggleClanColors = (enabled): void => this.toggle(enabled);
        this.load();
    }

    toggle(enabled: boolean): void{
        if (enabled){
            if (Object.keys(this.fetched).length > 0) this.apply(this.fetched);
            else this.load();
            return;
        }
        playerLists.remove(this.decorator);
        this.watching = false;
        this.styles = {};
        for (const span of document.querySelectorAll("[data-kute-clan]")){
            span.setAttribute("style", span.getAttribute("data-kute-style") ?? "");
            span.removeAttribute("data-kute-clan");
            span.removeAttribute("data-kute-style");
        }
    }

    async load(): Promise<void>{
        const meta = await api.request("/meta");
        if (typeof meta?.clanTagColors === "object" && meta.clanTagColors !== null) this.fetched = meta.clanTagColors;
        if (kute.settings.data.clanColors !== false) this.apply(this.fetched);
    }

    apply(styles: unknown): void{
        if (typeof styles !== "object" || styles === null) return;
        this.styles = {};
        for (const [tag, css] of Object.entries(styles)){
            if (typeof css !== "string" || tag.length === 0 || tag.length > 16) continue;
            const paint = paintOnly(css);
            if (paint) this.styles[tag] = paint;
        }
        if (Object.keys(this.styles).length === 0) return;

        if (this.watching) playerLists.refresh();
        else playerLists.add(this.decorator);
        this.watching = true;
    }

    restyle(row: Row): void{
        const clan = clanTag(row.element);
        if (!clan) return;
        const css = this.styles[clan.tag];
        if (!css || clan.span.getAttribute("data-kute-clan") === clan.tag) return;
        if (!clan.span.hasAttribute("data-kute-style")) clan.span.setAttribute("data-kute-style", clan.span.getAttribute("style") ?? "");
        clan.span.setAttribute("style", css);
        clan.span.setAttribute("data-kute-clan", clan.tag);
    }
}

const clanColors = new ClanColors();
kute.clanColors = clanColors;
export default clanColors;
