import { marked } from "marked";
import { kute } from "../client";

function semverCompare(a: string, b: string): number{
    return a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "case",
        caseFirst: "upper",
    });
}

const REPO_API = "https://api.github.com/repos/NullDev/Kute";

type Release = { tag: string, body: string, date: string };

const releaseCache: Map<number, Promise<Release | null>> = new Map();
let releaseCount: number | null = null;

function releaseAt(position: number): Promise<Release | null>{
    let release = releaseCache.get(position);
    if (!release){
        release = fetch(`${REPO_API}/releases?per_page=1&page=${position}`)
            .then(async(res) => {
                if (!res.ok) throw new Error(`github ${res.status}`);
                const data: any[] = await res.json();
                const last = (res.headers.get("link") ?? "").match(/[?&]page=(\d+)>; rel="last"/);
                if (last) releaseCount = Number(last[1]);
                else if (data.length > 0) releaseCount = Math.max(releaseCount ?? 0, position);
                const [item] = data;
                return item ? { tag: String(item.tag_name), body: String(item.body ?? ""), date: String(item.published_at ?? "").slice(0, 10) } : null;
            })
            .catch(() => {
                releaseCache.delete(position);
                return null;
            });
        releaseCache.set(position, release);
    }
    return release;
}

async function positionOf(version: string): Promise<number>{
    const newest = await releaseAt(1);
    if (!newest || newest.tag === version || releaseCount === null) return 1;
    let low = 2;
    let high = releaseCount;
    while (low <= high){
        const middle = Math.floor((low + high) / 2);
        const release = await releaseAt(middle);
        if (!release) return 1;
        const order = semverCompare(release.tag, version);
        if (order === 0) return middle;
        if (order > 0) low = middle + 1;
        else high = middle - 1;
    }
    return 1;
}

(async(): Promise<void> => {
    async function showChangelogPopup(version: string): Promise<void>{
        const [html, logo] = await Promise.all([import("../components/changelog.html"), import("../components/logo.webp")]);
        const overlay = document.createElement("div");
        overlay.style = `
			position: fixed;
			top: 0;
			left: 0;
			width: 100vw;
			height: 100vh;
			background: rgba(0,0,0,0.75);
			z-index: 9998;
			display: flex;
			justify-content: center;
			align-items: center;
		`;
        document.body.append(overlay);

        const host = document.createElement("div");
        host.id = "changelogPopupHost";
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        const container = document.createElement("div");
        container.innerHTML = html.default;

        while (container.firstChild) shadow.append(container.firstChild);

        const element = (id: string): HTMLElement | null => shadow.getElementById(id);
        const logoImage = element("changelogLogo") as HTMLImageElement | null;
        if (logoImage) logoImage.src = logo.default;
        const content = element("changelogContent");
        if (content) content.textContent = "Loading release notes...";
        const versionLabel = element("changelogVersion");
        if (versionLabel) versionLabel.textContent = version;

        const controller = new AbortController();
        const close = (): void => {
            controller.abort();
            overlay.remove();
        };
        for (const id of ["changelogClose", "changelogDone"]){
            const button = element(id);
            if (button) button.onclick = close;
        }
        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) close();
        });

        let shown = 1;
        let renders = 0;

        const updateNav = (): void => {
            const total = releaseCount ?? 1;
            const position = element("changelogPosition");
            if (position) position.textContent = `${shown} / ${total}`;
            element("changelogNewer")?.classList.toggle("changelogDisabled", shown <= 1);
            element("changelogOlder")?.classList.toggle("changelogDisabled", shown >= total);
            const nav = element("changelogNav");
            if (nav) nav.style.display = total > 1 ? "" : "none";
        };

        const show = async(position: number): Promise<void> => {
            shown = Math.min(Math.max(position, 1), releaseCount ?? 1);
            const render = ++renders;
            updateNav();
            const release = await releaseAt(shown);
            if (render !== renders || !content) return;
            if (!release){
                content.innerHTML = "<span id='changelogError'>Could not load the release notes. View them on GitHub instead.</span>";
                const github = element("changelogGithub");
                if (github) github.onclick = (): void => window.chrome.webview.postMessage(`open-url, https://github.com/NullDev/Kute/releases/tag/${version}`);
                return;
            }
            const releaseUrl = `https://github.com/NullDev/Kute/releases/tag/${release.tag}`;
            if (versionLabel) versionLabel.textContent = release.tag;
            const eyebrow = element("changelogEyebrow");
            if (eyebrow) eyebrow.textContent = release.tag === version ? "[ WHAT'S NEW ]" : `[ RELEASED ${release.date} ]`;
            const github = element("changelogGithub");
            if (github) github.onclick = (): void => window.chrome.webview.postMessage(`open-url, ${releaseUrl}`);

            const htmlContent = await marked.parse(release.body || "No release notes found.", { breaks: true, async: true });
            if (render !== renders) return;
            content.innerHTML = htmlContent;
            element("changelogContentWrapper")?.scrollTo(0, 0);

            for (const a of content.querySelectorAll("a")){
                if (a.getAttribute("href")?.startsWith("#")) a.setAttribute("href", releaseUrl + a.getAttribute("href"));
                a.setAttribute("target", "_blank");
                a.setAttribute("rel", "noopener");
            }
        };

        const older = element("changelogOlder");
        if (older) older.onclick = (): Promise<void> => show(shown + 1);
        const newer = element("changelogNewer");
        if (newer) newer.onclick = (): Promise<void> => show(shown - 1);
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") close();
                else if (event.key === "ArrowLeft") show(shown - 1);
                else if (event.key === "ArrowRight") show(shown + 1);
                else return;
                event.stopPropagation();
            },
            { signal: controller.signal, capture: true },
        );

        const opened = await positionOf(version);
        if (!controller.signal.aborted) await show(opened);
    }

    const currentVersion = kute?.version;
    const lastSeenVersion = window.localStorage.getItem("kute_lastSeenVersion");
    const isNewVersion = lastSeenVersion !== null && semverCompare(currentVersion, lastSeenVersion) > 0;
    window.localStorage.setItem("kute_lastSeenVersion", currentVersion);
    if (kute?.settings.data?.showChangelog && lastSeenVersion && currentVersion && isNewVersion){
        await showChangelogPopup(currentVersion);
    }

    kute.showChangelogPopup = showChangelogPopup;
})();
