// A browser connects to this server over WebRTC; one HTTP POST carries the offer and the answer.
// deno run -A examples/http_server.js, then open http://localhost:8000
import { RTCPeerConnection } from "../mod.js"

const PAGE = `<!doctype html><body><script type="module">
    const pc = new RTCPeerConnection()
    const channel = pc.createDataChannel("chat")
    channel.onopen = () => channel.send("hi")
    channel.onmessage = ({ data }) => {
        document.body.append(data)
        window.reply = data
    }
    await pc.setLocalDescription()
    const answer = await fetch("/", { method: "POST", body: JSON.stringify(pc.localDescription) })
    await pc.setRemoteDescription(await answer.json())
</script></body>`

function gatheringComplete(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") {
            return resolve()
        }
        pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve())
    })
}

export function serve(port = 8000) {
    return Deno.serve({ port, onListen() {} }, async (request) => {
        if (request.method !== "POST") {
            return new Response(PAGE, { headers: { "content-type": "text/html" } })
        }
        // non-standard second argument: keep UDP inside a range a firewall can open
        const pc = new RTCPeerConnection({}, { portRange: { min: 50000, max: 50100 } })
        pc.ondatachannel = ({ channel }) => {
            channel.onmessage = ({ data }) => channel.send(`echo: ${data}`)
        }
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                pc.close()
            }
        }
        await pc.setRemoteDescription(await request.json())
        await pc.setLocalDescription()
        // every candidate goes in the answer, so no more signaling is needed
        await gatheringComplete(pc)
        return Response.json(pc.localDescription)
    })
}

if (import.meta.main) {
    serve()
    console.log("open http://localhost:8000")
}
