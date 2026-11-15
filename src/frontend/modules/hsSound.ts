import { kute } from "../client";

class HsSound {
    originalPlay: (soundName: string, volume?: number, loop?: boolean) => any = (): any => {};
    observer = new MutationObserver((mutations) => this.parseChat(mutations));

    constructor(){
        kute.settings.toggleHsSound = (enabled): void => this.toggle(enabled);

        this.setupSoundHook();
    }

    setupSoundHook(): void{
        if (window.SOUND?.play){
            this.originalPlay = window.SOUND.play;
            this.toggle(true);
        }
        else setTimeout(() => this.setupSoundHook(), 100);
    }

    toggle(enabled: boolean): void{
        if (enabled){
            const chatList = document.querySelector("#chatList");
            if (chatList){
                this.observer.observe(chatList, {
                    childList: true,
                });
            }
            const self = this;
            window.SOUND.play = function(soundName: string, volume?: number, loop?: boolean): any{
                if (soundName === "headshot_0" && volume === undefined) return undefined;
                return self.originalPlay.call(window.SOUND, soundName, volume, loop);
            };
        }
        else {
            window.SOUND.play = this.originalPlay;
            this.observer.disconnect();
        }
    }

    parseChat(mutations: MutationRecord[]): void{
        for (const mutation of mutations){
            if (mutation.type !== "childList") continue;

            for (const newNode of mutation.addedNodes){
                if (!(newNode instanceof HTMLElement) || newNode.tagName !== "DIV") continue;

                const messageSpan = newNode.querySelector("span.chatMsg");
                if (!messageSpan) continue;

                const coloredSpans = messageSpan.querySelectorAll("span[style*='color:#'], span[style*='color: rgb']") as NodeListOf<HTMLElement>;
                if (coloredSpans.length <= 0) continue;
                const firstColoredSpan = coloredSpans[0];
                const spanColor = firstColoredSpan.style.color.trim().toLowerCase();
                const spanText = firstColoredSpan.textContent.trim();

                if (spanColor === "rgb(255, 255, 255)" && spanText === "You" && messageSpan.querySelector("img")){
                    window.SOUND.play("headshot_0", 1, false);
                }
            }
        }
    }
}

export default new HsSound();
