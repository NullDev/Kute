export const hook = (target: { prototype: Record<string, any> }, method: string, wrapper: (this: any, args: any[], original: Function) => any): void => {
    const original = target.prototype[method];
    target.prototype[method] = function(this: any, ...args: any[]): any{
        const result = wrapper.call(this, args, original);
        return result === undefined ? original.apply(this, args) : result;
    };
};

export const waitForElement = <T extends Element = HTMLElement>(selector: string, timeoutMs = 30000): Promise<T> => {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(selector);
        if (existing){
            resolve(existing as T);
            return;
        }

        const pending = { timer: 0 };
        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element){
                clearTimeout(pending.timer);
                observer.disconnect();
                resolve(element as T);
            }
        });
        pending.timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`element never showed up: ${selector}`));
        }, timeoutMs);
        observer.observe(document.body, { childList: true, subtree: true });
    });
};

export const getElement = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T => {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`element not found: ${selector}`);
    return element as T;
};

export const getInput = (selector: string, root: ParentNode = document): HTMLInputElement => getElement(selector, root);

export const checkCompMode = (): boolean => document.querySelector(".cmpTmHed") !== null;

export function request(message: string, key: string, timeoutMs = 2000): Promise<any>{
    return new Promise((resolve) => {
        const pending = { timer: 0 };
        const handler = (event: MessageEvent): void => {
            if (event.data?.[key] === undefined) return;
            clearTimeout(pending.timer);
            window.chrome.webview.removeEventListener("message", handler);
            resolve(event.data[key]);
        };
        pending.timer = setTimeout(() => {
            window.chrome.webview.removeEventListener("message", handler);
            resolve(null);
        }, timeoutMs);
        window.chrome.webview.addEventListener("message", handler);
        window.chrome.webview.postMessage(message);
    });
}
