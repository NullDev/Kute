const button = document.createElement("div");
button.className = "bpBtn skip";
button.id = "claimAllBtn";
button.textContent = "Claim All";

function findClaimables(): HTMLElement[]{
    return Array.from(document.querySelectorAll(".bpClaimB") as NodeListOf<HTMLElement>).filter(
        (btn) => btn.offsetParent !== null && btn.textContent.trim() === "Claim",
    );
}

function updateButtonState(): void{
    const hasClaimable = findClaimables().length > 0;
    hasClaimable ? button.classList.remove("disabled") : button.classList.add("disabled");
    button.textContent = hasClaimable ? "Claim All" : "Nothing to Claim";
}

async function claimEverything(): Promise<void>{
    const items = findClaimables();
    if (items.length === 0) return;

    for (const btn of items){
        const code = btn.getAttribute("onclick");
        if (code?.includes("windows[5].claimItem(")) btn.click();

        await new Promise((r) => setTimeout(r, 200));
    }

    updateButtonState();
}

button.onclick = (): void => {
    window.playSelect?.(0.1);
    claimEverything();
};

function addClaimAllButton(): void{
    const bar = document.querySelector(".bpBotH");
    if (!bar) return;

    bar.append(button);
    updateButtonState();
}

const originalshowWindow = window.showWindow;
window.showWindow = (...args: any[]): any => {
    const number = args[0];
    if (number === 6) queueMicrotask(() => addClaimAllButton());
    return originalshowWindow(...args);
};

export {};
