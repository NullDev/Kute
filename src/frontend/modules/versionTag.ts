import { kute } from "../client";

class VersionTag {
    constructor(){
        if (!kute.version) return;

        const style = document.createElement("style");
        style.id = "kute_versionTagCSS";
        style.textContent = `
            #matchInfo > div:first-of-type::before {
                content: ${JSON.stringify(`Kute v${kute.version}`)};
                display: block;
                color: #35e0e8;
            }`;
        document.head.append(style);
    }
}

export default new VersionTag();
