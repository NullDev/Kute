import { getElement } from "../utils";
import { mapImageUrl, mapLabel, officialMaps } from "./maps";
import { chosenSound, kuteSound, volume } from "./queueSound";

const externalQueue: HTMLButtonElement = document.createElement("button");

externalQueue.textContent = "open_in_new";
externalQueue.style = `background-color: #5ce05a;
    color: #ffffff;
    border-radius: 9px;
    padding: 20px 21px;
    font-family: 'Material Icons Outlined';
    cursor: pointer;
    font-size: 20px;
    text-shadow: 2px 2px 0px black !important;
	margin-left: 2px;`;

const origRanked = window.openRankedMenu;
window.openRankedMenu = (): void => {
    origRanked();
    const footer = getElement(".footer-controls");
    const lastChild = footer.lastElementChild;
    footer.insertBefore(externalQueue, lastChild);
};

function openExtQueue(): void{
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;
    const windowWidth = 850;
    const windowHeight = 350;
    const left = (screenWidth - windowWidth) / 2;
    const top = (screenHeight - windowHeight) / 2;
    const queueWindow: (Window & { info?: { allRegions: boolean; token: string; region: string; sound: string; fallbackSound: string; volume: () => number; maps: Record<string, { url: string; number: number; }>; }; }) | null = window.open(
        "about:blank",
        "_blank",
        `width=${windowWidth},height=${windowHeight},left=${left},top=${top}`,
    );
    if (!queueWindow) return;

    let region = (getElement(".region-indicator").textContent ?? "").split(": ")[1];
    switch (region){
        case "North America":
            region = "na";
            break;
        case "Europe":
            region = "eu";
            break;
        case "Asia":
            region = "as";
            break;
        default:
            break;
    }
    let token = localStorage.getItem("__FRVR_auth_access_token") ?? "";
    token = token.replace(/"/g, "");
    token = token.replace("/", "");
    const allRegions = localStorage.getItem("s_rankedAllRegions") === "true";
    Promise.all([
        import("../components/queue/index.html"),
        import("popup-script:../components/queue/queue.ts"),
        chosenSound(),
        kuteSound(),
        officialMaps(),
    ]).then(([html, code, sound, fallbackSound, mapEntries]) => {
        const maps = Object.fromEntries(mapEntries.map(([id, name]) => [mapLabel(name), { url: mapImageUrl(id), number: id }]));
        queueWindow.info = { allRegions, token, region, sound, fallbackSound, volume, maps };

        const doc = new DOMParser().parseFromString(html.default, "text/html");
        queueWindow.document.head.append(...Array.from(doc.head.children, (child) => queueWindow.document.importNode(child, true)));
        queueWindow.document.body.append(...Array.from(doc.body.children, (child) => queueWindow.document.importNode(child, true)));

        const script = queueWindow.document.createElement("script");
        script.textContent = code.default;
        queueWindow.document.head.append(script);
    });
}

externalQueue.onclick = openExtQueue;
