import { html } from "../element";
import marketApi from "../api";
import { esc, money, identity, empty, lastSale, lowestAsk } from "../presentation";
import { readWatchlist, saveWatchlist } from "../watchlist";
import { readPrices } from "../prices";
import alerts from "../alerts";
import type { Terminal, View } from "../terminal";

export async function watchlistView(desk: Terminal): Promise<View>{
    const watch = readWatchlist();
    const head = desk.intro(
        "Your watchlist.",
        "Items you follow, with a target the lowest ask is checked against. Saved only on this device.",
        '<button class="button" data-action="discover">+ Find an item</button>',
    );
    if (!watch.length){
        return {
            html:
                head +
                '<section class="panel">' +
                empty(
                    "Nothing watched yet",
                    "Open an item and choose Watch item. It appears here with its lowest ask and last sale.",
                    '<button class="button primary" data-action="discover">Find an item</button>',
                ) +
                "</section>",
        };
    }
    const missing = watch.filter((w) => w.rarity === undefined);
    if (missing.length){
        const items = await Promise.all(missing.map((w) => marketApi.cached(`/market/item/${w.skin}`, 300_000)));
        missing.forEach((w, i) => {
            const rarity = items[i]?.skin?.rarity;
            if (Number.isInteger(rarity)) w.rarity = rarity;
        });
        if (missing.some((w) => w.rarity !== undefined)) saveWatchlist(watch);
    }
    const values = await marketApi.values(watch.map((w) => w.skin));
    const own = readPrices();
    const unread = new Set(alerts.unread);
    queueMicrotask(() => alerts.markRead());
    const asOf = Math.min(...Object.values(values).map((v) => v.asOf));
    return {
        asOf: Number.isFinite(asOf) ? asOf : undefined,
        asOfLabel: "Facts updated",
        html:
            head +
            html`
                <div class="tableWrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Item</th>
                                <th class="num">Lowest ask</th>
                                <th class="num">Last sale</th>
                                <th class="num">Your price</th>
                                <th>Target / KR</th>
                                <th>Status</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${watch
                                .map((w) => {
                                    const v = values[w.skin];
                                    const fresh = !!v?.bookAt && Date.now() - v.bookAt <= 3 * 3_600_000;
                                    let status = '<span class="tag quiet">Watching</span>';
                                    if (v && !fresh) status = '<span class="tag warn">Book not read for 3 h</span>';
                                    if (!v) status = '<span class="tag warn">Data unavailable</span>';
                                    if (w.target !== null && v?.lowest !== null && v?.lowest !== undefined && v.lowest <= w.target && fresh) status = '<span class="tag good">At your target</span>';
                                    if (unread.has(w.skin)) status = '<span class="tag good">New: target reached</span>';
                                    return html`
                                        <tr>
                                            <td>
                                                <button data-skin="${esc(w.skin)}">${identity(w)}</button>
                                            </td>
                                            <td class="num">${lowestAsk(v)}</td>
                                            <td class="num">${lastSale(v)}</td>
                                            <td class="num">${own[w.skin] ? money(own[w.skin].price) : '<span class="muted">–</span>'}</td>
                                            <td>
                                                <input
                                                    class="watchTarget"
                                                    type="number"
                                                    min="1"
                                                    data-target="${esc(w.skin)}"
                                                    value="${w.target ?? ""}"
                                                    aria-label="Target price for ${esc(w.name)}"
                                                    placeholder="Set target"
                                                />
                                            </td>
                                            <td>${status}</td>
                                            <td>
                                                <button
                                                    class="remove"
                                                    data-unwatch="${esc(w.skin)}"
                                                    aria-label="Remove ${esc(w.name)} from watchlist"
                                                >
                                                    &times;
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                })
                                .join("")}
                        </tbody>
                    </table>
                </div>
                <p class="chartNote">
                    Targets compare against the lowest ask of the last book read. Checks run in the menu, never during gameplay.
                </p>
            `,
    };
}
