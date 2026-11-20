const RESET_AFTER_POPUP_MS = 5000;
const RESTORE_LIMIT_MS = 10000;
const PAGE_WAIT_MS = 1500;
const POPUPS = ".view-stack-overlay, .modal-overlay";

interface Restore {
    scroller: HTMLElement;
    grid: HTMLElement;
    sentinels: Set<HTMLElement>;
    top: number;
    count: number;
    until: number;
    pageTimer: number;
    picture: HTMLElement;
}

function sentinelOf(grid: HTMLElement): HTMLElement | null{
    const next = grid.nextElementSibling;
    return next instanceof HTMLElement && next.matches(".market-grid-sentinel") ? next : null;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
});

async function frames(count: number): Promise<void>{
    for (let frame = 0; frame < count; frame++) await nextFrame();
}

class InventoryScroll {
    watched: WeakSet<Element> = new WeakSet();
    popupClickAt = -Infinity;
    lastTop = 0;
    lastHeight = 0;
    restore: Restore | null = null;
    onWheel = (): void => this.finish(false);

    constructor(){
        document.addEventListener("scroll", (event) => this.onScroll(event), { capture: true, passive: true });
        document.addEventListener(
            "click",
            (event) => {
                if (event.target instanceof Element && event.target.closest(POPUPS)) this.popupClickAt = performance.now();
            },
            { capture: true, passive: true },
        );
    }

    onScroll(event: Event): void{
        const scroller = event.target;
        if (!(scroller instanceof HTMLElement)) return;
        if (this.restore){
            if (scroller === this.restore.scroller && scroller.scrollTop !== this.restore.top) scroller.scrollTop = this.restore.top;
            return;
        }
        const grid = scroller.querySelector(":scope > .market-grid");
        if (!(grid instanceof HTMLElement)) return;
        this.watch(scroller, grid);
        this.lastTop = scroller.scrollTop;
        this.lastHeight = grid.offsetHeight;
    }

    watch(scroller: HTMLElement, grid: HTMLElement): void{
        if (this.watched.has(grid)) return;
        this.watched.add(grid);
        let count = grid.children.length;
        new MutationObserver((records) => {
            const removed = records.reduce((sum, record) => sum + record.removedNodes.length, 0);
            const before = count;
            count = grid.children.length;
            if (this.restore?.grid === grid){
                if (count > before) this.pageArrived();
                return;
            }
            const reset = before > 0 && removed >= before;
            if (reset && this.lastTop > scroller.clientHeight && performance.now() - this.popupClickAt < RESET_AFTER_POPUP_MS){
                this.start(scroller, grid, before, records.flatMap((record) => [...record.removedNodes]));
            }
        }).observe(grid, { childList: true });
    }

    start(scroller: HTMLElement, grid: HTMLElement, count: number, removed: Node[]): void{
        const picture = document.createElement("div");
        picture.className = grid.className;
        picture.style.cssText = grid.style.cssText;
        picture.append(...removed);
        this.restore = { scroller, grid, sentinels: new Set(), top: this.lastTop, count, until: performance.now() + RESTORE_LIMIT_MS, pageTimer: 0, picture };
        grid.style.minHeight = `${this.lastHeight}px`;
        grid.style.alignContent = "start";
        Object.assign(picture.style, {
            position: "absolute",
            top: `${grid.offsetTop}px`,
            left: `${grid.offsetLeft}px`,
            width: `${grid.offsetWidth}px`,
            margin: "0",
            zIndex: "1",
            pointerEvents: "none",
        });
        scroller.append(picture);
        scroller.style.overflowAnchor = "none";
        scroller.scrollTop = this.lastTop;
        scroller.addEventListener("wheel", this.onWheel, { passive: true });
        this.waitForPage();
        this.blink(this.restore).catch((error) => console.error("[kute] inventory scroll:", error));
    }

    pageArrived(): void{
        const { restore } = this;
        if (!restore) return;
        if (restore.grid.children.length >= restore.count - 1 || performance.now() > restore.until) this.finish(true);
        else this.waitForPage();
    }

    waitForPage(): void{
        const { restore } = this;
        if (!restore) return;
        clearTimeout(restore.pageTimer);
        restore.pageTimer = window.setTimeout(() => this.finish(true), PAGE_WAIT_MS);
    }

    async blink(restore: Restore): Promise<void>{
        while (this.restore === restore){
            const sentinel = sentinelOf(restore.grid);
            if (sentinel){
                restore.sentinels.add(sentinel);
                sentinel.style.position = "sticky";
                sentinel.style.bottom = "0";
                sentinel.style.display = "none";
                await frames(2);
                sentinel.style.display = "";
            }
            await frames(2);
        }
    }

    finish(putBack: boolean): void{
        const { restore } = this;
        if (!restore) return;
        this.restore = null;
        clearTimeout(restore.pageTimer);
        restore.scroller.removeEventListener("wheel", this.onWheel);
        restore.picture.remove();
        restore.grid.style.minHeight = "";
        restore.grid.style.alignContent = "";
        restore.scroller.style.overflowAnchor = "";
        for (const sentinel of restore.sentinels){
            sentinel.style.position = "";
            sentinel.style.bottom = "";
            sentinel.style.display = "";
        }
        if (putBack) restore.scroller.scrollTop = restore.top;
        this.lastTop = restore.scroller.scrollTop;
        this.lastHeight = restore.grid.offsetHeight;
    }
}

export default new InventoryScroll();
