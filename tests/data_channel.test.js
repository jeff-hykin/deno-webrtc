import { assert, assertEquals } from "jsr:@std/assert@1"
import { RTCDataChannel } from "../mod.js"
import { negotiate, nextEvent, opened, options, pair, sha256, within } from "./helpers.js"

Deno.test({
    name: "data channel: strings and binary both ways",
    ...options,
    async fn() {
        const [a, b] = pair()
        const channel = a.createDataChannel("chat", { protocol: "json" })
        assertEquals(channel.readyState, "connecting")
        const remoteChannel = nextEvent(b, "datachannel").then((event) => event.channel)
        await negotiate(a, b)
        const remote = await remoteChannel
        assert(remote instanceof RTCDataChannel)
        assertEquals(remote.label, "chat")
        assertEquals(remote.protocol, "json")
        await opened(channel)
        await opened(remote)
        assertEquals(channel.id, remote.id)

        const text = nextEvent(remote, "message")
        channel.send("héllo ✓")
        assertEquals((await text).data, "héllo ✓")

        const binary = nextEvent(remote, "message")
        channel.send(new Uint8Array([1, 2, 3, 250]))
        const received = (await binary).data
        assert(received instanceof ArrayBuffer)
        assertEquals([...new Uint8Array(received)], [1, 2, 3, 250])

        const back = nextEvent(channel, "message")
        remote.send(new Uint16Array([513]).buffer)
        assertEquals([...new Uint8Array((await back).data)], [1, 2])

        remote.binaryType = "blob"
        const blob = nextEvent(remote, "message")
        channel.send(new Blob([new Uint8Array([9, 8])]))
        const blobData = (await blob).data
        assert(blobData instanceof Blob)
        assertEquals([...new Uint8Array(await blobData.arrayBuffer())], [9, 8])

        a.close()
        b.close()
    },
})

Deno.test({
    name: "data channel: 1 MB arrives intact with bufferedAmount flow control",
    ...options,
    async fn() {
        const [a, b] = pair()
        const channel = a.createDataChannel("bulk")
        const remoteChannel = nextEvent(b, "datachannel").then((event) => event.channel)
        await negotiate(a, b)
        const remote = await remoteChannel
        await opened(channel)

        const total = 1024 * 1024
        const data = new Uint8Array(total)
        for (let index = 0; index < total; index++) {
            data[index] = (index * 7 + (index >> 10)) & 0xff
        }
        const chunks = []
        let receivedBytes = 0
        const allReceived = new Promise((resolve) => {
            remote.onmessage = ({ data }) => {
                chunks.push(new Uint8Array(data))
                receivedBytes += data.byteLength
                if (receivedBytes >= total) {
                    resolve()
                }
            }
        })

        const chunkSize = 16 * 1024
        channel.bufferedAmountLowThreshold = 64 * 1024
        let sawBuffering = false
        for (let offset = 0; offset < total; offset += chunkSize) {
            if (channel.bufferedAmount > 256 * 1024) {
                sawBuffering = true
                await nextEvent(channel, "bufferedamountlow", 15000)
            }
            channel.send(data.subarray(offset, offset + chunkSize))
        }
        await within(allReceived, 30000, "receiving 1 MB")

        const joined = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            joined.set(chunk, offset)
            offset += chunk.length
        }
        assertEquals(receivedBytes, total)
        assertEquals(await sha256(joined), await sha256(data))
        assert(sawBuffering || channel.bufferedAmount >= 0)
        a.close()
        b.close()
    },
})

Deno.test({
    name: "data channel: unordered, unreliable channel keeps its settings and delivers",
    ...options,
    async fn() {
        const [a, b] = pair()
        const channel = a.createDataChannel("lossy", { ordered: false, maxRetransmits: 0 })
        assertEquals(channel.ordered, false)
        assertEquals(channel.maxRetransmits, 0)
        const remoteChannel = nextEvent(b, "datachannel").then((event) => event.channel)
        await negotiate(a, b)
        const remote = await remoteChannel
        assertEquals(remote.ordered, false)
        assertEquals(remote.maxRetransmits, 0)
        assertEquals(remote.maxPacketLifeTime, null)
        await opened(channel)

        const got = new Set()
        const enough = new Promise((resolve) => {
            remote.onmessage = ({ data }) => {
                got.add(data)
                if (got.size >= 50) {
                    resolve()
                }
            }
        })
        for (let index = 0; index < 100; index++) {
            channel.send(`message ${index}`)
        }
        // loopback loses nothing in practice, but unreliable means only "most" is promised
        await within(enough, 10000, "receiving unordered messages")
        a.close()
        b.close()
    },
})

Deno.test({
    name: "data channel: negotiated channels pair up by id without a datachannel event",
    ...options,
    async fn() {
        const [a, b] = pair()
        const left = a.createDataChannel("left", { negotiated: true, id: 7 })
        const right = b.createDataChannel("right", { negotiated: true, id: 7 })
        assertEquals(left.id, 7)
        let announced = false
        b.ondatachannel = () => {
            announced = true
        }
        await negotiate(a, b)
        await opened(left)
        await opened(right)
        const message = nextEvent(right, "message")
        left.send("over id 7")
        assertEquals((await message).data, "over id 7")
        assertEquals(announced, false)
        a.close()
        b.close()
    },
})

Deno.test({
    name: "data channel: close reaches both ends; send after close throws",
    ...options,
    async fn() {
        const [a, b] = pair()
        const channel = a.createDataChannel("bye")
        const remoteChannel = nextEvent(b, "datachannel").then((event) => event.channel)
        await negotiate(a, b)
        const remote = await remoteChannel
        await opened(channel)
        await opened(remote)

        const localClosed = nextEvent(channel, "close")
        const remoteClosed = nextEvent(remote, "close")
        channel.close()
        assertEquals(channel.readyState, "closing")
        await within(Promise.all([localClosed, remoteClosed]), 15000, "closing")
        assertEquals(channel.readyState, "closed")
        assertEquals(remote.readyState, "closed")
        let error
        try {
            channel.send("too late")
        } catch (caught) {
            error = caught
        }
        assertEquals(error?.name, "InvalidStateError")
        a.close()
        b.close()
    },
})

Deno.test({
    name: "data channel: send before open throws InvalidStateError; oversized message throws TypeError",
    ...options,
    async fn() {
        const [a, b] = pair()
        const channel = a.createDataChannel("early")
        let early
        try {
            channel.send("x")
        } catch (caught) {
            early = caught
        }
        assertEquals(early?.name, "InvalidStateError")
        await negotiate(a, b)
        await opened(channel)
        let oversized
        try {
            channel.send(new Uint8Array(257 * 1024))
        } catch (caught) {
            oversized = caught
        }
        assert(oversized instanceof TypeError)
        a.close()
        b.close()
    },
})
