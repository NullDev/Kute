import cSettings from "../cSettings.json";

export const PERFORMANCE_VALUES: Record<string, boolean | null> = Object.fromEntries(
    Object.values(cSettings as Record<string, {id: string, performance?: boolean|null}>)
        .filter((setting) => setting.performance !== undefined)
        .map((setting) => [setting.id, setting.performance ?? null]),
);

const stored: Record<string, any> = {};

export function hiddenByPerformance(data: Record<string, any>, id: string): boolean{
    return data.performanceMode === true && id in PERFORMANCE_VALUES;
}

export function playerValues(data: Record<string, any>): Record<string, any>{
    return { ...data, ...stored };
}

export function overridePerformance(data: Record<string, any>, on: boolean): string[]{
    const changed: string[] = [];
    for (const [id, value] of Object.entries(PERFORMANCE_VALUES)){
        if (value === null) continue;
        const before = data[id];
        if (on){
            if (!(id in stored)) stored[id] = before;
            data[id] = value;
        }
        else if (id in stored){
            data[id] = stored[id];
            delete stored[id];
        }
        if (data[id] !== before) changed.push(id);
    }
    return changed;
}
