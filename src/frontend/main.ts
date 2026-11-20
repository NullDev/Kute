import styles from "./components/base.css";
import { kute, ready, globalRef } from "./client";
import { hook, getElement, checkCompMode } from "./utils";
import { setRampBoost, syncScrollBinds } from "./modules/rampBoost";
import { prepareShootBind, syncLeftClick } from "./modules/leftClick";
import { postUrls as postIconUrls } from "./modules/kuteIcons/slots";
import "./modules/managers/registry";
import "./modules/customCss";
import "./modules/sessionRecovery";

const isBenchPage = location.pathname === "/kute-bench";
if (isBenchPage) import("./modules/autoDetect/bench");

if (!isBenchPage && localStorage.getItem("krk_advanced") === null) localStorage.setItem("krk_advanced", "1");
if (!isBenchPage) postIconUrls();
if (!isBenchPage){
    ready.then(() => {
        if (kute.settings?.data?.kuteCss === true) import("./modules/kuteCss").catch(() => {});
    });
}

if (location.hostname === "krunker.io" && location.pathname === "/"){
    ready.then(() => {
        if (kute.settings?.data?.accountEndMessage) localStorage.setItem("kro_setngss_endMessage", "");
    });
}

let initialLoad = true;
window.OffCliV = true;
window.closeClient = (): void => window.chrome.webview.postMessage("close");

document.addEventListener(
    "DOMContentLoaded",
    () => {
        if (isBenchPage) return;

        prepareShootBind();
        import("./modules/gameFpsLimit");
        import("./modules/logoBadge");

        const baseCSS = document.createElement("style");
        baseCSS.textContent = styles;
        document.head.append(baseCSS);

        let wheelListener: ((event: WheelEvent) => void) | null = null;
        hook(HTMLCanvasElement, "addEventListener", (args) => {
            const [type, listener] = args;
            if (type === "wheel") wheelListener = listener;
        });

        window.chrome.webview.addEventListener("message", (event) => {
            if (typeof event.data?.wheel === "number") wheelListener?.(new WheelEvent("wheel", { deltaY: event.data.wheel }));
        });

        window.addEventListener("wheel", (event) => {
            if (document.pointerLockElement) return;
            for (const el of event.composedPath()){
                if (el === document.body || el === document.documentElement) break;
                if (!(el instanceof Element)) continue;
                const style = getComputedStyle(el);
                const scrollsY = (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
                const scrollsX = (style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth;
                if (scrollsY || scrollsX) return;
            }
            event.preventDefault();
        }, { capture: true, passive: false });

        document.addEventListener("input", (event) => {
            const { target } = event;
            if ((event instanceof InputEvent && event.inputType === "insertText") || !(target instanceof HTMLInputElement)) return;
            if (target.getAttribute("onkeypress")?.includes("delayExecute")) target.dispatchEvent(new KeyboardEvent("keypress"));
        }, true);

        hook(HTMLCanvasElement, "requestPointerLock", function(args, original){
            syncLeftClick();
            syncScrollBinds();
            window.chrome.webview.postMessage("drag, false");
            window.chrome.webview.postMessage("throttle, game");

            const unadjustedMovement = kute.platform !== "linux" && kute?.settings?.data?.rawInput;
            return original.call(this, { ...args[0], unadjustedMovement });
        });

        document.addEventListener("pointerlockchange", () => {
            if (!document.pointerLockElement){
                window.chrome.webview.postMessage("drag, true");
                window.chrome.webview.postMessage("throttle, menu");
            }
            else {
                window.chrome.webview.postMessage("throttle, game");
            }
        });

        ready.then(() => {
            if (kute.settings.data.hidePopularNow === true){
                kute.settings.data.hidePopularNow = false;
                window.chrome.webview.postMessage("set-config, hidePopularNow, false");
                kute.settings.data.cleanUI = true;
                window.chrome.webview.postMessage("set-config, cleanUI, true");
            }
            if (!kute.settings.data.cleanUI) return;
            import("./components/clean.css").then((css) => {
                const cleanCSS = document.createElement("style");
                cleanCSS.id = "kute_cleanCSS";
                cleanCSS.textContent = css.default;
                document.head.append(cleanCSS);
            });
        });

        ready.then(() => {
            if (!kute.settings.data.classicMenu) return;
            import("./components/classicMenu.css").then((css) => {
                const classicMenuCSS = document.createElement("style");
                classicMenuCSS.id = "kute_classicMenuCSS";
                classicMenuCSS.textContent = css.default;
                document.head.append(classicMenuCSS);
            });
        });
    },
    { once: true },
);

Object.defineProperty(window, "gameLoaded", {
    async set(value: boolean){
        if (!value) return;

        await ready;

        window.chrome.webview.postMessage("game-updated");
        if (!initialLoad) return;
        if (sessionStorage.getItem("justLaunched") === null) sessionStorage.setItem("justLaunched", "true");
        else sessionStorage.setItem("justLaunched", "false");

        initialLoad = false;
        localStorage.setItem("logs", "true");

        getElement("#compBtnLst").insertAdjacentHTML("beforeend", `
		<div class="compMenBtnS" onmouseenter='SOUND.play("tick_0",.1)' style="background-color: #f5479b" onclick="playSelect(),showWindow(4)"> <span class="material-icons" style="color:#fff;font-size:40px;vertical-align:middle;margin-bottom:12px">color_lens</span></div>
		<div class="compMenBtnS" onmouseenter='SOUND.play("tick_0",.1)' style="background-color: #5ce05a" onclick="playSelect(),window.openRankedMenu()"><span class="material-icons" style="color:#fff;font-size:40px;vertical-align:middle;margin-bottom:12px">star</span></div>`);

        let svelteCode: string | undefined;
        for (const cl of getElement("#clientExit .menuItemTitle").classList){
            if (cl.startsWith("svelte-")){
                svelteCode = cl;
                break;
            }
        }

        getElement("#menuItemContainer").lastElementChild?.insertAdjacentHTML(
            "beforebegin",
            `<div onclick="window.open('./social.html')" class="menuItem ${svelteCode}"><span class="material-icons-outlined menuItemIcon ${svelteCode}">open_in_new</span><div class="menuItemTitle ${svelteCode}">Classic Social</div></div>`,
        );
        const whatsNewClass = document.querySelector(".whats-new-version")?.className;
        const versionAttr = whatsNewClass ? `class="${whatsNewClass}"` : "style=\"font-size:.7em;font-weight:700;color:rgba(255,255,255,.5)\"";
        const versionTag = kute.version ? `<span ${versionAttr}>&nbsp;- v${kute.version}</span>` : "";
        getElement("#clientExit").insertAdjacentHTML(
            "beforebegin",
            `<div onclick='${globalRef}.openKuteSettings()' class="menuItem ${svelteCode}"><span class="material-icons menuItemIcon ${svelteCode}">settings</span><div class="menuItemTitle ${svelteCode}">Kute Settings${versionTag}</div></div>`,
        );
        import("./notifications");
        import("./settings");
        import("./modules/changelog");
        import("./modules/about");
        import("./modules/managers/index");
        import("./modules/withdrawn");
        import("./modules/autoDetect/index");
        const { data } = kute.settings;
        if (data.clanColors !== false && data.disableOnlineFeatures !== true) import("./modules/clanColors");
        import("./modules/badges");
        import("./modules/externalQueue");
        const performanceMode = data.performanceMode === true;
        if (!performanceMode) import("./modules/bpClaimAll");
        import("./modules/args");
        import("./modules/fixes");
        import("./modules/inventoryScroll");
        if (!performanceMode) import("./modules/versionTag");
        if (!performanceMode) import("./modules/rankProgress");
        import("./modules/importSettings");
        import("./modules/matchmaker");
        import("./modules/hotkeys");
        import("./modules/settingsTransfer");
        import("./modules/diagnostics");
        if (kute.recovery) import("./modules/recovery");
        import("./modules/nukeCounter");
        import("./modules/accountEndMessage");
        import("./modules/kuteIcons/index");
        import("./modules/menuTimer");
        import("./modules/hudEditor/index");
        import("./modules/blockedChatWarning");
        if (data.hsSound) import("./modules/hsSound");
        if (data.betterChat) import("./modules/betterChat");
        if (data.chatLogs) import("./modules/chatLogs");
        import("./modules/modDownload");
        import("./modules/serverPings");
        if (data.rankedAlert) import("./modules/rankedAlert");
        if (data.hpEnemyCounter) import("./modules/hpEnemyCounter");
        if (data.accountManager) import("./modules/accountManager");
        if (data.showPing) import("./modules/showPing");
        if (data.realPing) import("./modules/realPing");
        if (data.exitButton) getElement("#clientExit").style.display = "flex";
        import("./modules/renderFps");
        if (data.spotifyOverlay && kute.hostFeatures?.includes("spotify")) import("./modules/spotifyOverlay");
        if (data.motionBlur) import("./modules/motionBlur");
        if (data.keystrokes) import("./modules/keystrokes");
        if (kute.hostFeatures?.includes("custom-sky")) import("./modules/customSky");
        if (kute.hostFeatures?.includes("appimage-update")) import("./modules/linuxUpdate").catch(() => {});

        if (data.rampBoost && !checkCompMode()){
            setRampBoost(true);

            const gameUpdateListener = (event: MessageEvent): void => {
                if (event.data === "game-updated"){
                    setTimeout(() => {
                        if (checkCompMode()){
                            window.chrome.webview.removeEventListener("message", gameUpdateListener);
                            setRampBoost(false);
                        }
                    }, 2000);
                }
            };

            window.chrome.webview.addEventListener("message", gameUpdateListener);
        }

        if (data.hideBundles){
            const origBundlePopup = window.bundlePopup;
            window.bundlePopup = (...args): void => {
                const windowHolder = document.querySelector("#windowHolder") as HTMLElement | null;
                if (
                    windowHolder &&
                    windowHolder.style.display !== "none" &&
                    getElement("#windowHeader").textContent === "Store"
                ){
                    origBundlePopup(...args);
                }
            };
        }

        setTimeout(() => {
            if (sessionStorage.getItem("justLaunched") === "true" && kute.launchArgs){
                kute.parseArgs(kute.launchArgs);
            }
        }, 2000);

        if (data.autoSpec){
            let tries = 0;
            const trySetSpect = (): void => {
                const activity = window.getGameActivity();
                if (activity.map === null){
                    if (++tries < 600) setTimeout(trySetSpect, 100);
                    return;
                }
                if (!activity.custom) window.setSpect(true);
            };
            trySetSpect();
        }

        if (data.discordRPC){
            window.chrome.webview.addEventListener("message", (event) => {
                if (event.data !== "game-updated") return;
                setTimeout(() => {
                    const gameStatus = window.getGameActivity();
                    window.chrome.webview.postMessage(`rpc-update, ${gameStatus.mode}, ${gameStatus.map}`);
                }, 2000);
            });
        }

        if (data.textSelect){
            const textSelectCSS = document.createElement("style");
            textSelectCSS.id = "kute_textSelectCSS";
            textSelectCSS.textContent = "#chatHolder * { user-select: text }";
            document.head.append(textSelectCSS);
        }
    },
});
