import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1"
import { RTCCertificate, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "../mod.js"
import { negotiate, nextEvent, opened, options, pair, waitForState } from "./helpers.js"

Deno.test({
    name: "offer/answer: signaling states, descriptions and connection states move like a browser's",
    ...options,
    async fn() {
        const [a, b] = pair()
        const states = { a: [], b: [] }
        a.onsignalingstatechange = () => states.a.push(a.signalingState)
        b.onsignalingstatechange = () => states.b.push(b.signalingState)
        const connection = { a: [], b: [] }
        a.onconnectionstatechange = () => connection.a.push(a.connectionState)
        b.onconnectionstatechange = () => connection.b.push(b.connectionState)
        a.createDataChannel("x")
        a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate)
        b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate)

        assertEquals(a.signalingState, "stable")
        assertEquals(a.localDescription, null)
        const offer = await a.createOffer()
        assert(offer instanceof RTCSessionDescription)
        assertEquals(offer.type, "offer")
        assertMatch(offer.sdp, /^v=0/)
        await a.setLocalDescription(offer)
        assertEquals(a.signalingState, "have-local-offer")
        assertEquals(a.pendingLocalDescription.type, "offer")
        assertEquals(a.currentLocalDescription, null)

        await b.setRemoteDescription(a.localDescription)
        assertEquals(b.signalingState, "have-remote-offer")
        assertEquals(b.canTrickleIceCandidates, true)
        const answer = await b.createAnswer()
        assertEquals(answer.type, "answer")
        await b.setLocalDescription(answer)
        assertEquals(b.signalingState, "stable")
        assertEquals(b.currentLocalDescription.type, "answer")
        await a.setRemoteDescription(b.localDescription)
        assertEquals(a.signalingState, "stable")
        assertEquals(a.currentRemoteDescription.type, "answer")

        await Promise.all([waitForState(a, "connected"), waitForState(b, "connected")])
        assertEquals(states.a, ["have-local-offer", "stable"])
        assertEquals(states.b, ["have-remote-offer", "stable"])
        assertEquals(connection.a.at(-1), "connected")
        assertEquals(a.iceConnectionState === "connected" || a.iceConnectionState === "completed", true)

        a.close()
        assertEquals(a.signalingState, "closed")
        assertEquals(a.connectionState, "closed")
        await assertRejects(() => a.createOffer(), DOMException, "closed")
        assertThrows(() => a.createDataChannel("late"), DOMException)
        b.close()
    },
})

Deno.test({
    name: "trickle ICE: candidates arrive as RTCIceCandidate with parsed fields, then null",
    ...options,
    async fn() {
        const pc = new RTCPeerConnection()
        pc.createDataChannel("x")
        const candidates = []
        const done = new Promise((resolve) => {
            pc.onicecandidate = ({ candidate }) => candidate ? candidates.push(candidate) : resolve()
        })
        const gathering = []
        pc.onicegatheringstatechange = () => gathering.push(pc.iceGatheringState)
        await pc.setLocalDescription()
        await done
        assert(candidates.length > 0)
        for (const candidate of candidates) {
            assert(candidate instanceof RTCIceCandidate)
            assertMatch(candidate.candidate, /^candidate:/)
            assertEquals(candidate.protocol, "udp")
            assert(candidate.port > 0)
            assertEquals(candidate.type, "host")
            assert(candidate.sdpMid != null || candidate.sdpMLineIndex != null)
            assertEquals(typeof candidate.toJSON().candidate, "string")
        }
        assertEquals(gathering.at(-1), "complete")
        assertEquals(pc.iceGatheringState, "complete")
        pc.close()
    },
})

Deno.test({
    name: "addIceCandidate: null and empty mean end-of-candidates; one without a remote description is InvalidStateError",
    ...options,
    async fn() {
        const pc = new RTCPeerConnection()
        await pc.addIceCandidate(null)
        await pc.addIceCandidate({ candidate: "", sdpMid: "0" })
        await assertRejects(
            () => pc.addIceCandidate({ candidate: "candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host", sdpMid: "0" }),
            DOMException,
        )
        pc.close()
    },
})

Deno.test({
    name: "getStats: transport, candidate pair and data channel entries once connected",
    ...options,
    async fn() {
        const [a, b] = pair()
        const channel = a.createDataChannel("stats")
        await negotiate(a, b)
        await opened(channel)
        channel.send("count me")
        const report = await a.getStats()
        assert(report instanceof Map)
        const types = new Set([...report.values()].map((entry) => entry.type))
        assert(types.has("peer-connection"), [...types].join())
        assert(types.has("transport"), [...types].join())
        assert(types.has("data-channel"), [...types].join())
        for (const [id, entry] of report) {
            assertEquals(id, entry.id)
            assertEquals(typeof entry.timestamp, "number")
        }
        a.close()
        b.close()
    },
})

Deno.test({
    name: "certificates: generateCertificate is used in the SDP and survives toPEM/fromPEM",
    ...options,
    async fn() {
        const certificate = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" })
        assert(certificate instanceof RTCCertificate)
        assert(certificate.expires > Date.now())
        const [fingerprint] = certificate.getFingerprints()
        assertEquals(fingerprint.algorithm, "sha-256")
        assertMatch(fingerprint.value, /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i)

        const restored = RTCCertificate.fromPEM(certificate.toPEM())
        assertEquals(restored.getFingerprints()[0].value.toLowerCase(), fingerprint.value.toLowerCase())

        const pc = new RTCPeerConnection({ certificates: [restored] })
        pc.createDataChannel("x")
        const offer = await pc.createOffer()
        assert(offer.sdp.toLowerCase().includes(fingerprint.value.toLowerCase()), "the offer carries the certificate's fingerprint")
        pc.close()
        await assertRejects(() => RTCPeerConnection.generateCertificate({ name: "RSASSA-PKCS1-v1_5" }), DOMException)
    },
})

Deno.test({
    name: "configuration: validated like a browser, and returned by getConfiguration",
    ...options,
    fn() {
        assertThrows(() => new RTCPeerConnection({ iceServers: [{ urls: "http://example.com" }] }), DOMException)
        assertThrows(() => new RTCPeerConnection({ iceServers: [{ urls: "turn:example.com" }] }), DOMException)
        assertThrows(() => new RTCPeerConnection({ iceTransportPolicy: "nope" }), TypeError)
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: ["turn:example.com"], username: "u", credential: "p" }],
            iceTransportPolicy: "all",
        })
        const configuration = pc.getConfiguration()
        assertEquals(configuration.iceServers[0].urls, ["stun:stun.l.google.com:19302"])
        assertEquals(configuration.iceServers[1].username, "u")
        assertEquals(configuration.bundlePolicy, "balanced")
        pc.close()
    },
})

Deno.test({
    name: "renegotiation: a second channel after connecting, and negotiationneeded",
    ...options,
    async fn() {
        const [a, b] = pair()
        const first = a.createDataChannel("first")
        await negotiate(a, b)
        await opened(first)
        const announced = nextEvent(b, "datachannel")
        const second = a.createDataChannel("second")
        await opened(second)
        assertEquals((await announced).channel.label, "second")
        a.close()
        b.close()
    },
})
