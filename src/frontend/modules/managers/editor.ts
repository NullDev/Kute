const KEYWORDS = new Set(("async await break case catch class const continue debugger default delete do else export extends " +
    "finally for function if import in instanceof let new of return static super switch throw try typeof var void " +
    "while with yield get set").split(" "));
const LITERALS = new Set(["true", "false", "null", "undefined", "this", "NaN", "Infinity"]);

const TOKENS = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-fA-F_]+n?\b)|([A-Za-z_$][\w$]*)/g;

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const CSS_TOKENS = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(@[\w-]+|!\s*important\b)|(#[\da-fA-F]{3,8}\b|-?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:%|[a-zA-Z]+)?)|(-?-?[a-zA-Z_][\w-]*)/g;

type Language = "js"|"json"|"css"|"text";

export const languageFor = (path: string): Language => {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (extension === "css") return "css";
    if (extension === "json") return "json";
    if (["js", "mjs"].includes(extension)) return "js";
    return "text";
};

const isProperty = (source: string, end: number): boolean => /^\s*:[^{};]*(?:[;}]|$)/.test(source.slice(end, end + 400));

export function highlight(source: string, language: Language = "js"): string{
    if (language === "text") return escapeHtml(source);
    const css = language === "css";
    let html = "";
    let last = 0;
    for (const match of source.matchAll(css ? CSS_TOKENS : TOKENS)){
        const index = match.index ?? 0;
        const [text] = match;
        let kind = "";
        if (css){
            const [, comment, string, keyword, number, word] = match;
            if (comment) kind = "c";
            else if (string) kind = "s";
            else if (keyword) kind = "k";
            else if (number) kind = "n";
            else if (word){
                const end = index + word.length;
                if (source[end] === "(") kind = "f";
                else if (word.startsWith("--") || isProperty(source, end)) kind = "l";
            }
        }
        else {
            const [, comment, string, number, word] = match;
            if (comment) kind = "c";
            else if (string) kind = language === "json" && /^\s*:/.test(source.slice(index + text.length, index + text.length + 20)) ? "p" : "s";
            else if (number) kind = "n";
            else if (word){
                if (KEYWORDS.has(word)) kind = "k";
                else if (LITERALS.has(word)) kind = "l";
                else if (/^\s*\(/.test(source.slice(index + word.length, index + word.length + 40))) kind = "f";
            }
        }
        if (!kind) continue;
        html += escapeHtml(source.slice(last, index)) + `<span class="tk-${kind}">${escapeHtml(text)}</span>`;
        last = index + text.length;
    }
    return html + escapeHtml(source.slice(last));
}

export interface CodeEditor {
    getValue: () => string;
    isDirty: () => boolean;
    markSaved: (content?: string) => void;
    focus: () => void;
}

export function createCodeEditor(container: HTMLElement, content: string, { onSave, onDirtyChange, onChange, language = "js" }: { onSave: () => void; onDirtyChange: (dirty: boolean) => void; onChange?: (value: string) => void; language?: Language; }): CodeEditor{
    container.innerHTML = `<div class="editor"><div class="editorGutter"></div><div class="editorCode"><pre><code></code></pre>
        <textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea></div></div>`;
    const gutter = container.querySelector(".editorGutter") as HTMLElement;
    const pre = container.querySelector("pre") as HTMLElement;
    const code = container.querySelector("code") as HTMLElement;
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = content;

    let saved = content;
    let dirty = false;
    let lineCount = 0;
    let pending = 0;

    const syncScroll = (): void => {
        pre.scrollTop = textarea.scrollTop;
        pre.scrollLeft = textarea.scrollLeft;
        gutter.scrollTop = textarea.scrollTop;
    };

    const render = (): void => {
        pending = 0;
        const { value } = textarea;
        code.innerHTML = `${highlight(value, language)}\n `;
        const lines = value.split("\n").length;
        if (lines !== lineCount){
            lineCount = lines;
            gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
        }
        syncScroll();
        const nowDirty = value !== saved;
        if (nowDirty !== dirty){
            dirty = nowDirty;
            onDirtyChange(dirty);
        }
    };

    const insert = (text: string): void => {
        document.execCommand("insertText", false, text);
    };

    const changed = (): void => {
        render();
        onChange?.(textarea.value);
    };
    textarea.addEventListener("input", () => {
        if (textarea.value.length < 150_000) changed();
        else if (!pending) pending = setTimeout(changed, 150);
    });
    textarea.addEventListener("scroll", syncScroll);
    textarea.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s"){
            event.preventDefault();
            onSave();
            return;
        }
        if (event.key === "Tab" && !event.ctrlKey && !event.altKey){
            event.preventDefault();
            const { selectionStart, selectionEnd, value } = textarea;
            const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
            if (event.shiftKey){
                const spaces = /^ {1,4}/.exec(value.slice(lineStart))?.[0].length ?? 0;
                if (!spaces) return;
                textarea.setSelectionRange(lineStart, lineStart + spaces);
                document.execCommand("delete");
                textarea.setSelectionRange(Math.max(lineStart, selectionStart - spaces), Math.max(lineStart, selectionEnd - spaces));
                return;
            }
            insert("    ");
            return;
        }
        if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.shiftKey){
            event.preventDefault();
            const { selectionStart, value } = textarea;
            const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
            const line = value.slice(lineStart, selectionStart);
            const indent = /^\s*/.exec(line)?.[0] ?? "";
            const extra = language !== "text" && /[{[(]\s*$/.test(line) ? "    " : "";
            insert(`\n${indent}${extra}`);
        }
    });

    render();

    return {
        getValue: () => textarea.value,
        isDirty: () => dirty,
        markSaved(written = textarea.value): void{
            saved = written;
            render();
        },
        focus(): void{
            textarea.focus();
            textarea.setSelectionRange(0, 0);
        },
    };
}

interface EditorView {
    editor: CodeEditor;
    bar: HTMLElement;
    saveButton: HTMLElement;
}

const element = (tag: string, className: string, text = ""): HTMLElement => {
    const created = document.createElement(tag);
    created.className = className;
    created.textContent = text;
    return created;
};

export function createEditorView(parent: HTMLElement, { title, content, language, isNew = false, onSave, onClose, onChange }: { title: string; content: string; language: Language; isNew?: boolean; onSave: (closeAfter: boolean) => void; onClose: () => void; onChange?: (value: string) => void; }): EditorView{
    parent.textContent = "";
    const view = element("div", "editorView");
    const bar = element("div", "editorBar");
    const titleElement = element("div", "editorFile", title);
    const dirtyMark = element("span", "dirty", isNew ? " (new, not saved yet)" : "");
    titleElement.append(dirtyMark);
    const saveButton = element("div", "btn primary", "Save");
    const saveCloseButton = element("div", "btn", "Save & close");
    const closeButton = element("div", "btn", "Close");
    saveButton.onclick = (): void => onSave(false);
    saveCloseButton.onclick = (): void => onSave(true);
    closeButton.onclick = onClose;
    bar.append(titleElement, saveButton, saveCloseButton, closeButton);
    const container = element("div", "");
    container.style.cssText = "display:flex;flex:1 1 auto;min-height:0";
    view.append(bar, container, element("div", "editorKeys", "Ctrl+S save  ·  Ctrl+Z / Ctrl+Y undo, redo  ·  Tab / Shift+Tab indent  ·  Esc close"));
    parent.append(view);

    const editor = createCodeEditor(container, content, {
        language,
        onChange,
        onSave: () => onSave(false),
        onDirtyChange: (dirty) => {
            dirtyMark.textContent = dirty ? "  ● unsaved" : "";
        },
    });
    editor.focus();
    return { editor, bar, saveButton };
}
