import { expect, test } from "bun:test";
import { lineSegments } from "../src/frontend/modules/market/chartData.ts";
import MarketChart from "../src/frontend/modules/market/chart.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function render(points, options = {}){
    const listeners = {};
    const tooltip = { style: {}, hidden: true, innerHTML: "" };
    const graph = { addEventListener: (name, callback) => { listeners[name] = callback; }, getBoundingClientRect: () => ({ left: 0, width: 700 }) };
    const host = { innerHTML: "", querySelector: selector => ({ svg: graph, ".chartTooltip": tooltip, ".crosshair": { setAttribute(){} } })[selector] };
    MarketChart.prototype.draw.call({ host, points, options, series: [{ label: "Price", color: "#fff" }] }, 700);
    return { host, tooltip, hover: clientX => listeners.pointermove({ clientX }) };
}

test("sparse lines distinguish missing values and missing dates without adding observations", () => {
    const points = [{ t: 0, values: [100] }, { t: DAY, values: [120] }, { t: 2 * DAY, values: [null] }, { t: 3 * DAY, values: [90] }, { t: 8 * DAY, values: [150] }];
    const before = structuredClone(points);
    expect(lineSegments(points, 0, DAY).map(s => [s.from.t, s.to.t, s.gap])).toEqual([[0, DAY, false], [DAY, 3 * DAY, true], [3 * DAY, 8 * DAY, true]]);
    const chart = render(points, { stepMs: DAY });
    expect(chart.host.innerHTML.match(/<circle /g)).toHaveLength(4);
    expect(chart.host.innerHTML).toContain('class="gapLine"');
    expect(chart.host.innerHTML).toContain('stroke-dasharray="5 5"');
    chart.hover(62 + 2 / 8 * 622);
    expect(chart.tooltip.innerHTML).toContain("Nothing observed in this gap");
    expect(chart.tooltip.innerHTML).not.toContain("<b>");
    expect(points).toEqual(before);
});

test("non-finite observations remain gaps and never reach the markup", () => {
    const points = [{ t: 0, values: [5] }, { t: DAY, values: [NaN] }, { t: 2 * DAY, values: [Infinity] }, { t: 3 * DAY, values: [8] }];
    expect(lineSegments(points, 0, DAY)[0].gap).toBe(true);
    const { host } = render(points, { stepMs: DAY });
    expect(host.innerHTML).not.toContain("NaN");
    expect(host.innerHTML).not.toContain("Infinity");
});

test("sales bars only appear for days with sales and the tooltip names them", () => {
    const points = [{ t: 0, values: [100], volume: 5 }, { t: DAY, values: [110], volume: 0 }, { t: 2 * DAY, values: [120], volume: 2 }];
    const chart = render(points, { stepMs: DAY, volume: true });
    expect(chart.host.innerHTML.match(/<rect /g)).toHaveLength(2);
    chart.hover(62);
    expect(chart.tooltip.innerHTML).toContain("Sales 5");
    chart.hover(62 + 311);
    expect(chart.tooltip.innerHTML).not.toContain("Sales");
});

test("an empty period says so instead of drawing axes", () => {
    const { host } = render([{ t: 0, values: [null] }]);
    expect(host.innerHTML).toContain("Nothing observed in this period");
    expect(host.innerHTML).not.toContain("<svg");
});
