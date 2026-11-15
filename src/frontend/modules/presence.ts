import { kute } from "../client";
import api from "./api";

const RECONNECT_S = [2, 4, 8, 16, 30];
const SYNC_MS = 2000;
const STABLE_MS = 30000;
const PROOF_MS = 1000;

function currentGame(): string{
    if (document.getElementById("signedInHeaderBar") === null) return "";
    const id = window.getGameActivity?.()?.id;
    return typeof id === "string" ? id : "";
}

function ownName(): string{
    const user = window.getGameActivity?.()?.user;
    if (typeof user !== "string") return "";
    if (localStorage.getItem("kro_setngss_premiumBadge") === "false"){
        const account = localStorage.getItem("krunker_username");
        if (account) return account;
    }
    return user;
}

export async function playerHash(game: string, name: string): Promise<string>{
    const bytes = new TextEncoder().encode(game + "\n" + name);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function devProof(nonce: string, game: string, hash: string): Promise<{ user: string; proof: string; } | null>{
    return new Promise((resolve) => {
        let timer = 0;
        const listener = (event: MessageEvent): void => {
            const reply = event?.data?.devProof;
            if (reply?.nonce !== nonce) return;
            clearTimeout(timer);
            window.chrome.webview.removeEventListener("message", listener);
            resolve(typeof reply.user === "string" && typeof reply.proof === "string" ? { user: reply.user, proof: reply.proof } : null);
        };
        timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", listener);
            resolve(null);
        }, PROOF_MS);
        window.chrome.webview.addEventListener("message", listener);
        window.chrome.webview.postMessage(`dev-proof, ${nonce}, ${game}, ${hash}`);
    });
}

class Presence {
    game = "";
    roster: Set<string> = new Set();
    devs: Map<string, string> = new Map();
    nonce = "";
    listeners: Set<() => void> = new Set();
    socket: WebSocket | null = null;
    failures = 0;
    timer = 0;
    joined = "";

    constructor(){
        api.available().then((available) => {
            if (available) this.open();
        });
        api.listeners.add((online) => {
            if (!online){
                this.socket?.close();
                return;
            }
            this.failures = 0;
            api.available().then((available) => {
                if (available && !this.socket) this.open();
            });
        });
    }

    open(): void{
        if (api.down || api.offline()) return;
        const socket = new WebSocket(api.base.replace(/^http/, "ws") + "/ws");
        this.socket = socket;

        socket.addEventListener("open", () => {
            setTimeout(() => {
                if (this.socket === socket) this.failures = 0;
            }, STABLE_MS);
            socket.send(JSON.stringify(kute.settings.data.counted === true ? { t: "hi" } : { t: "hi", first: true }));
            this.sync();
            this.timer = setInterval(() => this.sync(), SYNC_MS);
        });
        socket.addEventListener("message", (event) => this.receive(event.data));
        socket.addEventListener("close", () => {
            clearInterval(this.timer);
            this.socket = null;
            this.joined = "";
            this.nonce = "";
            this.setRoster("", []);
            const wait = RECONNECT_S[this.failures++];
            if (wait !== undefined) setTimeout(() => this.open(), wait * 1000);
        });
    }

    async sync(): Promise<void>{
        const game = currentGame();
        const name = game ? ownName() : "";
        const wanted = game && name ? game + "\n" + name : "";
        if (wanted === this.joined) return;
        this.joined = wanted;
        if (!wanted){
            this.send({ t: "leave" });
            this.setRoster("", []);
            return;
        }
        const hash = await playerHash(game, name);
        if (this.joined !== wanted) return;
        const dev = kute.dev === true && this.nonce ? await devProof(this.nonce, game, hash) : null;
        if (this.joined !== wanted) return;
        this.send(dev ? { t: "join", game, hash, dev } : { t: "join", game, hash });
    }

    send(message: object): void{
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }

    receive(data: unknown): void{
        let message;
        try {
            message = JSON.parse(String(data));
        }
        catch {
            return;
        }
        if (message?.t === "hello" && typeof message.nonce === "string"){
            this.nonce = message.nonce;
        }
        else if (message?.t === "roster" && typeof message.game === "string" && Array.isArray(message.players)){
            if (this.joined.startsWith(message.game + "\n")) this.setRoster(message.game, message.players);
        }
        else if (message?.t === "+" && typeof message.h === "string"){
            this.remember(message.h, message.d === 1 ? message.c : undefined);
            this.changed();
        }
        else if (message?.t === "-" && typeof message.h === "string"){
            this.roster.delete(message.h);
            this.devs.delete(message.h);
            this.changed();
        }
        else if (message?.t === "counted"){
            kute.settings.data.counted = true;
            window.chrome.webview.postMessage("set-config, counted, true");
        }
    }

    remember(hash: string, clan: unknown): void{
        this.roster.add(hash);
        if (typeof clan === "string" && clan !== "") this.devs.set(hash, clan);
        else this.devs.delete(hash);
    }

    setRoster(game: string, players: unknown[]): void{
        if (game === this.game && players.length === 0 && this.roster.size === 0) return;
        this.game = game;
        this.roster = new Set();
        this.devs = new Map();
        for (const player of players){
            if (Array.isArray(player) && typeof player[0] === "string") this.remember(player[0], player[1] === 1 ? player[2]?.c : undefined);
        }
        this.changed();
    }

    changed(): void{
        for (const listener of this.listeners) listener();
    }
}

const presence = new Presence();
kute.presence = presence;
export default presence;
