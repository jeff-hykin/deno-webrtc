// Writes the release version and the sha256 of each built library into the module.
// usage: deno run --allow-read --allow-write scripts/stamp_release.js <version> <dist dir>

const [version, dist] = Deno.args
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "") || !dist) {
    console.error("usage: stamp_release.js <version> <dist dir>")
    Deno.exit(1)
}

async function sha256(path) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(path)))
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const checksums = {}
for await (const entry of Deno.readDir(dist)) {
    if (entry.isFile && /deno_webrtc-.*\.(so|dylib|dll)$/.test(entry.name)) {
        checksums[entry.name] = await sha256(`${dist}/${entry.name}`)
    }
}
const expected = ["linux-x86_64", "linux-aarch64", "darwin-x86_64", "darwin-aarch64", "windows-x86_64"]
for (const platform of expected) {
    if (!Object.keys(checksums).some((name) => name.includes(platform))) {
        console.error(`missing the ${platform} library in ${dist}`)
        Deno.exit(1)
    }
}
const sorted = Object.fromEntries(Object.entries(checksums).sort())

Deno.writeTextFileSync(
    "js/binary_checksums.js",
    `// sha256 of each release binary, written by the release workflow\nexport const CHECKSUMS = ${JSON.stringify(sorted, null, 4)}\n`,
)
Deno.writeTextFileSync("js/version.js", `// the release this module downloads its native library from\nexport const VERSION = "${version}"\n`)

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"))
denoJson.version = version
Deno.writeTextFileSync("deno.json", JSON.stringify(denoJson, null, 4) + "\n")

const cargoToml = Deno.readTextFileSync("Cargo.toml")
Deno.writeTextFileSync("Cargo.toml", cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`))
const cargoLock = Deno.readTextFileSync("Cargo.lock")
Deno.writeTextFileSync(
    "Cargo.lock",
    cargoLock.replace(/(name = "deno_webrtc"\nversion = )".*"/, `$1"${version}"`),
)
console.log(sorted)
