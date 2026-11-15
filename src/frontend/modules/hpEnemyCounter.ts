import { kute } from "../client";
import { getElement, checkCompMode } from "../utils";

class HpEnemyCounter {
    numberDisplay: HTMLDivElement;
    enemyOBJ: number;
    enemyTimeout: number | null;
    observer: MutationObserver | null;
    pointCounter: HTMLElement | null;
    gameUpdateListener: (event: MessageEvent) => void;

    constructor(){
        this.numberDisplay = document.createElement("div");
        this.numberDisplay.id = "hpEnemyCounter";
        this.numberDisplay.classList.add("statIcon");
        this.numberDisplay.style.cssText = "transform: translate(0, -2.7px);";
        this.numberDisplay.innerHTML = `
            <div class="greyInner" style="display: flex">
                <span style="color:white; font-size:15px; margin-right: 4px;">on</span>
                <span id="myScoreVal" class="pointVal">0</span>
            </div>`;

        this.enemyOBJ = 0;
        this.enemyTimeout = null;
        this.observer = null;
        this.pointCounter = null;
        this.gameUpdateListener = (event: MessageEvent): void => {
            if (event.data === "game-updated"){
                setTimeout(() => {
                    if (checkCompMode()){
                        window.chrome.webview.removeEventListener("message", this.gameUpdateListener);

                        this.setupDisplay();
                    }
                }, 2000);
            }
        };
        kute.settings.toggleHpEnemyCounter = (enabled): void => this.toggle(enabled);
        this.toggle(true);
    }
    toggle(enabled: boolean): void{
        if (enabled){
            window.chrome.webview.addEventListener("message", this.gameUpdateListener);
            if (checkCompMode()){
                window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                this.setupDisplay();
            }
        }
        else {
            window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
            this.observer?.disconnect();
            this.numberDisplay.remove();
        }
    }

    processTeamScores = (): void => {
        const {pointCounter} = this;
        if (!pointCounter) return;
        for (const team of document.querySelectorAll("#tScoreC1, #tScoreC2")){
            if (team && !team.className.includes("you")){
                const scoreElement = team.nextElementSibling as HTMLElement | null;
                if (!scoreElement) continue;
                const currentEnemyOBJ = Number.parseInt(scoreElement.textContent ?? "", 10);
                if (Number.isNaN(currentEnemyOBJ)) continue;
                if (currentEnemyOBJ > this.enemyOBJ){
                    pointCounter.textContent = String((currentEnemyOBJ - this.enemyOBJ) / 10);
                    if (this.enemyTimeout) clearTimeout(this.enemyTimeout);
                    this.enemyTimeout = setTimeout(() => {
                        pointCounter.textContent = "0";
                        this.enemyTimeout = null;
                    }, 1600);
                }
                this.enemyOBJ = currentEnemyOBJ;
            }
        }
    };

    setupDisplay(): void{
        const pointCounter = getElement(".pointVal", this.numberDisplay);
        this.pointCounter = pointCounter;
        getElement(".topRightCounters").append(this.numberDisplay);

        this.observer?.disconnect();
        this.observer = new MutationObserver(this.processTeamScores);
        this.observer.observe(getElement("#teamScores"), {
            childList: true,
            subtree: true,
        });
    }
}

export default new HpEnemyCounter();
