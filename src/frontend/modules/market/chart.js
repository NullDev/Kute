import { esc, money } from "./presentation.js";
import { lineSegments } from "./chartData.js";

/**
 * @typedef {{t:number,values:(number|null)[],volume?:number|null}} ChartPoint
 * @typedef {{label:string,color:string}} Series
 * @typedef {{volume?:boolean,stepMs?:number}} ChartOptions
 */

export default class MarketChart {
    /** @param {HTMLElement} host @param {ChartPoint[]} points @param {Series[]} series @param {ChartOptions} [options] */
    constructor(host, points, series, options = {}){
        this.host = host;
        this.points = points;
        this.series = series;
        this.options = options;
        this.observer = new ResizeObserver((entries) => this.draw(entries[0]?.contentRect.width ?? 700));
        this.observer.observe(host);
        this.draw(host.clientWidth || 700);
    }

    destroy(){
        this.observer.disconnect();
        this.host.replaceChildren();
    }

    /** @param {number} width */
    draw(width){
        const { host, series, options, points } = this;
        const values = points.flatMap((p) => p.values).flatMap((v) => v !== null && Number.isFinite(v) ? [v] : []);
        if (!values.length){
            host.innerHTML = '<div class="chartEmpty">Nothing observed in this period. Try a longer range.</div>';
            return;
        }
        const w = Math.max(280, width);
        const h = 270;
        const left = 62;
        const right = w - 16;
        const top = 20;
        const bottom = options.volume ? 196 : 230;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min || Math.max(1, max * 0.1);
        const low = Math.max(0, min - span * 0.12);
        const high = max + span * 0.12;
        const first = points[0].t;
        const last = points.at(-1)?.t ?? first;
        const duration = last - first || 86_400_000;
        const x = (/** @type {number} */ t) => left + (t - first) / duration * (right - left);
        const y = (/** @type {number} */ v) => bottom - (v - low) / (high - low) * (bottom - top);
        const step = options.stepMs ?? 86_400_000;
        const segments = series.map((s, index) => lineSegments(points, index, step));
        let svg = "";
        for (let i = 0; i <= 4; i++){
            const value = low + (high - low) * i / 4;
            const label = high - low < 10 ? value.toFixed(2) : money(value);
            svg += `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#292b35"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${esc(label)}</text>`;
        }
        for (let i = 0; i <= 4; i++){
            const t = first + duration * i / 4;
            const date = new Date(t);
            const label = duration <= 2 * 86_400_000 ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
            let anchor = "middle";
            if (i === 0) anchor = "start";
            if (i === 4) anchor = "end";
            svg += `<text x="${x(t)}" y="260" text-anchor="${anchor}">${esc(label)}</text>`;
        }
        if (options.volume){
            const volumeMax = Math.max(1, ...points.map((p) => p.volume ?? 0));
            const barWidth = Math.max(1, Math.min(14, (right - left) / Math.max(1, points.length) * 0.6));
            svg += points.filter((p) => p.volume).map((p) => `<rect x="${x(p.t) - barWidth / 2}" y="${244 - (p.volume ?? 0) / volumeMax * 30}" width="${barWidth}" height="${(p.volume ?? 0) / volumeMax * 30}" fill="#f36eaa" opacity=".23"/>`).join("");
        }
        for (const [index, s] of series.entries()){
            let path = "";
            let gaps = "";
            for (const segment of segments[index]){
                const line = `M${x(segment.from.t)},${y(/** @type {number} */(segment.from.values[index]))} L${x(segment.to.t)},${y(/** @type {number} */(segment.to.values[index]))} `;
                if (segment.gap) gaps += line;
                else path += line;
            }
            for (const p of points){
                const v = p.values[index];
                if (v === null || v === undefined || !Number.isFinite(v)) continue;
                svg += `<circle cx="${x(p.t)}" cy="${y(v)}" r="${points.length < 20 ? 3 : 1.5}" fill="${s.color}"/>`;
            }
            svg += `<path class="observedLine" d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
            if (gaps) svg += `<path class="gapLine" d="${gaps}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-dasharray="5 5" opacity=".65"/>`;
        }
        host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(series.map((s) => s.label).join(", "))}">${svg}<line class="crosshair" x1="0" x2="0" y1="${top}" y2="244" stroke="#858796" stroke-dasharray="3 4" visibility="hidden"/></svg><div class="chartTooltip" hidden></div>`;
        const graph = /** @type {SVGSVGElement} */ (host.querySelector("svg"));
        const tooltip = /** @type {HTMLDivElement} */ (host.querySelector(".chartTooltip"));
        const crosshair = /** @type {SVGLineElement} */ (host.querySelector(".crosshair"));
        graph.addEventListener("pointermove", (event) => {
            const bounds = graph.getBoundingClientRect();
            const px = (event.clientX - bounds.left) * w / bounds.width;
            const t = first + (px - left) / (right - left) * duration;
            const point = points.reduce((best, p) => Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best);
            const gap = segments[0]?.find((s) => s.gap && x(s.from.t) + 5 < px && px < x(s.to.t) - 5);
            let details = series.map((s, i) => `${esc(s.label)} <b>${money(point.values[i])}</b>`).join("<br>");
            if (gap) details = "Nothing observed in this gap.<br>The dashed line only connects recorded values.";
            const date = new Date(gap ? t : point.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
            tooltip.innerHTML = `<strong>${esc(date)} UTC</strong><br>${details}${!gap && options.volume && point.volume ? `<br>Sales ${point.volume}` : ""}`;
            tooltip.hidden = false;
            tooltip.style.left = `${Math.max(0, Math.min(px + 14, w - 240))}px`;
            crosshair.setAttribute("x1", String(gap ? px : x(point.t)));
            crosshair.setAttribute("x2", String(gap ? px : x(point.t)));
            crosshair.setAttribute("visibility", "visible");
        });
        graph.addEventListener("pointerleave", () => {
            tooltip.hidden = true;
            crosshair.setAttribute("visibility", "hidden");
        });
    }
}
