import { html } from "../element.js";
import { esc, money, identity, empty, lastSale, lowestAsk, soldMonth } from "../presentation.js";
import { readPrices } from "../prices.js";
/** @param {import("../terminal.js").Terminal} _desk  @param {import("../types.js").SkinFacts[]} items */
export function tableView(_desk, items){
    if (!items.length) return empty("No matching items", "Try a wider budget or fewer filters.");
    const own = readPrices();
    return html`
        <div class="tableWrap">
            <table>
                <thead>
                    <tr>
                        <th>Item</th>
                        <th class="num">Lowest ask</th>
                        <th class="num">Last sale</th>
                        <th class="num">Sold / 30D</th>
                        <th class="num">Your price</th>
                    </tr>
                </thead>
                <tbody>
                    ${items
                        .map(
                            (s) => html`
                                <tr class="clickable" data-skin="${esc(s.skin)}" tabindex="0">
                                    <td>${identity(s)}</td>
                                    <td class="num">${lowestAsk(s)}</td>
                                    <td class="num">${lastSale(s)}</td>
                                    <td class="num">${soldMonth(s)}</td>
                                    <td class="num">${own[s.skin] ? money(own[s.skin].price) : '<span class="muted">–</span>'}</td>
                                </tr>
                            `,
                        )
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}
