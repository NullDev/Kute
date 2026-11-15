import styles from "../components/spotifyOverlay.css";
import markup from "../components/spotifyOverlay.html";
import { kute } from "../client";

const PROGRESS_STEP_MS = 1000;

interface SpotifyState {
    playing: boolean;
    position: number;
    duration: number;
}

type SpotifySong = SpotifyState & {title: string, artist: string, album: string, artwork: string|null};

class SpotifyOverlay {
    overlay: HTMLElement | null = null;
    playback: (SpotifyState & { at: number; }) | null = null;
    timer: number | null = null;
    artwork: string | null = null;
    listener = (event: MessageEvent): void => {
        const { data } = event;
        if (typeof data !== "object" || data === null) return;
        if ("spotify" in data) this.song(data.spotify);
        else if ("spotifyState" in data) this.state(data.spotifyState);
    };

    constructor(){
        kute.settings.toggleSpotifyOverlay = (enabled): void => this.toggle(enabled);
        this.toggle(!!kute.settings.data.spotifyOverlay);
    }

    toggle(enabled: boolean): void{
        if (!enabled){
            window.chrome.webview.removeEventListener("message", this.listener);
            window.chrome.webview.postMessage("spotify-stop");
            this.stopProgress();
            this.overlay?.remove();
            this.overlay = null;
            this.artwork = null;
            document.querySelector("#kuteSpotifyOverlayCSS")?.remove();
            return;
        }
        if (this.overlay) return;
        const style = document.createElement("style");
        style.id = "kuteSpotifyOverlayCSS";
        style.textContent = styles;
        document.head.append(style);

        this.overlay = document.createElement("div");
        this.overlay.id = "kuteSpotifyOverlay";
        this.overlay.hidden = true;
        this.overlay.innerHTML = markup;
        (document.querySelector("#uiBase") ?? document.body).append(this.overlay);

        window.chrome.webview.addEventListener("message", this.listener);
        window.chrome.webview.postMessage("spotify-start");
    }

    song(song: SpotifySong | null): void{
        if (!this.overlay) return;
        this.overlay.hidden = !song;
        if (!song) return;
        const artwork = this.overlay.querySelector("#kuteSpotifyArtwork") as HTMLImageElement;
        if (song.artwork !== this.artwork){
            this.artwork = song.artwork;
            artwork.src = song.artwork ?? "";
        }
        artwork.alt = song.album;
        (this.overlay.querySelector("#kuteSpotifyTitle") as HTMLElement).textContent = song.title;
        (this.overlay.querySelector("#kuteSpotifyArtist") as HTMLElement).textContent = song.artist;
        this.state(song);
    }

    state({ playing, position, duration }: SpotifyState): void{
        if (!this.overlay) return;
        this.overlay.classList.toggle("paused", !playing);
        this.playback = { playing, position, duration, at: performance.now() };
        this.drawProgress();
        if (playing && this.timer === null) this.timer = window.setInterval(() => this.drawProgress(), PROGRESS_STEP_MS);
        else if (!playing) this.stopProgress();
    }

    drawProgress(): void{
        const bar = (this.overlay?.querySelector("#kuteSpotifyProgress > div") ?? null) as HTMLElement|null;
        if (!bar || !this.playback) return;
        const { playing, position, duration, at } = this.playback;
        const now = position + (playing ? performance.now() - at : 0);
        bar.style.transform = `scaleX(${duration > 0 ? Math.min(1, now / duration).toFixed(4) : 0})`;
    }

    stopProgress(): void{
        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;
    }
}

export default new SpotifyOverlay();
