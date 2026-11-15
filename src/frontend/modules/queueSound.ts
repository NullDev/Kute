import { kute } from "../client";

const KUTE_SOUND = "";
const DEFAULT_VOLUME = 40;
const REPLY_TIMEOUT = 5000;

const hostSupportsSounds = (): boolean => kute.hostFeatures?.includes("custom-sounds") ?? false;

export const volume = (): number => Math.min(1, Math.max(0, Number(kute.settings.data.queueSoundVolume ?? DEFAULT_VOLUME) / 100 || 0));

function ask<T>(message: string, pick: (data: any) => T | undefined): Promise<T | null>{
    return new Promise((resolve) => {
        let timer = 0;
        const listener = (event: MessageEvent): void => {
            const value = pick(event.data);
            if (value === undefined) return;
            clearTimeout(timer);
            window.chrome.webview.removeEventListener("message", listener);
            resolve(value);
        };
        timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", listener);
            resolve(null);
        }, REPLY_TIMEOUT);
        window.chrome.webview.addEventListener("message", listener);
        window.chrome.webview.postMessage(message);
    });
}

export const kuteSound = (): Promise<string> => import("../components/queue/match-found.ogg").then((module) => module.default);

const readSound = (name: string): Promise<{ data?: string; error?: string; } | null> => ask(`sound-get ${JSON.stringify({ name })}`, (data) => (data?.sound?.name === name ? data.sound : undefined));

export async function chosenSound(): Promise<string>{
    const name = String(kute.settings.data.queueSoundFile ?? KUTE_SOUND);
    if (name !== KUTE_SOUND && hostSupportsSounds()){
        const sound = await readSound(name);
        if (sound?.data) return sound.data;
    }
    return kuteSound();
}

class QueueSound {
    context: AudioContext | null = null;
    playing: AudioBufferSourceNode | null = null;
    gain: GainNode | null = null;

    constructor(){
        kute.queueSound = { showOptions: (): Promise<void> => this.showOptions() };
    }

    async play(base64: string): Promise<void>{
        this.stop();
        this.context ??= new AudioContext();
        if (this.context.state === "suspended") await this.context.resume();
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const buffer = await this.context.decodeAudioData(bytes.buffer);
        const gain = this.context.createGain();
        gain.gain.value = volume();
        gain.connect(this.context.destination);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = (): void => {
            if (this.playing === source) this.playing = null;
            source.disconnect();
            gain.disconnect();
        };
        source.start();
        this.playing = source;
        this.gain = gain;
    }

    stop(): void{
        this.playing?.stop();
        this.playing = null;
    }

    async showOptions(): Promise<void>{
        const html = await import("../components/queueSoundOptions.html");
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
        const host = document.createElement("div");
        overlay.append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = html.default;

        const element = (id: string): HTMLElement => (shadow.querySelector(`#${id}`) as HTMLElement);
        const select = element("qsSound") as HTMLSelectElement;
        const slider = element("qsVolume") as HTMLInputElement;
        const savedVolume = Math.round(volume() * 100);
        const error = element("qsError");
        let chosen = String(kute.settings.data.queueSoundFile ?? KUTE_SOUND);

        const showError = (text: string): void => {
            error.textContent = text;
            error.hidden = !text;
        };

        const fillSounds = async(): Promise<void> => {
            const supported = hostSupportsSounds();
            const files = supported ? await ask("sound-list", (data) => (Array.isArray(data?.sounds) ? (data.sounds as string[]) : undefined)) ?? [] : [];
            const options = [new Option("Kute's sound", KUTE_SOUND)];
            if (files.length){
                const group = document.createElement("optgroup");
                group.label = "Your sounds";
                group.append(...files.map((name) => new Option(name, name)));
                options.push(group as any);
            }
            if (chosen !== KUTE_SOUND && !files.includes(chosen)) options.push(new Option(`${chosen} (missing)`, chosen));
            select.replaceChildren(...options);
            select.value = chosen;
            element("qsOpenFolder").hidden = !supported;
            element("qsRefresh").hidden = !supported;
            let hint = "Put MP3, OGG, WAV or FLAC files into Documents\\kute\\sounds";
            if (!supported) hint = "Your own sounds need a newer Kute. Update Kute to use them.";
            else if (files.length === 0) hint = "Add your own: put MP3, OGG, WAV or FLAC files into Documents\\kute\\sounds, then press Refresh";
            element("qsFileHint").textContent = hint;
        };

        const showVolume = (): void => {
            element("qsVolumeValue").textContent = `${slider.value} %`;
        };
        slider.value = String(savedVolume);
        showVolume();
        slider.oninput = (): void => {
            kute.settings.data.queueSoundVolume = Number(slider.value);
            showVolume();
            if (this.playing && this.gain) this.gain.gain.value = volume();
        };

        select.onchange = (): void => {
            chosen = select.value;
            showError("");
        };
        element("qsPlay").onclick = async(): Promise<void> => {
            showError("");
            if (volume() === 0) showError("The volume is at 0.");
            try {
                if (chosen === KUTE_SOUND){
                    await this.play(await kuteSound());
                    return;
                }
                const sound = await readSound(chosen);
                if (!sound?.data){
                    showError(sound?.error ?? "Kute did not answer.");
                    return;
                }
                await this.play(sound.data);
            }
            catch {
                showError("This file cannot be played. Try MP3, OGG or WAV.");
            }
        };
        element("qsOpenFolder").onclick = (): void => window.chrome.webview.postMessage("open, sounds");
        element("qsRefresh").onclick = (): Promise<void> => fillSounds();

        const controller = new AbortController();
        const close = (): void => {
            controller.abort();
            this.stop();
            overlay.remove();
            if (Number(slider.value) !== savedVolume) window.chrome.webview.postMessage(`set-config-json queueSoundVolume ${Number(slider.value)}`);
            if (chosen === String(kute.settings.data.queueSoundFile ?? KUTE_SOUND)) return;
            kute.settings.data.queueSoundFile = chosen;
            window.chrome.webview.postMessage(`set-config-json queueSoundFile ${JSON.stringify(chosen)}`);
        };
        element("qsDone").onclick = close;
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                close();
            },
            { signal: controller.signal, capture: true },
        );

        document.body.append(overlay);
        await fillSounds();
    }
}

export default new QueueSound();
