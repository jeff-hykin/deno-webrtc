// Interop with a real browser: headless Chrome on one end, deno-webrtc on the other.
// Skipped when DENO_WEBRTC_SKIP_CHROME=1 (e.g. a platform CI doesn't run it on).

import { assertEquals } from "jsr:@std/assert@1"
import { launch } from "jsr:@astral/astral@0.5.6"
import { RTCPeerConnection } from "../mod.js"
import { nextEvent, opened, options, within } from "./helpers.js"

const skip = Deno.env.get("DENO_WEBRTC_SKIP_CHROME") === "1"

async function withChrome(body) {
    const browser = await launch({
        headless: true,
        // real host addresses instead of .local names, so the test does not depend on multicast DNS
        args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--no-sandbox"],
    })
    try {
        const page = await browser.newPage("about:blank")
        await body(page)
    } finally {
        await browser.close()
    }
}

/** Waits for the Deno connection to finish gathering, then returns its full (non-trickle) description. */
async function completeDescription(pc) {
    if (pc.iceGatheringState !== "complete") {
        await within(new Promise((resolve) => {
            pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve())
        }), 10000, "ICE gathering")
    }
    return pc.localDescription.toJSON()
}

// runs in Chrome: resolves once its ICE gathering is complete
const CHROME_GATHERED = `new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve() }
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve())
})`

Deno.test({
    name: "chrome interop: Chrome offers, Deno answers, messages flow both ways",
    ignore: skip,
    ...options,
    async fn() {
        await withChrome(async (page) => {
            const offer = await page.evaluate(`(async () => {
                window.pc = new RTCPeerConnection()
                window.received = []
                window.dc = pc.createDataChannel("from-chrome", { ordered: true })
                dc.onmessage = ({ data }) => received.push(typeof data === "string" ? data : "binary:" + new Uint8Array(data).join(","))
                dc.binaryType = "arraybuffer"
                await pc.setLocalDescription()
                await ${CHROME_GATHERED}
                return pc.localDescription.toJSON()
            })()`)
            const pc = new RTCPeerConnection()
            const channelEvent = nextEvent(pc, "datachannel", 20000)
            // listening from the moment the channel exists: Chrome sends as soon as it opens
            const firstMessage = channelEvent.then(({ channel }) => nextEvent(channel, "message", 20000))
            await pc.setRemoteDescription(offer)
            await pc.setLocalDescription()
            const answer = await completeDescription(pc)
            await page.evaluate(`(async (answer) => {
                await pc.setRemoteDescription(answer)
                if (dc.readyState !== "open") { await new Promise((resolve) => dc.onopen = resolve) }
                dc.send("hello deno")
            })(${JSON.stringify(answer)})`)

            const channel = (await channelEvent).channel
            assertEquals(channel.label, "from-chrome")
            await opened(channel)
            const fromChrome = await firstMessage
            assertEquals(fromChrome.data, "hello deno")
            channel.send("hello chrome")
            channel.send(new Uint8Array([1, 2, 3]))
            const received = await page.evaluate(`(async () => {
                for (let i = 0; i < 200 && received.length < 2; i++) { await new Promise((r) => setTimeout(r, 50)) }
                return received
            })()`)
            assertEquals(received, ["hello chrome", "binary:1,2,3"])
            assertEquals(pc.connectionState, "connected")
            pc.close()
        })
    },
})

Deno.test({
    name: "chrome interop: Deno offers, Chrome answers, messages flow both ways",
    ignore: skip,
    ...options,
    async fn() {
        await withChrome(async (page) => {
            const pc = new RTCPeerConnection()
            const channel = pc.createDataChannel("from-deno")
            await pc.setLocalDescription()
            const offer = await completeDescription(pc)
            const answer = await page.evaluate(`(async (offer) => {
                window.pc = new RTCPeerConnection()
                window.received = []
                window.channelReady = new Promise((resolve) => {
                    pc.ondatachannel = ({ channel }) => {
                        window.dc = channel
                        channel.onmessage = ({ data }) => received.push(data)
                        resolve(channel.label)
                    }
                })
                await pc.setRemoteDescription(offer)
                await pc.setLocalDescription()
                await ${CHROME_GATHERED}
                return pc.localDescription.toJSON()
            })(${JSON.stringify(offer)})`)
            await pc.setRemoteDescription(answer)
            await opened(channel, 20000)
            const reply = nextEvent(channel, "message", 20000)
            channel.send("from deno")
            const label = await page.evaluate(`(async () => {
                const label = await channelReady
                if (dc.readyState !== "open") { await new Promise((resolve) => dc.onopen = resolve) }
                for (let i = 0; i < 200 && received.length < 1; i++) { await new Promise((r) => setTimeout(r, 50)) }
                dc.send("from chrome")
                return label
            })()`)
            assertEquals(label, "from-deno")
            assertEquals((await reply).data, "from chrome")
            assertEquals(await page.evaluate("received"), ["from deno"])
            pc.close()
        })
    },
})
