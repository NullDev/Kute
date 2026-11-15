interface GameSetting {
    id: string;
    label: string;
    cheap: string|boolean;
    needsReload?: boolean;
    fightOnly?: boolean;
}

export const SETTINGS: GameSetting[] = [
    { id: "postProcessing", label: "Post Processing", cheap: false },
    { id: "shadowsDynamic", label: "Dynamic Shadows", cheap: false },
    { id: "softShad", label: "Soft Shadows", cheap: false, needsReload: true },
    { id: "highResShad", label: "High-Res Shadows", cheap: false, needsReload: true },
    { id: "shadows", label: "Shadows", cheap: false },
    { id: "antiAlias", label: "Antialiasing", cheap: false, needsReload: true },
    { id: "reflection", label: "Reflection Quality", cheap: "1", needsReload: true },
    { id: "lighting", label: "Lighting", cheap: "0", needsReload: true },
    { id: "weaponShine", label: "Weapons Shine", cheap: false },
    { id: "ambientShading", label: "Old Shading", cheap: false },
    { id: "particles", label: "Particles", cheap: false, fightOnly: true },
    { id: "showExplo", label: "Explosions", cheap: false, fightOnly: true },
    { id: "textureAnim", label: "Texture Animations", cheap: false },
    { id: "objectAnim", label: "Object Animations", cheap: false },
    { id: "bulletCasings", label: "Bullet Casings", cheap: false, fightOnly: true },
    { id: "impactHoles", label: "Bullet Impact Holes", cheap: false, fightOnly: true },
    { id: "noPaintAnim", label: "Disable Animated Paints", cheap: true, needsReload: true },
    { id: "mapDet", label: "Map Details", cheap: false, needsReload: true },
    { id: "lowSpec", label: "Low Spec", cheap: true },
];

export const PRESET: Record<string, string | boolean> = {
    postProcessing: false,
    particles: false,
    showExplo: false,
    bulletCasings: false,
    impactHoles: false,
    reflection: "1",
    lighting: "0",
    softShad: false,
    highResShad: false,
    noPaintAnim: true,
};

export const RESOLUTION = "resolution";
export const GAME_FRAME_CAP = "updateRate";

export const ALL_IDS = [...SETTINGS.map((setting) => setting.id), RESOLUTION, GAME_FRAME_CAP];

export function label(id: string): string{
    return SETTINGS.find((setting) => setting.id === id)?.label ?? id;
}

let settingsDocument: Document | null = null;

function renderedSettings(): Document{
    if (settingsDocument) return settingsDocument;
    const settingsWindow = window.windows[0];
    const previousTab = settingsWindow.tabIndex;
    const previousType = settingsWindow.settingType;
    let html = "";
    try {
        settingsWindow.settingType = "advanced";
        for (let tab = 0; tab < settingsWindow.tabs.advanced.length - 1; tab++){
            settingsWindow.tabIndex = tab;
            html += settingsWindow.getSettings();
        }
    }
    finally {
        settingsWindow.tabIndex = previousTab;
        settingsWindow.settingType = previousType;
    }
    settingsDocument = new DOMParser().parseFromString(html, "text/html");
    return settingsDocument;
}

export function resetCache(): void{
    settingsDocument = null;
}

export function read(id: string): string | null{
    const stored = localStorage.getItem(`kro_setngss_${id}`);
    if (stored !== null) return stored;

    for (const input of renderedSettings().querySelectorAll("input, select")){
        const handler = input.getAttribute("onchange") ?? input.getAttribute("oninput") ?? input.getAttribute("onclick") ?? "";
        if (!handler.includes(`setSetting("${id}"`)) continue;
        const element = input as HTMLInputElement;
        return element.type === "checkbox" ? String(element.hasAttribute("checked")) : element.getAttribute("value") ?? element.value;
    }
    return null;
}

export function write(id: string, value: string | boolean): void{
    let typed = value;
    if (value === "true") typed = true;
    else if (value === "false") typed = false;
    window.setSetting(id, typed);
}

export function opposite(value: string): string{
    return value === "true" ? "false" : "true";
}
