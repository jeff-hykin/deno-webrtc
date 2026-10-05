// Finds (or downloads and verifies) the native library for this OS/arch.

import { VERSION } from "./version.js"
import { CHECKSUMS } from "./binary_checksums.js"

const REPOSITORY = "jeff-hykin/deno-webrtc"

/** @returns {string} e.g. "darwin-aarch64" */
export function platformName() {
    return `${Deno.build.os}-${Deno.build.arch}`
}

/** @param {string} platform */
export function binaryName(platform = platformName()) {
    const [os] = platform.split("-")
    if (os === "windows") {
        return `deno_webrtc-${platform}.dll`
    }
    return `libdeno_webrtc-${platform}.${os === "darwin" ? "dylib" : "so"}`
}

function env(name) {
    try {
        return Deno.env.get(name)
    } catch {
        return undefined
    }
}

function cacheDirectory() {
    const custom = env("DENO_WEBRTC_CACHE")
    if (custom) {
        return custom
    }
    const home = env("HOME") ?? env("USERPROFILE") ?? "."
    if (Deno.build.os === "darwin") {
        return `${home}/Library/Caches/deno-webrtc`
    }
    if (Deno.build.os === "windows") {
        return `${env("LOCALAPPDATA") ?? home}/deno-webrtc`
    }
    return `${env("XDG_CACHE_HOME") ?? `${home}/.cache`}/deno-webrtc`
}

async function sha256(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function exists(path) {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

/**
 * The path of the native library: `DENO_WEBRTC_LIB` if set, else the cached download for this
 * version (fetched from the GitHub release and checked against its sha256 on first use).
 * @returns {Promise<string>}
 */
export async function libraryPath() {
    const override = env("DENO_WEBRTC_LIB")
    if (override) {
        return override
    }
    // a checkout of this repository: use what `cargo build` made
    if (import.meta.url.startsWith("file:")) {
        const local = { darwin: "libdeno_webrtc.dylib", windows: "deno_webrtc.dll" }[Deno.build.os] ?? "libdeno_webrtc.so"
        for (const profile of ["release", "debug"]) {
            const path = new URL(`../target/${profile}/${local}`, import.meta.url)
            if (exists(path)) {
                return path.pathname.replace(/^\/([A-Za-z]:)/, "$1")
            }
        }
    }
    const name = binaryName()
    const expected = CHECKSUMS[name]
    if (!expected) {
        throw new Error(`deno-webrtc ${VERSION} has no prebuilt library for ${platformName()} (set DENO_WEBRTC_LIB to one you built with \`cargo build --release\`)`)
    }
    const directory = `${cacheDirectory()}/${VERSION}`
    const path = `${directory}/${name}`
    if (exists(path) && (await sha256(Deno.readFileSync(path))) === expected) {
        return path
    }
    const url = `https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${name}`
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`deno-webrtc: downloading ${url} failed: ${response.status} ${response.statusText}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const actual = await sha256(bytes)
    if (actual !== expected) {
        throw new Error(`deno-webrtc: ${url} has sha256 ${actual}, expected ${expected}; refusing to load it`)
    }
    Deno.mkdirSync(directory, { recursive: true })
    // write then rename, so a concurrent process never loads a half-written file
    const temporary = `${path}.${crypto.randomUUID()}.partial`
    Deno.writeFileSync(temporary, bytes)
    Deno.renameSync(temporary, path)
    return path
}
