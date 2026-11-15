interface ConfirmOptions {
    title: string;
    paragraphs: string[];
    stay: string;
    leave: string;
}

export async function confirmPopup(options: ConfirmOptions): Promise<boolean>{
    const html = await import("../components/confirm.html");

    const overlay = document.createElement("div");
    overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:center;background:rgba(0,0,0,0.75)";
    const host = document.createElement("div");
    overlay.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = html.default;

    const element = (id: string): HTMLElement => (shadow.querySelector(`#${id}`) as HTMLElement);
    element("confirmTitle").textContent = options.title;
    for (const paragraph of options.paragraphs){
        const p = document.createElement("p");
        p.textContent = paragraph;
        element("confirmText").append(p);
    }
    element("confirmStay").textContent = options.stay;
    element("confirmLeave").textContent = options.leave;

    return new Promise((resolve) => {
        const controller = new AbortController();
        const answer = (leave: boolean): void => {
            controller.abort();
            overlay.remove();
            resolve(leave);
        };
        element("confirmStay").onclick = (): void => answer(false);
        element("confirmLeave").onclick = (): void => answer(true);
        overlay.addEventListener("mousedown", (event) => {
            if (event.target === overlay) answer(false);
        });
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") answer(false);
            },
            { signal: controller.signal },
        );
        document.body.append(overlay);
    });
}
