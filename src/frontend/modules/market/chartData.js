/** @param {import("./chart.js").ChartPoint[]} points @param {number} index @param {number} step */
export function lineSegments(points, index, step){
    /** @type {{from:import("./chart.js").ChartPoint,to:import("./chart.js").ChartPoint,gap:boolean}[]} */
    const segments = [];
    /** @type {import("./chart.js").ChartPoint|null} */
    let previous = null;
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
