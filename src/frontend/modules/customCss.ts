import { kute, ready } from "../client";

const IMPORTS = /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi;

export const hostSupportsCustomCss = (): boolean => kute.hostFeatures?.includes("custom-css") ?? false;

class CustomCss {
    saved = String((window as any).__kuteCustomCss ?? "");
    enabled = true;
    sheet: CSSStyleSheet | null = null;
    importStyle: HTMLStyleElement | null = null;
    importText = "";
    waitingForBody = false;

    constructor(){
        if (this.saved) this.apply(this.saved);

        ready.then(() => {
            kute.settings.toggleCustomCss = (enabled): void => this.toggle(enabled);
            if (kute.settings.data.customCss === false) this.toggle(false);
            else if (!this.saved && hostSupportsCustomCss()) this.load().then((css) => this.apply(css));
        });
    }

    load(): Promise<string>{
        return new Promise((resolve) => {
            const listener = (event: MessageEvent): void => {
                if (typeof event.data?.customCss?.content !== "string") return;
                window.chrome.webview.removeEventListener("message", listener);
                this.saved = event.data.customCss.content;
                resolve(this.saved);
            };
            window.chrome.webview.addEventListener("message", listener);
            window.chrome.webview.postMessage("css-read");
        });
    }

    apply(css: string): void{
        if (!this.enabled) return;
        const imports = css.match(IMPORTS) ?? [];
        const rules = imports.length ? css.replace(IMPORTS, "") : css;
        if (!this.sheet){
            if (!rules.trim()) return;
            this.sheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
        }
        this.sheet.replaceSync(rules);
        this.setImports(imports.join("\n"));
    }

    setImports(text: string): void{
        this.importText = text;
        if (!text && !this.importStyle) return;
        if (document.readyState === "loading"){
            if (this.waitingForBody) return;
            this.waitingForBody = true;
            document.addEventListener("DOMContentLoaded", () => this.setImports(this.importText), { once: true });
            return;
        }
        if (!this.importStyle){
            this.importStyle = document.createElement("style");
            document.documentElement.append(this.importStyle);
        }
        if (this.importStyle.textContent !== text) this.importStyle.textContent = text;
    }

    toggle(enabled: boolean): void{
        this.enabled = enabled;
        if (!enabled){
            this.sheet?.replaceSync("");
            this.setImports("");
            return;
        }
        if (this.saved) this.apply(this.saved);
        else if (hostSupportsCustomCss()) this.load().then((css) => this.apply(css));
    }

    markSaved(css: string): void{
        this.saved = css;
        this.apply(css);
    }

    revert(): void{
        if (this.enabled) this.apply(this.saved);
    }
}

export default new CustomCss();
