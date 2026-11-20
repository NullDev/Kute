import styles from "../components/menuTimer.css";
import { kute } from "../client";

const STYLE_ID = "kute_menuTimerCSS";

class MenuTimer {
    constructor(){
        kute.settings.toggleMenuTimer = (enabled): void => this.toggle(enabled);
        this.toggle(kute.settings.data.menuTimer !== false);
    }

    toggle(enabled: boolean): void{
        const existing = document.getElementById(STYLE_ID);
        if (!enabled){
            existing?.remove();
            return;
        }
        if (existing) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = styles;
        document.head.append(style);
    }
}

export default new MenuTimer();
