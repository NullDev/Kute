import { html } from "../element";
import marketApi from "../api";
import { TITLES } from "../navigation";
import { RARITIES, formatAge, formatWhen } from "../types";
import { TYPE_NAMES, esc, money, empty, stat } from "../presentation";
import { readWatchlist } from "../watchlist";
import { ownPrice } from "../prices";
import type { Terminal, View } from "../terminal";
import type { ChartPoint } from "../chart";

const RANGES = ["7D", "1M", "3M", "1Y", "ALL"];

export async function itemView(desk: Terminal): Promise<View>{
    const state = desk.itemState();
    const reply = await marketApi.itemDesk(state.skin, state.range);
    const { item: page, history, listings } = reply ?? {};
    if (!page) return desk.unavailable();
    const s = page.skin;
    const watched = readWatchlist().some((w) => w.skin === s.skin);
    const own = ownPrice(s.skin);
    const hourly = history?.resolution === "hour";
    const series = hourly
        ? [{ label: "Lowest ask (sampled)", color: "#87b8f7" }]
        : [{ label: "Daily average sale (Krunker)", color: "#f580b4" }, { label: "Lowest ask (sampled)", color: "#87b8f7" }];
    const points: ChartPoint[] = (history?.points ?? []).map((p) => ({
        t: p.t,
        values: hourly ? [p.lowest] : [p.avg, p.lowest],
        volume: hourly ? null : p.sales,
    }));
    const bookAt = listings?.observedAt ?? s.bookAt;
    const stale = !bookAt || Date.now() - bookAt > 3 * 3_600_000;
    const listingRows = (listings?.listings ?? []).slice(0, 50);
    const since = page.historySince ? `since ${formatWhen(page.historySince)}` : "";
    const lastSale = s.lastSoldPrice !== null && s.lastSoldAt !== null
        ? stat("Last confirmed sale", html`${money(s.lastSoldPrice)}<span class="unit"> KR</span>`, `${esc(formatWhen(s.lastSoldAt))} UTC &middot; ${s.sold30d} confirmed in 30 days`)
        : stat("Last confirmed sale", '<span class="muted">None seen</span>', s.lastSaleDay ? `Krunker's average on ${esc(formatWhen(s.lastSaleDay))}: ${money(s.lastSaleAvg)} KR` : "No sale while Kute watched");
    return {
        item: page,
        listings,
        asOf: page.asOf,
        asOfLabel: "Facts updated",
        points: history ? points : undefined,
        series,
        chartOptions: { volume: !hourly, stepMs: hourly ? 3_600_000 : 86_400_000 },
        html:
            html`
                <button class="textButton" data-action="back">
                    &#8592; Back to ${esc(TITLES[(desk.previous as keyof typeof TITLES)] ?? "Search")}
                </button>
                <div class="itemHero">
                    <div class="itemArt">
                        ${s.thumbnail
                            ? html`
                                  <img src="${esc(s.thumbnail)}" alt="${esc(s.name)}" />
                              `
                            : "K"}
                    </div>
                    <div>
                        <div class="eyebrow">
                            ${esc(RARITIES[s.rarity]?.name)} &middot;
                            ${esc(TYPE_NAMES[s.type])}${s.season ? ` &middot; Season ${s.season}` : ""}${s.tradable ? "" : " &middot; Not tradable"}
                        </div>
                        <h1>${esc(s.name)}</h1>
                        <p class="sub">
                            ${money(s.inC)} in circulation &middot; ${s.onS} listed by Krunker's count
                            ${s.krunker !== null ? ` &middot; Krunker's estimate ${money(s.krunker)} KR` : " &middot; Krunker has no estimate"}
                        </p>
                    </div>
                    <div class="itemActions">
                        <label class="field ownField">
                            Your price / KR
                            <input id="kmOwnPrice" type="number" min="1" placeholder="Set yours" value="${own ?? ""}" data-own-skin="${s.skin}" data-own-name="${esc(s.name)}" />
                        </label>
                        <button class="button ${watched ? "" : "primary"}" data-action="watch">
                            ${watched ? "Watching" : "+ Watch item"}
                        </button>
                    </div>
                </div>
            ` +
            html`
                <div class="metrics itemMetrics">
                    ${stat(
                        "Lowest ask",
                        s.lowest === null ? '<span class="muted">Not listed</span>' : html`${money(s.lowest)}<span class="unit"> KR</span>`,
                        s.lowest === null ? "No live listing in the last book read" : `${s.listed} listed${s.highest !== null && s.highest !== s.lowest ? ` &middot; highest ${money(s.highest)}` : ""}${bookAt ? ` &middot; read ${esc(formatAge(Date.now() - bookAt))} ago` : ""}`,
                    )}${lastSale}${stat(
                        "Sold in 30 days",
                        String(s.sales30d),
                        s.avg30d !== null ? `Krunker's average ${money(s.avg30d)} KR &middot; ${s.sales90d} in 90 days` : "Krunker's daily counts",
                    )}${stat(
                        "Krunker's estimate",
                        s.krunker === null ? '<span class="muted">None</span>' : html`${money(s.krunker)}<span class="unit"> KR</span>`,
                        s.floor > 0 ? `Quick sell pays ${money(s.floor)} KR` : "Not eligible for quick sell",
                    )}
                </div>
            ` +
            html`
                <section class="sectionGap panel">
                    <div class="panelHead">
                        <div>
                            <h3>Price history</h3>
                            <p class="sub">Krunker's daily average sale price and the lowest ask Kute sampled${since ? `, ${since}` : ""}. Bars are Krunker's sales per day.</p>
                        </div>
                        <div class="segmented">
                            ${RANGES.map(
                                (r) => html`
                                    <button data-range="${r}" class="${state.range === r ? "on" : ""}">${r}</button>
                                `,
                            ).join("")}
                        </div>
                    </div>
                    <div class="chartLegend">
                        ${series
                            .map(
                                (line) => html`
                                    <span>
                                        <i style="background:${line.color}"></i>
                                        ${esc(line.label)}
                                    </span>
                                `,
                            )
                            .join("")}
                        <span><i class="legendGap"></i>Dashed: nothing observed between</span>
                    </div>
                    <div class="chart">
                        ${history
                            ? ""
                            : empty(
                                  "History unavailable",
                                  "The history could not be loaded. Try again in a moment.",
                                  '<button class="button small" data-action="retry">Try again</button>',
                              )}
                    </div>
                    <p class="chartNote">Dates and times are UTC. Nothing here is a valuation: it is what the game reported and what Kute saw listed.</p>
                </section>
            ` +
            html`
                <div class="equal">
                    <section class="panel">
                        <div class="panelHead">
                            <h3>Recent confirmed sales</h3>
                            <small>Listings Kute saw disappear with a matching sale in Krunker's daily count</small>
                        </div>
                        ${page.sold.length
                            ? html`
                                  <div class="tableWrap">
                                      <table>
                                          <thead>
                                              <tr>
                                                  <th>When (UTC)</th>
                                                  <th class="num">Price / KR</th>
                                                  <th>Instance</th>
                                              </tr>
                                          </thead>
                                          <tbody>
                                              ${page.sold
                                                  .map(
                                                      (row) => html`
                                                          <tr>
                                                              <td>${esc(formatWhen(row.at))}</td>
                                                              <td class="num">${money(row.price)}</td>
                                                              <td class="muted">
                                                                  ${row.serial !== null ? `#${esc(row.serial)}` : ""}${row.wear !== null ? `${row.serial !== null ? " &middot; " : ""}wear ${row.wear.toFixed(3)}` : ""}${row.serial === null && row.wear === null ? "–" : ""}
                                                              </td>
                                                          </tr>
                                                      `,
                                                  )
                                                  .join("")}
                                          </tbody>
                                      </table>
                                  </div>
                              `
                            : '<p class="sub">No confirmed sale yet. Krunker only publishes daily counts, so a sale is confirmed when exactly the listings that vanished add up to the day\'s count.</p>'}
                    </section>
                    <section class="panel">
                        <div class="panelHead">
                            <h3>Supply</h3>
                            <small>${page.supply?.at ? `owners read ${esc(formatAge(Date.now() - page.supply.at))} ago` : ""}</small>
                        </div>
                        <p class="sub">
                            ${money(s.inC)} in circulation, ${s.onS} listed.${page.supply?.top1Share !== null && page.supply?.top1Share !== undefined
                                ? ` The top holder has ${(page.supply.top1Share * 100).toFixed(1)} %`
                                : ""}${page.supply?.top10Share !== null && page.supply?.top10Share !== undefined
                                ? `, the top ten ${(page.supply.top10Share * 100).toFixed(1)} %.`
                                : ""}${s.noSpin ? " Not in spins." : ""}
                        </p>
                        ${page.supply?.topOwners.length
                            ? html`
                                  <div class="contentTop tableWrap">
                                      <table>
                                          <thead>
                                              <tr>
                                                  <th>Top holders</th>
                                                  <th class="num">Units</th>
                                              </tr>
                                          </thead>
                                          <tbody>
                                              ${page.supply.topOwners
                                                  .map(
                                                      (owner) => html`
                                                          <tr>
                                                              <td>${esc(owner.name)}</td>
                                                              <td class="num">${money(owner.count)}</td>
                                                          </tr>
                                                      `,
                                                  )
                                                  .join("")}
                                          </tbody>
                                      </table>
                                  </div>
                              `
                            : ""}
                    </section>
                </div>
            ` +
            html`
                <div class="panelHead">
                    <h3>Listings</h3>
                    <small>
                        ${listings ? listings.total : "?"} listed${bookAt ? ` &middot; read ${esc(formatAge(Date.now() - bookAt))} ago` : ""}
                    </small>
                </div>
                ${stale ? '<div class="notice">This book was last read more than three hours ago. A listing may have changed or sold since.</div>' : ""}
            ` +
            (listingRows.length
                ? html`
                      <div class="tableWrap">
                          <table>
                              <thead>
                                  <tr>
                                      <th class="num">Ask / KR</th>
                                      <th>Seller</th>
                                      <th>Listed for</th>
                                      <th>Instance</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${listingRows
                                      .map(
                                          (l) => html`
                                              <tr>
                                                  <td class="num">${money(l.price)}</td>
                                                  <td>${esc(l.seller ?? "–")}${l.sellerListings > 1 ? `<small>${l.sellerListings} listings</small>` : ""}</td>
                                                  <td class="muted">${l.ageMs === null ? "–" : esc(formatAge(l.ageMs))}</td>
                                                  <td class="muted">
                                                      ${l.serial !== null ? `#${esc(l.serial)}` : ""}${l.wear !== null ? `${l.serial !== null ? " &middot; " : ""}wear ${l.wear.toFixed(3)}` : ""}${l.serial === null && l.wear === null ? "–" : ""}
                                                  </td>
                                              </tr>
                                          `,
                                      )
                                      .join("")}
                              </tbody>
                          </table>
                      </div>
                      <p class="chartNote">
                          The cheapest ${listingRows.length} of ${listings?.total ?? "?"} listings. Krunker's item page shows at most 50, so a book with more is not complete.
                      </p>
                  `
                : empty("No listings seen", "The last book read found nothing for sale.")),
    };
}
