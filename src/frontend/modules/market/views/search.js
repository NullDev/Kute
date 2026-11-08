import { html } from "../element.js";
import marketApi from "../api.js";
import { RARITIES } from "../types.js";
import { TYPE_NAMES, esc, money } from "../presentation.js";
import { itemSearch } from "../itemSearch.js";
const MINUTE = 60_000;
/** @param {import("../terminal.js").Terminal} desk  @return {Promise<import("../terminal.js").View>} */
export async function searchView(desk){
    const state = desk.searchState();
    const params = new URLSearchParams({ sort: state.sort, page: String(state.page) });
    for (const [key, value] of Object.entries({ q: state.q, rarity: state.rarity, type: state.type, budget: state.budget, min_sales: state.minSales })){
        if (value !== "") params.set(key, value);
    }
    /** @type {import("../types.js").SearchReply|null} */
    const result = await marketApi.cached(`/market/search?${params}`, MINUTE);
    if (!result) return desk.unavailable();
    const options = (/** @type {string[]} */ names, /** @type {string} */ selected) =>
        names
            .map(
                (n, i) => html`
                    <option value="${i}" ${String(i) === selected ? "selected" : ""}>${esc(n)}</option>
                `,
            )
            .join("");
    const pages = Math.max(1, Math.ceil(result.total / result.perPage));
    return {
        asOf: result.asOf,
        asOfLabel: "Facts updated",
        html:
            desk.intro(
                "What has an item really sold for?",
                "Last sales, asking prices and Krunker's sale counts for every tradable item.",
                '<button class="button small" data-action="reset-search">Reset filters</button>',
            ) +
            html`
                <form id="kmFilters" class="filterBar">
                    ${itemSearch("kmQ", "discover", "Search all items", state.q)}
                    <input
                        id="kmBudget"
                        type="number"
                        min="1"
                        aria-label="Maximum asking price in KR"
                        placeholder="Budget in KR"
                        value="${esc(state.budget)}"
                    />
                    <select id="kmType" aria-label="Item type">
                        <option value="">All types</option>
                        ${options(TYPE_NAMES, state.type)}
                    </select>
                    <select id="kmRarity" aria-label="Rarity">
                        <option value="">All rarities</option>
                        ${options(
                            RARITIES.map((r) => r.name),
                            state.rarity,
                        )}
                    </select>
                    <select id="kmSales" aria-label="Minimum sales">
                        <option value="">Any sales</option>
                        ${[1, 10, 50]
                            .map(
                                (n) => html`
                                    <option value="${n}" ${String(n) === state.minSales ? "selected" : ""}>${n}+ sold / 30D</option>
                                `,
                            )
                            .join("")}
                    </select>
                    <select id="kmSort" aria-label="Sort items">
                        ${[
                            ["sales", "Most sold"],
                            ["lowest", "Cheapest ask"],
                            ["name", "Name"],
                        ]
                            .map(
                                ([v, n]) => html`
                                    <option value="${v}" ${v === state.sort ? "selected" : ""}>${n}</option>
                                `,
                            )
                            .join("")}
                    </select>
                    <button type="button" class="button small" data-action="filters">Apply</button>
                </form>
            ` +
            desk.table(result.items) +
            html`
                <div class="pagination">
                    <span>${money(result.total)} matching items</span>
                    <div class="row">
                        <button class="button small" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>Previous</button>
                        <span>${state.page} / ${pages}</span>
                        <button class="button small" data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""}>Next</button>
                    </div>
                </div>
            `,
    };
}
