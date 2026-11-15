import { kute } from "../client";

class ShowPing {
    originalGenList: () => string = window.windows[22].genList;
    template = document.createElement("template");

    constructor(){
        kute.settings.toggleShowPing = (enabled): void => this.toggle(enabled);

        this.toggle(true);
    }

    toggle(enabled: boolean): void{
        const showPing = this;
        if (enabled){
            window.windows[22].genList = function(this: object): string{
                return showPing.modifiedGenList(this);
            };
        }
        else window.windows[22].genList = this.originalGenList;
    }

    modifiedGenList(listWindow: object): string{
        const htmlString = this.originalGenList.call(listWindow);

        this.template.innerHTML = htmlString;
        const pingIcons = this.template.content.querySelectorAll(".pListPing.material-icons");

        for (const icon of pingIcons){
            const pingValue = icon.getAttribute("title");

            icon.classList.remove("pListPing", "material-icons");
            icon.removeAttribute("title");

            icon.textContent = `${pingValue ? pingValue : "N/A"} `;
        }
        return this.template.innerHTML;
    }
}

export default new ShowPing();
