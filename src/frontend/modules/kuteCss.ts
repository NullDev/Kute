import { kute } from "../client";
import remap from "../components/kuteThemeRemap.css";
import theme from "../components/kuteTheme.css";

const css = remap + theme;

class KuteCss {
    sheet: CSSStyleSheet | null = null;

    constructor(){
        kute.settings.toggleKuteCss = (enabled): void => this.toggle(enabled);
        this.toggle(true);
    }

    toggle(enabled: boolean): void{
        if (!enabled){
            this.sheet?.replaceSync("");
            return;
        }
        if (!this.sheet){
            this.sheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [this.sheet, ...document.adoptedStyleSheets];
        }
        this.sheet.replaceSync(css);
    }
}

export default new KuteCss();
