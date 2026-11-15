import { kute } from "../../client";
import html from "../../components/managers/swapper.html";
import { openManagerPopup, makeDropTarget, readBase64, askText, askConfirm, hostSupportsManagers, formatSize, type ManagerPopup, type DroppedFile } from "./popup";
import { createEditorView, languageFor, type CodeEditor } from "./editor";
import { reloadStylesheets, hostWatchesSwapper } from "./stylesheets";

const TEXT_FILES = new Set(["css", "js", "mjs", "json", "txt", "html", "htm", "svg", "xml", "obj", "mtl", "glsl", "frag", "vert", "md", "csv"]);

const MAX_EDIT_SIZE = 4 * 1024 * 1024;

const isText = (path: string): boolean => TEXT_FILES.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

const hostSupportsEditor = (): boolean => kute.hostFeatures?.includes("swapper-editor") ?? false;

interface SwapperList {
    files: { path: string, size: number }[];
    dirs: string[];
    seen: string[];
    enabled: boolean;
}

interface TreeFolder {
    name: string;
    path: string;
    folders: Map<string, TreeFolder>;
    files: { name: string, path: string, size: number }[];
}

const MAX_FILE_SIZE = 32 * 1024 * 1024;

const MAX_SEARCH_ROWS = 400;

const element = (tag: string, className = "", text = ""): HTMLElement => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text) created.textContent = text;
    return created;
};

const iconButton = (icon: string, title: string, onClick: () => void, extraClass = ""): HTMLElement => {
    const button = element("div", `iconBtn ${extraClass}`);
    button.title = title;
    button.append(element("span", "mi", icon));
    button.onclick = (event): void => {
        event.stopPropagation();
        onClick();
    };
    return button;
};

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const dirName = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const buildTree = (files: { path: string, size: number }[], dirs: string[]): TreeFolder => {
    const root: TreeFolder = { name: "", path: "", folders: new Map(), files: [] };
    const folderFor = (path: string): TreeFolder => {
        let node = root;
        for (const part of path.split("/").filter(Boolean)){
            let next = node.folders.get(part);
            if (!next){
                next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), files: [] };
                node.folders.set(part, next);
            }
            node = next;
        }
        return node;
    };
    for (const dir of dirs) folderFor(dir);
    for (const file of files) folderFor(dirName(file.path)).files.push({ name: baseName(file.path), path: file.path, size: file.size });
    return root;
};

const countFiles = (folder: TreeFolder): number => folder.files.length + [...folder.folders.values()].reduce((sum, child) => sum + countFiles(child), 0);

class SwapperManager {
    popup: ManagerPopup | null = null;
    list: SwapperList | null = null;
    collapsedOwn: Set<string> = new Set();
    expandedGame: Set<string> = new Set();
    search = "";
    touched: Set<string> = new Set();
    stale: Set<string> = new Set();
    uploadDone: ((error: string | null) => void) | null = null;
    editing: { path: string, editor: CodeEditor, closeAfterSave: boolean } | null = null;
    pendingRead: string | null = null;
    saving = false;
    forceClose = false;

    open(): void{
        if (this.popup) return;
        if (!hostSupportsManagers()){
            window.chrome.webview.postMessage("open, swapper");
            kute.showNotification("This Kute version can only open the swapper folder. Update Kute for the swapper manager.", false, 6);
            return;
        }
        this.popup = openManagerPopup(html, {
            onMessage: (data) => this.receive(data),
            canClose: () => this.canClose(),
            onEscape: () => {
                if (!this.editing) return false;
                this.leaveEditor();
                return true;
            },
        });
        const { shadow, signal } = this.popup;
        signal.addEventListener("abort", () => {
            this.popup = null;
            this.editing = null;
            this.pendingRead = null;
            this.saving = false;
            this.forceClose = false;
            this.uploadDone?.(null);
            this.uploadDone = null;
        });
        (shadow.querySelector("#swFolder") as HTMLElement).onclick = (): void => this.send("reveal", { path: "" });
        (shadow.querySelector("#swReload") as HTMLElement).onclick = (): void => this.send("list", {});
        (shadow.querySelector("#swRefreshNow") as HTMLElement).onclick = (): void => location.reload();
        (shadow.querySelector("#swNewFolder") as HTMLElement).onclick = (): Promise<void> => this.newFolder("");
        const newFile = shadow.querySelector("#swNewFile") as HTMLElement;
        if (!hostSupportsEditor()) newFile.style.display = "none";
        newFile.onclick = (): Promise<void> => this.newFile("");
        makeDropTarget(shadow.querySelector("#swOwnColumn") as HTMLElement, (files) => this.drop("", files));
        const search = shadow.querySelector("#swSearch") as HTMLInputElement;
        search.value = this.search;
        search.oninput = (): void => {
            this.search = search.value.trim().toLowerCase();
            this.renderGame();
        };
        (shadow.querySelector("#swOwnTree") as HTMLElement).textContent = "Loading...";
        this.send("list", {});
        if (!hostWatchesSwapper()){
            window.addEventListener("focus", () => {
                if (!this.editing && !this.uploadDone) this.send("list", {});
            }, { signal });
        }
    }

    send(command: string, payload: object): void{
        window.chrome.webview.postMessage(`swapper-${command} ${JSON.stringify(payload)}`);
    }

    async drop(folder: string, files: DroppedFile[]): Promise<void>{
        let dropped = files;
        if (!folder && dropped.every(({ path }) => path.toLowerCase().startsWith("swapper/"))){
            dropped = dropped.map(({ path, file }) => ({ path: path.slice("swapper/".length), file }));
        }
        await this.upload(dropped.map(({ path, file }) => ({ path: folder ? `${folder}/${path}` : path, file })));
    }

    async replace(gamePath: string, files: DroppedFile[]): Promise<void>{
        if (!this.popup) return;
        if (files.length !== 1){
            this.popup.showError("Drop exactly one file onto a game file. Drop several onto a folder instead.");
            return;
        }
        const [{ file }] = files;
        const extension = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        if (extension(file.name) !== extension(gamePath)){
            const text = `${file.name} is saved as ${baseName(gamePath)}, the game will read it as .${extension(gamePath)}. Go ahead?`;
            if (!await askConfirm(this.popup.shadow, "Different file type", text, "Save anyway")) return;
        }
        await this.upload([{ path: gamePath, file }]);
    }

    async upload(files: { path: string, file: File }[]): Promise<void>{
        const problems: string[] = [];
        for (const { path, file } of files){
            if (!this.popup) return;
            if (file.size > MAX_FILE_SIZE){
                problems.push(`${path}: larger than 32 MB, put it in with Open swapper folder`);
                continue;
            }
            const data = await readBase64(file);
            const error = await new Promise<string | null>((resolve) => {
                this.uploadDone = resolve;
                this.send("upload", { path, data });
            });
            if (error) problems.push(error);
            else this.touched.add(path.toLowerCase());
        }
        this.send("list", {});
        if (problems.length) this.popup?.showError(problems.join("\n"));
    }

    receive(data: any): void{
        if (data.managerError) this.popup?.showError(data.managerError);
        if (data.swapperUploaded){
            const done = this.uploadDone;
            this.uploadDone = null;
            done?.(data.swapperUploaded.error ?? null);
        }
        if (data.swapperSource && data.swapperSource.path === this.pendingRead){
            this.pendingRead = null;
            if (typeof data.swapperSource.content === "string") this.showEditor(data.swapperSource.path, data.swapperSource.content);
            else this.popup?.showError(`${data.swapperSource.path} could not be read as text.`);
        }
        if (data.swapperWritten && this.saving){
            this.saving = false;
            if (data.swapperWritten.error) this.popup?.showError(data.swapperWritten.error);
            else if (this.editing){
                this.touched.add(this.editing.path.toLowerCase());
                this.editing.editor.markSaved();
                if (this.editing.closeAfterSave) this.closeEditor();
            }
        }
        if (data.swapperChanged && !this.editing && !this.uploadDone) this.send("list", {});
        if (!data.swapper) return;
        const before = this.list;
        this.list = data.swapper;
        if (before) this.applyChanges(before, data.swapper);
        this.render();
    }

    applyChanges(before: SwapperList, after: SwapperList): void{
        const sizes = (list: SwapperList): Map<string, number> => new Map(list.files.map((file) => [file.path.toLowerCase(), file.size]));
        const old = sizes(before);
        const now = sizes(after);
        const changed = new Set(this.touched);
        this.touched.clear();
        if (before.enabled !== after.enabled){
            for (const path of [...old.keys(), ...now.keys()]) changed.add(path);
        }
        for (const [path, size] of now) if (old.get(path) !== size) changed.add(path);
        for (const path of old.keys()) if (!now.has(path)) changed.add(path);
        if (!changed.size) return;

        const css = new Set([...changed].filter((path) => path.endsWith(".css")));
        if (css.size && !hostWatchesSwapper()) reloadStylesheets(css);
        const seen = new Set(after.seen.map((path) => path.toLowerCase()));
        for (const path of changed) if (!css.has(path) && seen.has(path)) this.stale.add(path);
    }

    get(selector: string): HTMLElement{
        return this.popup?.shadow.querySelector(selector) as HTMLElement;
    }

    render(): void{
        if (!this.popup || !this.list) return;
        const notice = this.get("#swNotice");
        const off = this.list.enabled === false;
        notice.hidden = !off && !this.stale.size;
        const count = this.stale.size;
        (notice.querySelector("span") as HTMLElement).textContent = off
            ? "The swapper is switched off (Settings, Customization), none of these files are used."
            : `The game already loaded ${count === 1 ? "1 changed file" : `${count} changed files`}, ${count === 1 ? "it changes" : "they change"} after a page refresh.`;
        this.renderOwn();
        this.renderGame();
    }

    renderOwn(): void{
        if (!this.list) return;
        const tree = this.get("#swOwnTree");
        tree.textContent = "";
        const root = buildTree(this.list.files, this.list.dirs);
        this.get("#swOwnCount").textContent = `${this.list.files.length} file${this.list.files.length === 1 ? "" : "s"}`;
        if (!this.list.files.length && !this.list.dirs.length){
            tree.append(element("div", "treeNote", "Nothing swapped yet. Drop a file onto one of the game files on the right, or drop a whole swapper pack here."));
            return;
        }

        const seen = new Map(this.list.seen.map((path) => [path.toLowerCase(), path]));
        const byName: Map<string, string[]> = new Map();
        for (const path of this.list.seen){
            const name = baseName(path).toLowerCase();
            byName.set(name, [...byName.get(name) ?? [], path]);
        }

        const walk = (folder: TreeFolder, depth: number): void => {
            for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))){
                const collapsed = this.collapsedOwn.has(child.path);
                const row = this.folderRow(child.name, depth, !collapsed, `${countFiles(child)}`);
                row.onclick = (): void => {
                    if (collapsed) this.collapsedOwn.delete(child.path);
                    else this.collapsedOwn.add(child.path);
                    this.renderOwn();
                };
                const actions = row.querySelector(".scriptActions");
                if (hostSupportsEditor()) actions?.append(iconButton("note_add", "New file inside", () => this.newFile(child.path)));
                actions?.append(
                    iconButton("create_new_folder", "New folder inside", () => this.newFolder(child.path)),
                    iconButton("drive_file_rename_outline", "Rename or move", () => this.move(child.path)),
                    iconButton("folder_open", "Open in Explorer", () => this.send("reveal", { path: child.path })),
                    iconButton("delete", "Delete (goes to the recycle bin)", () => this.remove(child.path), "danger"),
                );
                makeDropTarget(row, (files) => this.drop(child.path, files));
                tree.append(row);
                if (!collapsed) walk(child, depth + 1);
            }
            for (const file of [...folder.files].sort((a, b) => a.name.localeCompare(b.name))){
                tree.append(this.ownFileRow(file, depth, seen, byName));
            }
        };
        walk(root, 0);
    }

    folderRow(name: string, depth: number, open: boolean, detail: string): HTMLElement{
        const row = element("div", "node folder");
        row.style.setProperty("--depth", String(depth));
        row.append(element("span", "mi", open ? "expand_more" : "chevron_right"), element("span", "mi kind", open ? "folder_open" : "folder"));
        row.append(element("span", "nodeName", name), element("span", "nodeSize", detail), element("div", "scriptActions"));
        return row;
    }

    ownFileRow(file: { name: string, path: string, size: number }, depth: number, seen: Map<string, string>, byName: Map<string, string[]>): HTMLElement{
        const row = element("div", "node");
        row.style.setProperty("--depth", String(depth + 1));
        row.append(element("span", "mi", "description"), element("span", "nodeName", file.name), element("span", "nodeSize", formatSize(file.size)));

        const used = seen.get(file.path.toLowerCase());
        const elsewhere = (byName.get(file.name.toLowerCase()) ?? []).filter((path) => path.toLowerCase() !== file.path.toLowerCase());
        if (used){
            const state = element("span", "state ok", "Used");
            state.title = `The game loaded krunker.io/${used} this session, this file replaced it.`;
            row.append(state);
        }
        else if (elsewhere.length){
            const [target] = elsewhere;
            const state = element("span", "state warn", "Wrong folder?");
            state.title = `The game asks for this file as ${elsewhere.join(", ")}`;
            const fix = element("div", "btn small", "Move there");
            fix.title = `Move to ${target}`;
            fix.onclick = (): void => this.send("move", { from: file.path, to: target });
            row.append(state, fix);
        }
        else {
            const state = element("span", "state", "Not requested");
            state.title = "The game did not ask for this path in this session. It may still come (another map, a skin), or the path does not match any game file.";
            row.append(state);
        }

        const actions = element("div", "scriptActions");
        if (hostSupportsEditor() && isText(file.path) && file.size <= MAX_EDIT_SIZE){
            actions.append(iconButton("edit", "Edit", () => this.edit(file.path)));
            row.ondblclick = (): void => this.edit(file.path);
        }
        actions.append(
            iconButton("drive_file_rename_outline", "Rename or move", () => this.move(file.path)),
            iconButton("folder_open", "Show in Explorer", () => this.send("reveal", { path: file.path })),
            iconButton("delete", "Delete (goes to the recycle bin)", () => this.remove(file.path), "danger"),
        );
        row.append(actions);
        makeDropTarget(row, (files) => this.drop(dirName(file.path), files));
        return row;
    }

    renderGame(): void{
        if (!this.list || !this.popup) return;
        const tree = this.get("#swGameTree");
        tree.textContent = "";
        const { seen } = this.list;
        this.get("#swGameCount").textContent = `${seen.length} loaded this session`;
        const own = new Set(this.list.files.map((file) => file.path.toLowerCase()));

        if (!seen.length){
            tree.append(element("div", "treeNote", "The game has not loaded any files yet. Play a round or open a menu, then Reload list."));
            return;
        }

        const fileRow = (path: string, depth: number): HTMLElement => {
            const row = element("div", "node");
            row.style.setProperty("--depth", String(depth));
            row.title = `krunker.io/${path}\nDrop a file here to replace it`;
            row.append(element("span", "mi", "insert_drive_file"), element("span", "nodeName", depth ? baseName(path) : path));
            if (own.has(path.toLowerCase())) row.append(element("span", "swapped", "swapped"));
            if (hostSupportsEditor() && isText(path)){
                const swapped = this.list?.files.find((file) => file.path.toLowerCase() === path.toLowerCase());
                const actions = element("div", "scriptActions");
                if (swapped) actions.append(iconButton("edit", "Edit your swap", () => this.edit(swapped.path)));
                else actions.append(iconButton("edit_note", "Edit a copy, saving it swaps the file", () => this.editCopy(path)));
                row.append(actions);
            }
            makeDropTarget(row, (files) => this.replace(path, files));
            return row;
        };

        if (this.search){
            const matches = seen.filter((path) => path.toLowerCase().includes(this.search));
            for (const path of matches.slice(0, MAX_SEARCH_ROWS)) tree.append(fileRow(path, 0));
            if (!matches.length) tree.append(element("div", "treeNote", "No game file matches."));
            if (matches.length > MAX_SEARCH_ROWS) tree.append(element("div", "treeNote", `${matches.length - MAX_SEARCH_ROWS} more, search for something longer.`));
            return;
        }

        const root = buildTree(seen.map((path) => ({ path, size: 0 })), []);
        const walk = (folder: TreeFolder, depth: number): void => {
            for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))){
                const open = this.expandedGame.has(child.path);
                const row = this.folderRow(child.name, depth, open, `${countFiles(child)}`);
                row.title = "Drop files here to put them into this folder";
                row.onclick = (): void => {
                    if (open) this.expandedGame.delete(child.path);
                    else this.expandedGame.add(child.path);
                    this.renderGame();
                };
                makeDropTarget(row, (files) => this.drop(child.path, files));
                tree.append(row);
                if (open) walk(child, depth + 1);
            }
            for (const file of [...folder.files].sort((a, b) => a.name.localeCompare(b.name))) tree.append(fileRow(file.path, depth + 1));
        };
        walk(root, 0);
    }

    async newFile(parent: string): Promise<void>{
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "New file", parent ? `${parent}/new.css` : "css/new.css", "A path inside the swapper folder, the same path the game loads the file from");
        if (!answer) return;
        const path = answer.replace(/^\/+/, "");
        if (this.list?.files.some((file) => file.path.toLowerCase() === path.toLowerCase())){
            this.popup.showError(`${path} already exists, edit it instead.`);
            return;
        }
        this.showEditor(path, "", true);
    }

    edit(path: string): void{
        if (this.pendingRead || this.editing) return;
        this.pendingRead = path;
        this.send("read", { path });
    }

    async editCopy(path: string): Promise<void>{
        if (this.pendingRead || this.editing) return;
        this.pendingRead = path;
        let content = null;
        for (const origin of ["https://krunker.io", "https://assets.krunker.io"]){
            try {
                const response = await fetch(`${origin}/${path}`);
                if (response.ok){
                    content = await response.text();
                    break;
                }
            }
            catch {}
        }
        if (this.pendingRead !== path) return;
        this.pendingRead = null;
        if (content === null){
            this.popup?.showError(`Could not download krunker.io/${path}, starting with an empty file.`);
            content = "";
        }
        this.showEditor(path, content, true);
    }

    showEditor(path: string, content: string, isNew = false): void{
        if (!this.popup) return;
        const holder = this.get("#swEditor");
        this.get(".swapColumns").style.display = "none";
        holder.style.display = "";
        const { editor } = createEditorView(holder, {
            title: path,
            content,
            language: languageFor(path),
            isNew,
            onSave: (closeAfter) => {
                if (!this.editing || this.saving) return;
                this.saving = true;
                this.editing.closeAfterSave = closeAfter;
                this.send("write", { path, content: this.editing.editor.getValue() });
            },
            onClose: () => this.leaveEditor(),
        });
        this.editing = { path, editor, closeAfterSave: false };
    }

    async leaveEditor(): Promise<void>{
        if (!this.editing || !this.popup) return;
        if (this.editing.editor.isDirty()){
            const discard = await askConfirm(this.popup.shadow, "Unsaved changes", "Close the editor and throw the changes away?", "Discard");
            if (!discard) return;
        }
        this.closeEditor();
    }

    closeEditor(): void{
        this.editing = null;
        if (!this.popup) return;
        const holder = this.get("#swEditor");
        holder.textContent = "";
        holder.style.display = "none";
        this.get(".swapColumns").style.display = "";
        this.render();
    }

    canClose(): boolean{
        if (this.forceClose || !this.editing?.editor.isDirty() || !this.popup) return true;
        askConfirm(this.popup.shadow, "Unsaved changes", "Close and throw the changes away?", "Discard").then((discard) => {
            if (!discard) return;
            this.forceClose = true;
            this.popup?.close();
        });
        return false;
    }

    async newFolder(parent: string): Promise<void>{
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "New folder", parent ? `${parent}/` : "textures", "A path inside the swapper folder, for example textures/weapons");
        if (!answer) return;
        this.send("mkdir", { path: answer });
    }

    async move(path: string): Promise<void>{
        if (!this.popup) return;
        const answer = await askText(this.popup.shadow, "Rename or move", path, "The new path inside the swapper folder. Change the folders in front to move it.");
        if (!answer || answer === path) return;
        this.send("move", { from: path, to: answer });
    }

    async remove(path: string): Promise<void>{
        if (!this.popup) return;
        const sure = await askConfirm(this.popup.shadow, `Delete ${baseName(path)}?`, "It goes to the recycle bin, so you can still get it back.", "Delete");
        if (!sure) return;
        this.send("delete", { path });
    }
}

const manager = new SwapperManager();

export const open = (): void => manager.open();
