import { html } from "../element";
import { esc, empty } from "../presentation";
import { formatWhen } from "../types";
import { exportPrices, readPrices } from "../prices";
import type { Terminal, View } from "../terminal";

export function pricesView(desk: Terminal): View{
    const prices = readPrices();
    const entries = Object.entries(prices).sort((a, b) => a[1].name.localeCompare(b[1].name));
    const head = desk.intro(
        "My prices.",
        "What you think items are worth. Stored on this device only, shown next to every fact and totaled in the trade window.",
        '<button class="button" data-action="prices-import">Import</button>' + (entries.length ? '<button class="button" data-action="prices-export">Export</button>' : ""),
    );
    const sheet = html`
        <section class="panel sectionGap" id="kmPricesSheet" hidden>
            <div class="panelHead">
                <h3 id="kmPricesSheetTitle">Import prices</h3>
                <small>One item per line: <code>Name (#id) = 50000</code>. Lines without an id are matched by their exact name.</small>
            </div>
            <textarea id="kmPricesText" rows="8" spellcheck="false" aria-label="Price list as text"></textarea>
            <div class="row contentTop">
                <button class="button primary" data-action="prices-apply">Add to my prices</button>
                <button class="button" data-action="prices-copy">Copy</button>
                <button class="button" data-action="prices-close">Close</button>
                <span class="muted" id="kmPricesStatus"></span>
            </div>
        </section>
    `;
    if (!entries.length){
        return {
            html: head + sheet + '<section class="panel">' + empty("No prices yet", "Set a price on any item page, or import a list a friend sent you.", '<button class="button primary" data-action="discover">Find an item</button>') + "</section>",
            exportText: "",
        };
    }
    return {
        exportText: exportPrices(prices),
        html:
            head +
            sheet +
            html`
                <div class="tableWrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Item</th>
                                <th class="num">Your price / KR</th>
                                <th>Set</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${entries
                                .map(
                                    ([skin, p]) => html`
                                        <tr>
                                            <td><button class="textButton" data-skin="${esc(skin)}">${esc(p.name)}</button></td>
                                            <td class="num">
                                                <input class="watchTarget" type="number" min="1" value="${p.price}" data-own-skin="${esc(skin)}" data-own-name="${esc(p.name)}" aria-label="Your price for ${esc(p.name)}" />
                                            </td>
                                            <td class="muted">${p.at ? esc(formatWhen(p.at)) : "–"}</td>
                                            <td><button class="remove" data-own-remove="${esc(skin)}" aria-label="Remove ${esc(p.name)}">&times;</button></td>
                                        </tr>
                                    `,
                                )
                                .join("")}
                        </tbody>
                    </table>
                </div>
                <p class="chartNote">${entries.length} of 500 items. Export writes the list as text you can paste anywhere; a friend imports it the same way.</p>
            `,
    };
}
