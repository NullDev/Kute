import type { ChartPoint } from "./chart";

type Segment = { from: ChartPoint, to: ChartPoint, gap: boolean };

export function lineSegments(points: ChartPoint[], index: number, step: number): Segment[]{
    const segments: Segment[] = [];
    let previous: ChartPoint | null = null;
    let missing = false;
    for (const point of points){
        const value = point.values[index];
        if (value === null || value === undefined || !Number.isFinite(value)){
            missing = true;
            continue;
        }
        if (previous) segments.push({ from: previous, to: point, gap: missing || point.t - previous.t > step * 1.5 });
        previous = point;
        missing = false;
    }
    return segments;
}
