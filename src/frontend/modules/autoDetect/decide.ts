import { TARGET_REFRESH_MULTIPLE } from "./policy";

export const SIGNIFICANT_SETTING = 1.05;
export const SIGNIFICANT_RESOLUTION = 1.1;
export const MIN_RESOLUTION = 0.75;

export interface MeasuredSetting {
    id: string;
    label: string;
    current: string;
    cheap: string;
    gain: number | null;
    steady: boolean;
    note?: string;
    raw?: number[];
    confirmGain?: number;
}

interface Change {
    id: string;
    label: string;
    value: string | number | boolean;
    reason: string;
}

export interface QualityPlan {
    target: number;
    needed: number;
    holds: boolean;
    regime: "cpu" | "gpu" | "unknown";
    predictedFps: number;
    tuneResolution: boolean;
    changes: Change[];
}

export function decide({ capacity, hz, headroom, halfResolutionGain, settings }: { capacity: number, hz: number, headroom: number, halfResolutionGain: number | null, settings: MeasuredSetting[] }): QualityPlan{
    const target = hz * TARGET_REFRESH_MULTIPLE;
    const needed = target * headroom;
    const holds = capacity >= needed;

    let regime: QualityPlan["regime"] = "unknown";
    if (halfResolutionGain !== null) regime = halfResolutionGain >= SIGNIFICANT_RESOLUTION ? "gpu" : "cpu";

    const changes: Change[] = [];
    let predictedFps = capacity;
    if (!holds){
        const helpful = settings
            .filter((setting) => setting.gain !== null && setting.steady && setting.current !== setting.cheap && setting.gain >= SIGNIFICANT_SETTING)
            .sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0));
        for (const setting of helpful){
            if (predictedFps >= needed) break;
            const gain = setting.gain ?? 1;
            predictedFps *= gain;
            changes.push({ id: setting.id, label: setting.label, value: setting.cheap, reason: `measured +${Math.round((gain - 1) * 100)} %` });
        }
    }

    return {
        target,
        needed,
        holds,
        regime,
        predictedFps,
        tuneResolution: !holds && regime === "gpu" && predictedFps < needed,
        changes,
    };
}
