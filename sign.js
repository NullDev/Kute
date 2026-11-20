import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUBJECT = "Open Source Developer Christopher Binder";
const TIMESTAMP_URL = "http://time.certum.pl";
const DESCRIPTION = "Kute";
const DESCRIPTION_URL = "https://kute.lol";

const releaseDir = path.join(process.cwd(), "target", "release");
const installerPath = path.join(process.cwd(), "target", "kute-setup-x86_64.msi");

/**
 * @return {string}
 */
function findSigntool(){
    if (process.env.SIGNTOOL) return process.env.SIGNTOOL;

    const kitsDir = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
    const versions = fs.existsSync(kitsDir) ? fs.readdirSync(kitsDir).filter((name) => /^\d+(\.\d+)+$/.test(name)) : [];
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const version of versions){
        const candidate = path.join(kitsDir, version, "x64", "signtool.exe");
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error("signtool.exe not found, install the Windows SDK or set SIGNTOOL");
}

/**
 * @param {string} dir
 * @return {string[]}
 */
function binariesIn(dir){
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...binariesIn(entryPath));
        else if (/\.(exe|dll)$/i.test(entry.name)) found.push(entryPath);
    }
    return found;
}

/**
 * @param {string} signtool
 * @param {string} file
 * @return {boolean}
 */
function isSigned(signtool, file){
    return spawnSync(signtool, ["verify", "/pa", "/tw", "/q", file], { stdio: "ignore" }).status === 0;
}

/**
 * @param {string} signtool
 * @param {string[]} files
 */
function sign(signtool, files){
    for (const file of files){
        if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
    }

    const pending = files.filter((file) => !isSigned(signtool, file));
    for (const file of files){
        if (!pending.includes(file)) console.log(`Already signed: ${path.relative(process.cwd(), file)}`);
    }
    if (pending.length === 0) return;

    const jsign = process.env.KUTE_SIGN_JSIGN;
    const pinFile = process.env.KUTE_SIGN_PIN_FILE;

    if (jsign && pinFile){
        if (!fs.existsSync(jsign)) throw new Error(`KUTE_SIGN_JSIGN points at ${jsign}, which does not exist`);
        if (!fs.existsSync(pinFile)) throw new Error(`KUTE_SIGN_PIN_FILE points at ${pinFile}, which does not exist`);

        console.log(`Signing ${pending.length} file(s) with the PIN file`);
        const result = spawnSync("java", [
            "-jar", jsign,
            "--storetype", "CRYPTOCERTUM",
            "--storepass", `file:${pinFile}`,
            "--alias", SUBJECT,
            "--alg", "SHA-256",
            "--tsaurl", TIMESTAMP_URL,
            "--tsmode", "RFC3161",
            "--name", DESCRIPTION,
            "--url", DESCRIPTION_URL,
            ...pending,
        ], { stdio: "inherit" });
        if (result.status !== 0) throw new Error(`jsign exited with ${result.status ?? result.error}`);
    }
    else {
        console.log(`Signing ${pending.length} file(s), enter the card PIN when Windows asks for it`);
        const result = spawnSync(signtool, [
            "sign",
            "/n", SUBJECT,
            "/fd", "sha256",
            "/tr", TIMESTAMP_URL,
            "/td", "sha256",
            "/d", DESCRIPTION,
            "/du", DESCRIPTION_URL,
            ...pending,
        ], { stdio: "inherit" });
        if (result.status !== 0) throw new Error(`signtool exited with ${result.status ?? result.error}`);
    }

    const unsigned = pending.filter((file) => !isSigned(signtool, file));
    if (unsigned.length > 0) throw new Error(`No valid timestamped signature on: ${unsigned.join(", ")}`);

    for (const file of pending) console.log(`Signed: ${path.relative(process.cwd(), file)}`);
}

try {
    if (process.platform !== "win32") throw new Error("signing only runs on Windows");

    const mode = process.argv[2];
    const signtool = findSigntool();

    if (mode === "payload") sign(signtool, [path.join(releaseDir, "kute.exe"), ...binariesIn(path.join(releaseDir, "dist"))]);
    else if (mode === "installer") sign(signtool, [installerPath]);
    else throw new Error("usage: bun sign.js payload|installer");
}
catch (error){
    console.error("cannot sign", error);
    process.exitCode = 1;
}
