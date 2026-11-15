const REFRESH_KEY = "__FRVR_auth_refresh_token";
const TOKEN_KEY = "krunker_token";
const HANG_RELOADS_KEY = "kute_hang_reloads";
const MAX_HANG_RELOADS = 2;
const HANG_MS = 1500;
const GIVE_UP_MS = 90000;
const POLL_MS = 1000;

export function restart(): void{
    location.assign("https://krunker.io/");
}

let holdUntil = 0;

export function holdRestart(ms: number): void{
    holdUntil = Date.now() + ms;
}

function hasFrvrSession(): boolean{
    return localStorage.getItem(REFRESH_KEY) !== null || document.cookie.includes(`${REFRESH_KEY}=`);
}

function hasLobby(): boolean{
    try {
        return Boolean(window.getGameActivity?.()?.id);
    }
    catch {
        return false;
    }
}

function watchForHang(mayHang: boolean): void{
    const start = Date.now();
    let sessionSince = 0;
    const timer = setInterval(() => {
        if (hasLobby()){
            sessionStorage.removeItem(HANG_RELOADS_KEY);
            clearInterval(timer);
            return;
        }
        if (Date.now() - start > GIVE_UP_MS){
            clearInterval(timer);
            return;
        }
        if (!mayHang || !hasFrvrSession()) return;
        if (sessionSince === 0) sessionSince = Date.now();
        if (Date.now() - sessionSince < HANG_MS) return;
        clearInterval(timer);

        const reloads = Number(sessionStorage.getItem(HANG_RELOADS_KEY) ?? 0);
        if (reloads >= MAX_HANG_RELOADS) return;
        sessionStorage.setItem(HANG_RELOADS_KEY, String(reloads + 1));
        console.log("[kute] session: no lobby after the frvr login, reloading");
        restart();
    }, POLL_MS);
}

function watchForLogout(): void{
    let signedIn = localStorage.getItem(TOKEN_KEY) !== null;
    let loggedOut = false;
    setInterval(() => {
        if (loggedOut){
            if (!document.pointerLockElement) restart();
            return;
        }
        const now = localStorage.getItem(TOKEN_KEY) !== null;
        if (signedIn && !now && Date.now() > holdUntil){
            loggedOut = true;
            console.log("[kute] session: logged out, reloading");
        }
        signedIn = now;
    }, POLL_MS);
}

if (location.hostname === "krunker.io" && location.pathname === "/"){
    watchForHang(!hasFrvrSession());
    watchForLogout();
}
