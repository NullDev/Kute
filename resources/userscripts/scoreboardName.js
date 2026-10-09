// ==UserScript==
// @name         Scoreboard Name
// @author       Kute
// @version      1.0.0
// @description  Shows a name of your choice instead of your own in the leaderboard, the tab list and the end screen, only on your screen
// @run-at       document-end
// @license      MIT
// ==/UserScript==

// shipped with kute as an example of a userscript that only touches the page: the text node of your own row gets swapped
// in the lists krunker renders, the real name stays in a data-kute-name attribute (the kute badge and clan colors read
// it), nothing is sent anywhere. `this.settings` holds the name, `this.unload` puts the real names back

const ROOTS = ["leaderboardHolder", "centerLeaderDisplay", "endUI", "menuWindow"];
// team modes render one table per team with the same id
const LISTS = "#leaderContainer, #ingameTable, #endTable, #playerListH";
const NAME_ELEMENTS = ".pListName, [class^=\"newLeaderName\"], [class^=\"leaderName\"], .endTableN";
// krunker marks the own leaderboard row with an M suffix
const OWN_ROW = ["leaderNameM", "newLeaderNameM"];
const REAL = "data-kute-name";
const DISCOVERY_MS = 1000;

let alias = "";
/** the alias that is in the page right now, so a changed setting still finds its rows */
let applied = "";
/** @type {Map<Element, MutationObserver>} */
const observers = new Map();

const ownName = () => {
    const user = window.getGameActivity?.()?.user;
    if (typeof user !== "string") return "";
    // the lists show the account name while krunker's "Display premium badge" switch is off
    if (localStorage.getItem("kro_setngss_premiumBadge") === "false") return localStorage.getItem("krunker_username") || user;
    return user;
};

/**
 * @param {Element} element
 * @param {string} [wanted] the text to look for, any non blank text node without it
 * @return {Text|null}
 */
const textNodeOf = (element, wanted) => {
    for (const node of element.childNodes){
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const text = /** @type {Text} */ (node);
        const shown = text.data.trim();
        if (shown !== "" && (wanted === undefined || shown === wanted)) return text;
    }
    return null;
};

/**
 * @param {Text} node
 * @param {string} name
 */
const show = (node, name) => {
    const shown = node.data.trim();
    if (shown !== name) node.data = node.data.replace(shown, name);
};

/**
 * @param {Element} element
 */
const rename = (element) => {
    const real = element.getAttribute(REAL);
    if (real !== null){
        // ours already, krunker may have put the real name back in a rebuild
        const node = textNodeOf(element, applied) ?? textNodeOf(element, real);
        if (!node) return;
        if (alias) show(node, alias);
        else {
            show(node, real);
            element.removeAttribute(REAL);
        }
        return;
    }
    if (!alias) return;
    const mine = OWN_ROW.some((className) => element.classList.contains(className));
    const node = textNodeOf(element, ownName()) ?? (mine ? textNodeOf(element) : null);
    if (!node) return;
    element.setAttribute(REAL, node.data.trim());
    show(node, alias);
};

/**
 * @param {Element} root
 */
const walk = (root) => {
    for (const list of root.querySelectorAll(LISTS)){
        for (const element of list.querySelectorAll(NAME_ELEMENTS)) rename(element);
    }
    // our own edits must not trigger another walk
    observers.get(root)?.takeRecords();
};

const refresh = () => {
    for (const root of observers.keys()) walk(root);
    applied = alias;
};

// the containers are permanent, the lists inside get rebuilt by krunker
const discover = () => {
    for (const [root, observer] of observers){
        if (root.isConnected) continue;
        observer.disconnect();
        observers.delete(root);
    }
    for (const id of ROOTS){
        const root = document.getElementById(id);
        if (!root || observers.has(root)) continue;
        const observer = new MutationObserver(() => walk(root));
        observer.observe(root, { childList: true, subtree: true });
        observers.set(root, observer);
        walk(root);
    }
};

const timer = setInterval(discover, DISCOVERY_MS);
discover();

this.settings = {
    name: {
        title: "Name",
        desc: "Shown in place of your own name in the scoreboards, only you see it. Empty shows your real name",
        type: "text",
        value: "",
        changed(/** @type {string} */ value){
            alias = String(value ?? "").trim();
            refresh();
        },
    },
};

this.unload = () => {
    clearInterval(timer);
    alias = "";
    refresh();
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
};
