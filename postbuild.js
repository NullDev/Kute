import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const buildType = args[0];

const DISTRIBUTION_SEARCH_DEPTH = 6;

const targetDir = path.join(process.cwd(), "target", buildType);
const targetResourcesDir = path.join(targetDir, "resources");
const distDir = path.join(targetDir, "dist");

const linux = process.platform === "linux";

const windowsRuntimeFiles = [
    "libcef.dll",
    "chrome_elf.dll",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vk_swiftshader.dll",
    "vk_swiftshader_icd.json",
    "vulkan-1.dll",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
];

const linuxRuntimeFiles = [
    "libcef.so",
    "libEGL.so",
    "libGLESv2.so",
    "libvk_swiftshader.so",
    "libvulkan.so.1",
    "vk_swiftshader_icd.json",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
];

const cefRuntimeFiles = linux ? linuxRuntimeFiles : windowsRuntimeFiles;
const vcRuntimeFiles = linux ? [] : ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
const hostFiles = linux ? [] : ["render.dll"];

/**
 * @param {string} source
 * @param {string} destination
 * @return {boolean}
 */
function copyIfExists(source, destination){
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
}

/**
 * @param {string} source
 * @param {string} destination
 */
function copyDirAll(source, destination){
    fs.mkdirSync(destination, { recursive: true });

    for (const entry of fs.readdirSync(source, { withFileTypes: true })){
        const sourcePath = path.join(source, entry.name);
        const destPath = path.join(destination, entry.name);

        if (entry.isDirectory()) copyDirAll(sourcePath, destPath);
        else fs.copyFileSync(sourcePath, destPath);
    }
}

/**
 * CEF distribution matching the cef-dll-sys version in Cargo.lock, fallback source for the runtime
 *
 * @return {string|null}
 */
function findCefDistribution(){
    const lock = fs.readFileSync(path.join(process.cwd(), "Cargo.lock"), "utf8");
    const cefVersion = /name = "cef-dll-sys"\r?\nversion = "[^"+]+\+([^"]+)"/.exec(lock)?.[1];
    const buildDir = path.join(targetDir, "build");
    if (!cefVersion || !fs.existsSync(buildDir)) return null;

    const platformDir = linux ? "cef_linux_x86_64" : "cef_windows_x86_64";
    /** @type {{ dir: string, time: number }[]} */
    const matches = [];

    /**
     * @param {string} dir
     * @param {number} depth
     */
    const search = (dir, depth) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
            if (!entry.isDirectory()) continue;
            const entryPath = path.join(dir, entry.name);
            if (entry.name !== platformDir){
                if (depth < DISTRIBUTION_SEARCH_DEPTH) search(entryPath, depth + 1);
                continue;
            }
            const archive = path.join(entryPath, "archive.json");
            if (!fs.existsSync(archive)) continue;
            if (!String(JSON.parse(fs.readFileSync(archive, "utf8")).name).startsWith(`cef_binary_${cefVersion}+`)) continue;
            matches.push({ dir: entryPath, time: fs.statSync(archive).mtimeMs });
        }
    };
    search(buildDir, 1);

    return matches.sort((a, b) => b.time - a.time)[0]?.dir ?? null;
}

try {
    fs.mkdirSync(targetResourcesDir, { recursive: true });

    const cefDistribution = findCefDistribution();
    if (cefDistribution){
        for (const file of cefRuntimeFiles){
            const destination = path.join(targetDir, file);
            if (!fs.existsSync(destination)) copyIfExists(path.join(cefDistribution, file), destination);
        }
        const locales = path.join(targetDir, "locales");
        if (!fs.existsSync(locales)) copyDirAll(path.join(cefDistribution, "locales"), locales);
    }
    else console.warn("No CEF distribution for the cef-dll-sys version in Cargo.lock found in the build dir.");

    for (const file of vcRuntimeFiles){
        const destination = path.join(targetDir, file);
        if (!fs.existsSync(destination)) copyIfExists(path.join(process.cwd(), "resources", "vcredist", file), destination);
    }

    copyIfExists(path.join(process.cwd(), "target", "bundle_version"), path.join(targetResourcesDir, "bundle_version"));
    copyIfExists(path.join(process.cwd(), "target", "bundle.js"), path.join(targetResourcesDir, "bundle.js"));

    if (!linux && !copyIfExists(path.join(targetDir, "obs_kute_capture.dll"), path.join(targetResourcesDir, "obs-kute-capture.dll"))){
        console.warn("OBS plugin was not built; skipping bundled plugin copy.");
    }

    const patchedCefDir = path.join(process.cwd(), "resources", linux ? "cef-linux" : "cef");
    if (fs.existsSync(patchedCefDir)){
        for (const file of fs.readdirSync(patchedCefDir)){
            const source = path.join(patchedCefDir, file);
            if (fs.statSync(source).size < 1024){
                console.warn(`${file} in resources/cef is a git lfs pointer, run "git lfs pull". Keeping the stock file.`);
                continue;
            }
            fs.copyFileSync(source, path.join(targetDir, file));
        }
    }

    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });
    const missing = [...cefRuntimeFiles, ...vcRuntimeFiles, ...hostFiles].filter(
        (file) => !copyIfExists(path.join(targetDir, file), path.join(distDir, file)),
    );
    if (fs.existsSync(path.join(targetDir, "locales"))) copyDirAll(path.join(targetDir, "locales"), path.join(distDir, "locales"));
    else missing.push("locales/");
    copyDirAll(targetResourcesDir, path.join(distDir, "resources"));

    if (missing.length > 0){
        console.error(`Missing from ${targetDir}: ${missing.join(", ")}`);
        process.exitCode = 1;
    }
}
catch (error){
    console.error("cannot copy", error);
    process.exitCode = 1;
}
