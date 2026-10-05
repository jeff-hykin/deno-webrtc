import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1"
import { MediaStream, MediaStreamTrack, RTCRtpReceiver, RtpTrack } from "../mod.js"
import { negotiate, nextEvent, options, pair, within } from "./helpers.js"

/** A minimal RTP packet: version 2, the given payload type, sequence number and timestamp. */
function rtpPacket(sequence, timestamp, payload) {
    const packet = new Uint8Array(12 + payload.length)
    const view = new DataView(packet.buffer)
    packet[0] = 0x80
    packet[1] = 96 | 0x80
    view.setUint16(2, sequence)
    view.setUint32(4, timestamp)
    view.setUint32(8, 0x1234)
    packet.set(payload, 12)
    return packet
}

function payloadOf(packet) {
    const csrcs = packet[0] & 0x0f
    let offset = 12 + csrcs * 4
    if (packet[0] & 0x10) {
        const words = new DataView(packet.buffer, packet.byteOffset).getUint16(offset + 2)
        offset += 4 + words * 4
    }
    return packet.subarray(offset)
}

Deno.test({
    name: "RTP: packets written on an RtpTrack arrive as rtp events on the other side's track",
    ...options,
    async fn() {
        const [a, b] = pair()
        const track = new RtpTrack({ kind: "video", mimeType: "video/VP8" })
        assert(track instanceof MediaStreamTrack)
        assertEquals(track.kind, "video")
        const stream = new MediaStream([track])
        const sender = a.addTrack(track, stream)
        assertEquals(sender.track, track)
        assertEquals(a.getSenders().length, 1)

        const trackEvent = nextEvent(b, "track")
        await negotiate(a, b)
        const event = await trackEvent
        assert(event.receiver instanceof RTCRtpReceiver)
        assertEquals(event.track.kind, "video")
        assertEquals(event.streams.length, 1)
        assertEquals(event.streams[0].id, stream.id)
        assertEquals(event.transceiver.receiver, event.receiver)
        assertEquals(b.getReceivers().length, 1)

        const markers = new Set()
        const received = new Promise((resolve) => {
            event.track.addEventListener("rtp", ({ data }) => {
                assert(data instanceof Uint8Array)
                const payload = payloadOf(data)
                // VP8 payload descriptor byte, then our marker
                if (payload.length >= 2 && payload[0] === 0x10) {
                    markers.add(payload[1])
                }
                if (markers.size >= 10) {
                    resolve()
                }
            })
        })
        // the first writes can land before DTLS/SRTP is up; keep sending until 10 distinct ones arrive
        let sequence = 1
        const writer = setInterval(() => {
            for (let marker = 0; marker < 20; marker++) {
                track.writeRtp(rtpPacket(sequence++, sequence * 3000, new Uint8Array([0x10, marker, 0x9d, 0x01, 0x2a])))
            }
        }, 50)
        try {
            await within(received, 15000, "receiving RTP")
        } finally {
            clearInterval(writer)
        }
        assertEquals(event.track.muted, false)
        a.close()
        b.close()
    },
})

Deno.test({
    name: "RTP: writeSample packetizes encoded frames (Opus) that the other side receives",
    ...options,
    async fn() {
        const [a, b] = pair()
        const track = new RtpTrack({ kind: "audio", mimeType: "audio/opus" })
        const transceiver = a.addTransceiver(track, { direction: "sendonly" })
        assertEquals(transceiver.direction, "sendonly")
        const trackEvent = nextEvent(b, "track")
        await negotiate(a, b)
        const remote = (await trackEvent).track
        assertEquals(remote.kind, "audio")
        assertEquals(transceiver.currentDirection, "sendonly")

        let packets = 0
        const received = new Promise((resolve) => {
            remote.onrtp = ({ data }) => {
                if (payloadOf(data)[0] === 0xfc) {
                    packets++
                }
                if (packets >= 5) {
                    resolve()
                }
            }
        })
        const writer = setInterval(() => track.writeSample(new Uint8Array([0xfc, 0xff, 0xfe, 1, 2, 3]), { duration: 20 }), 20)
        try {
            await within(received, 15000, "receiving Opus samples")
        } finally {
            clearInterval(writer)
        }
        a.close()
        b.close()
    },
})

Deno.test({
    name: "media: only RtpTrack can be sent, and recvonly transceivers negotiate",
    ...options,
    async fn() {
        const [a, b] = pair()
        assertThrows(() => a.addTrack({ kind: "video" }), TypeError)
        assertThrows(() => new RtpTrack({ kind: "video" }), TypeError)
        const transceiver = a.addTransceiver("video", { direction: "recvonly" })
        await negotiate(a, b)
        assertEquals(transceiver.mid, "0")
        assertEquals(transceiver.currentDirection, "recvonly")
        assertEquals(b.getTransceivers().length, 1)
        assertEquals(RTCRtpReceiver.getCapabilities("video").codecs.some((codec) => codec.mimeType === "video/H264"), true)
        a.close()
        b.close()
    },
})
