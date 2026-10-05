// The README's server example, driven by headless Chrome.
import { assertEquals } from "jsr:@std/assert@1"
import { launch } from "jsr:@astral/astral@0.5.6"
import { serve } from "../examples/http_server.js"
import { options } from "./helpers.js"

Deno.test({
    name: "example: a browser connects to examples/http_server.js and gets an echo",
    ignore: Deno.env.get("DENO_WEBRTC_SKIP_CHROME") === "1",
    ...options,
    async fn() {
        const server = serve(8765)
        const browser = await launch({ headless: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--no-sandbox"] })
        try {
            const page = await browser.newPage("http://localhost:8765/")
            const reply = await page.evaluate(`(async () => {
                for (let i = 0; i < 300 && !window.reply; i++) { await new Promise((r) => setTimeout(r, 50)) }
                return window.reply ?? null
            })()`)
            assertEquals(reply, "echo: hi")
        } finally {
            await browser.close()
            await server.shutdown()
        }
    },
})
