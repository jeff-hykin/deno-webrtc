import { assert, assertEquals } from "jsr:@std/assert@1"
import { RTCPeerConnection, UdpMux } from "../mod.js"
import { negotiate, nextEvent, opened, options } from "./helpers.js"

function candidatePorts(sdp) {
    return [...sdp.matchAll(/^a=candidate:\S+ \d \S+ \d+ \S+ (\d+) typ/gm)].map((match) => Number(match[1]))
}

async function gathered(pc) {
    pc.createDataChannel("x")
    const done = new Promise((resolve) => {
        pc.addEventListener("icecandidate", ({ candidate }) => candidate || resolve())
    })
    await pc.setLocalDescription()
    await done
    return pc.localDescription.sdp
}

Deno.test({
    name: "server: portRange keeps every connection's UDP port inside the range",
    ...options,
    async fn() {
        const portRange = { min: 41000, max: 41010 }
        const first = new RTCPeerConnection({}, { portRange })
        const second = new RTCPeerConnection({}, { portRange })
        const ports = [...candidatePorts(await gathered(first)), ...candidatePorts(await gathered(second))]
        assert(ports.length >= 2)
        for (const port of ports) {
            assert(port >= portRange.min && port <= portRange.max, `port ${port}`)
        }
        assertEquals(new Set(candidatePorts(first.localDescription.sdp)).size, 1)
        assert(candidatePorts(first.localDescription.sdp)[0] !== candidatePorts(second.localDescription.sdp)[0])
        first.close()
        second.close()
    },
})

Deno.test({
    name: "server: nat1to1Ips advertises the public address instead of the private one",
    ...options,
    async fn() {
        const pc = new RTCPeerConnection({}, { nat1to1Ips: ["203.0.113.7"] })
        const sdp = await gathered(pc)
        const addresses = [...sdp.matchAll(/^a=candidate:\S+ \d \S+ \d+ (\S+) \d+ typ host/gm)].map((match) => match[1])
        assert(addresses.length > 0)
        assert(addresses.every((address) => address === "203.0.113.7"), addresses.join())
        pc.close()
    },
})

Deno.test({
    name: "server: UdpMux serves several connections on one UDP port",
    ...options,
    async fn() {
        const udpMux = new UdpMux({ includeLoopback: true })
        assert(udpMux.port > 0)
        const servers = [new RTCPeerConnection({}, { udpMux }), new RTCPeerConnection({}, { udpMux })]
        const clients = [new RTCPeerConnection(), new RTCPeerConnection()]
        const channels = []
        for (let index = 0; index < 2; index++) {
            const [server, client] = [servers[index], clients[index]]
            const channel = client.createDataChannel(`client ${index}`)
            const remote = nextEvent(server, "datachannel").then((event) => event.channel)
            await negotiate(client, server)
            for (const port of candidatePorts(server.localDescription.sdp)) {
                assertEquals(port, udpMux.port)
            }
            channels.push({ channel, remote: await remote })
        }
        for (const [index, { channel, remote }] of channels.entries()) {
            await opened(channel)
            const message = nextEvent(remote, "message")
            channel.send(`hello ${index}`)
            assertEquals((await message).data, `hello ${index}`)
            assertEquals(remote.label, `client ${index}`)
        }
        for (const pc of [...servers, ...clients]) {
            pc.close()
        }
        udpMux.close()
    },
})

Deno.test({
    name: "server: iceLite answers a full-ICE peer",
    ...options,
    async fn() {
        const server = new RTCPeerConnection({}, { iceLite: true })
        const client = new RTCPeerConnection()
        const channel = client.createDataChannel("lite")
        const remote = nextEvent(server, "datachannel").then((event) => event.channel)
        await negotiate(client, server)
        assert(server.localDescription.sdp.includes("a=ice-lite"))
        await opened(channel)
        const message = nextEvent(await remote, "message")
        channel.send("lite works")
        assertEquals((await message).data, "lite works")
        client.close()
        server.close()
    },
})
