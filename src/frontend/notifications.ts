import { kute } from "./client";
import { getElement } from "./utils";

class KuteNotification {
    message: string;
    reqUserInput: boolean;
    duration: number;
    notificationEl: HTMLDivElement;
    countdown: number | undefined;
    handlePromise: ((event: KeyboardEvent) => void) | undefined;
    promise?: Promise<boolean>;
    resolvePromise?: (value: boolean) => void;

    constructor(message: string, reqUserInput: boolean, duration: number){
        this.message = message;
        this.reqUserInput = reqUserInput;
        this.duration = duration;
        this.notificationEl = document.createElement("div");
        this.notificationEl.id = "notification";
        this.countdown = undefined;
        this.handlePromise = undefined;
        if (reqUserInput){
            this.promise = new Promise((resolve) => {
                this.resolvePromise = resolve;
            });
        }
        this.show();
    }

    async createNotificationElement(): Promise<void>{
        const notificationHtml = await import("./components/notification.html");
        this.notificationEl.innerHTML = notificationHtml.default;

        getElement("#notification-content", this.notificationEl).textContent = this.message;
        getElement("#notification-timer", this.notificationEl).textContent = String(this.duration);
        if (this.reqUserInput) getElement("#notification-actions", this.notificationEl).style.display = "block";

        document.body.append(this.notificationEl);
    }

    startTimer(): void{
        this.countdown = setInterval(() => {
            this.duration--;
            getElement("#notification-timer", this.notificationEl).textContent = String(this.duration);
            if (this.duration <= 0){
                clearInterval(this.countdown);
                this.resolvePromise?.(false);
                this.hide();
            }
        }, 1000);
    }

    hide(): void{
        clearInterval(this.countdown);
        if (this.handlePromise) document.removeEventListener("keydown", this.handlePromise);
        this.notificationEl.classList.add("slide-out");
        setTimeout(() => this.notificationEl.remove(), 2000);
    }

    show(): void{
        this.createNotificationElement();
        setTimeout(() => this.notificationEl.classList.add("slide-in"), 10);
        this.startTimer();

        if (this.reqUserInput){
            this.handlePromise = (event): void => {
                if (event.key === "y" || event.key === "n"){
                    const action = event.key === "y";

                    getElement(`#${event.key}`, this.notificationEl).classList.add("bounce");

                    this.resolvePromise?.(action);
                    this.hide();
                }
            };
            document.addEventListener("keydown", this.handlePromise);
        }
    }
}

kute.showNotification = (message: string, reqUserInput: boolean, seconds: number): Promise<boolean> | KuteNotification => {
    const notification = new KuteNotification(message, reqUserInput, seconds);
    return notification.promise ?? notification;
};
