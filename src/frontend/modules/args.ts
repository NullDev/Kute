import { kute } from "../client";
import { waitForElement } from "../utils";

interface CompHostParams {
    mapId: string;
    team1Name: string;
    team2Name: string;
    teamSize: string;
    team1Players?: string;
    team2Players?: string;
    spectators?: string;
    classes?: string;
    webhook?: string;
    region?: string;
}

const automateCompHost = async(params: CompHostParams): Promise<void> => {
    window.openHostWindow(false, 1);
    await waitForElement(".hostTb0");
    let mapCheckbox = document.querySelector(`#${params.mapId}`) as HTMLInputElement|null;

    if (!mapCheckbox){
        const allMapNameElements = document.querySelectorAll(".hostMap .hostMapName") as NodeListOf<HTMLElement>;
        const targetNameElement = Array.from(allMapNameElements).find(
            (el) => el.innerText.trim().toLowerCase() === params.mapId.toLowerCase(),
        );
        if (targetNameElement){
            mapCheckbox = (targetNameElement.parentElement?.querySelector('input[type="checkbox"]') ?? null) as HTMLInputElement|null;
        }
    }

    if (!mapCheckbox) return;

    if (!mapCheckbox.checked) mapCheckbox.click();

    windows[7].switchTab(2);

    const team1Input: HTMLInputElement = await waitForElement("#customSnameTeam1");
    team1Input.value = params.team1Name;
    const team2Input: HTMLInputElement = await waitForElement("#customSnameTeam2");
    team2Input.value = params.team2Name;

    const teamSizeSelect: HTMLSelectElement = await waitForElement("#customStmSize");

    const teamSizeMap: Record<string, string> = {
        "1v1": "0",
        "2v2": "1",
        "3v3": "2",
        "4v4": "3",
    };

    if (params.team1Players){
        const compRosterT1: HTMLInputElement = await waitForElement("#compRosterT1");
        compRosterT1.value = params.team1Players;
    }
    if (params.team2Players){
        const compRosterT2: HTMLInputElement = await waitForElement("#compRosterT2");
        compRosterT2.value = params.team2Players;
    }

    if (params.spectators){
        const compSpectators: HTMLInputElement = await waitForElement("#compRosterSpecs");
        compSpectators.value = params.spectators;
    }

    const customSspecSlots: HTMLInputElement = await waitForElement("#customSspecSlots");
    customSspecSlots.value = "4";

    const gunMap = [
        "ak",
        "sniper",
        "smg",
        "lmg",
        "shotgun",
        "rev",
        "semi",
        "rpg",
        "uzi",
        "runner",
        "deagler",
        "crossbow",
        "famas",
        "blaster",
        "survivor",
        "infiltrator",
    ];

    if (params.classes){
        const classes = JSON.parse(params.classes);
        for (const [gunName, limit] of Object.entries(classes)){
            const id = gunMap.indexOf(gunName);
            const element: HTMLInputElement = await waitForElement(`#customSclassLim${id}`);
            element.value = String(limit);
        }
    }

    const finalTeamSize = teamSizeMap[params.teamSize] || params.teamSize;
    teamSizeSelect.value = finalTeamSize;

    if (params.webhook){
        try {
            const webhookInput: HTMLInputElement = await waitForElement("#customSwebhook");
            webhookInput.value = decodeURIComponent(params.webhook);
        }
        catch {}
    }
    window.createPrivateRoom();
};

const changeRegion = async(region: string): Promise<void> => {
    const regionMap: Record<string, string> = {
        FRA: "de-fra",
        SV: "us-ca-sv",
        SYD: "au-syd",
        TOK: "jb-hnd",
        SIN: "sgp",
        NY: "us-nj",
        MUM: "as-mb",
        DAL: "us-tx",
        BR: "brz",
        ME: "me-bhn",
    };

    const normalizedRegion = regionMap[region.toUpperCase()] || region;

    window.showWindow(1);

    const selectRoot = document.querySelector("select.inputGrey2") as HTMLSelectElement|null;
    if (!selectRoot){
        if (typeof window.setSetting === "function"){
            window.setSetting("defaultRegion", normalizedRegion);
        }
        return;
    }

    const regionValues = Object.values(regionMap);
    const regionSelect =
        Array.from(document.querySelectorAll("select.inputGrey2") as NodeListOf<HTMLSelectElement>).find((select) =>
            Array.from(select.options).some((opt) => regionValues.includes(opt.value)),
        ) || selectRoot;

    if (regionSelect && regionSelect.value !== normalizedRegion){
        const optionIndex = Array.from(regionSelect.options).findIndex((opt) => opt.value === normalizedRegion);
        if (optionIndex !== -1){
            regionSelect.selectedIndex = optionIndex;
            regionSelect.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        }
    }

    window.showWindow(1);
};

const parseQueryString = (str: string): Record<string, string> => {
    const query = str.includes("?") ? str.split("?")[1] : str;
    return Object.fromEntries(new URLSearchParams(query).entries());
};

const pendingParams = sessionStorage.getItem("pendingCompHost");
if (pendingParams){
    sessionStorage.removeItem("pendingCompHost");
    const params = JSON.parse(pendingParams);
    automateCompHost(params);
}

kute.parseArgs = async(args: string): Promise<void> => {
    const argList = args.split(" ");
    for (const arg of argList){
        if (arg.includes("action=host-comp")){
            const params = parseQueryString(arg) as unknown as CompHostParams;
            if (params.region){
                sessionStorage.setItem("pendingCompHost", JSON.stringify(params));
                await changeRegion(params.region);
                window.location.href = "https://krunker.io/";
            }
            else {
                await automateCompHost(params);
            }
        }
    }
};

window.chrome.webview.addEventListener("message", async(event) => {
    if (!event.data?.args) return;
    await kute.parseArgs(event.data.args);
});

