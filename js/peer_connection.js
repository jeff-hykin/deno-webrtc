// RTCPeerConnection

import { call, context, register, release, request, retain, unregister } from "./ffi.js"
import {
    RTCDataChannelEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCPeerConnectionIceEvent,
    RTCTrackEvent,
    defineEventHandlers,
} from "./events.js"
import { RTCCertificate, RTCIceCandidate, RTCSessionDescription, RTCStatsReport } from "./dictionaries.js"
import { RTCDataChannel } from "./data_channel.js"
import { MediaStream, RTCRtpSender, RTCRtpTransceiver, RtpTrack, SECRET } from "./media.js"
import { UdpMux } from "./mux.js"

const DEFAULT_MAX_MESSAGE_SIZE = 256 * 1024
const encoder = new TextEncoder()

/**
 * @typedef {object} ServerOptions non-standard, the constructor's second argument
 * @property {string[]} [bindAddresses] addresses to listen on (default `["0.0.0.0"]`)
 * @property {string[]} [interfaces] only these network interfaces, by name (e.g. `["eth0"]`)
 * @property {{min: number, max: number}} [portRange] take each connection's UDP port from this range
 * @property {UdpMux} [udpMux] share one UDP port between connections
 * @property {number} [tcpPort] also accept ICE over TCP on this port (0: any free port)
 * @property {string[]} [nat1to1Ips] public IPs to advertise (1:1 NAT, e.g. a cloud VM)
 * @property {"host"|"srflx"} [nat1to1CandidateType] replace the private address ("host", default) or add to it ("srflx")
 * @property {boolean} [includeLoopback] also offer 127.0.0.1
 * @property {boolean} [iceLite] answer connectivity checks only (a server with a public IP)
 * @property {"disabled"|"query"|"gather"} [mdns] resolving (default) or also hiding behind `.local` names
 * @property {number} [maxMessageSize] largest data channel message, bytes (default 262144)
 * @property {{disconnected?: number, failed?: number, keepAlive?: number}} [iceTimeouts] milliseconds
 */

function normalizeConfiguration(configuration) {
    configuration = configuration ?? {}
    const iceServers = [...(configuration.iceServers ?? [])].map((server) => {
        const urls = typeof server?.urls === "string" ? [server.urls] : [...(server?.urls ?? [])]
        if (urls.length === 0) {
            throw new DOMException("an ICE server needs at least one url", "SyntaxError")
        }
        for (const url of urls) {
            if (!/^(stuns?|turns?):/.test(url)) {
                throw new DOMException(`${JSON.stringify(url)} is not a stun:, stuns:, turn: or turns: URL`, "SyntaxError")
            }
            if (/^turns?:/.test(url) && (server.username == null || server.credential == null)) {
                throw new DOMException(`${JSON.stringify(url)} needs a username and credential`, "InvalidAccessError")
            }
        }
        const normalized = { urls }
        if (server.username != null) {
            normalized.username = String(server.username)
        }
        if (server.credential != null) {
            normalized.credential = String(server.credential)
        }
        return normalized
    })
    const iceTransportPolicy = configuration.iceTransportPolicy ?? "all"
    if (!["all", "relay"].includes(iceTransportPolicy)) {
        throw new TypeError(`${JSON.stringify(iceTransportPolicy)} is not a valid RTCIceTransportPolicy`)
    }
    const bundlePolicy = configuration.bundlePolicy ?? "balanced"
    if (!["balanced", "max-compat", "max-bundle"].includes(bundlePolicy)) {
        throw new TypeError(`${JSON.stringify(bundlePolicy)} is not a valid RTCBundlePolicy`)
    }
    const rtcpMuxPolicy = configuration.rtcpMuxPolicy ?? "require"
    if (rtcpMuxPolicy !== "require") {
        throw new TypeError(`${JSON.stringify(rtcpMuxPolicy)} is not a valid RTCRtcpMuxPolicy`)
    }
    const certificates = [...(configuration.certificates ?? [])]
    for (const certificate of certificates) {
        if (!(certificate instanceof RTCCertificate)) {
            throw new TypeError("certificates must come from RTCPeerConnection.generateCertificate()")
        }
        if (certificate.expires <= Date.now()) {
            throw new DOMException("a certificate has expired", "InvalidAccessError")
        }
    }
    return {
        iceServers,
        iceTransportPolicy,
        bundlePolicy,
        rtcpMuxPolicy,
        certificates,
        iceCandidatePoolSize: configuration.iceCandidatePoolSize ?? 0,
    }
}

/** The m-sections of an SDP: mid, kind, direction and the msid stream/track ids. */
function mediaSections(sdp) {
    const sections = []
    let sessionDirection = "sendrecv"
    let current = null
    for (const line of sdp.split(/\r?\n/)) {
        if (line.startsWith("m=")) {
            current = { kind: line.slice(2).split(" ")[0], mid: null, direction: sessionDirection, msids: [] }
            sections.push(current)
        } else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) {
            if (current) {
                current.direction = line.slice(2)
            } else {
                sessionDirection = line.slice(2)
            }
        } else if (current && line.startsWith("a=mid:")) {
            current.mid = line.slice(6).trim()
        } else if (current && line.startsWith("a=msid:")) {
            const [stream, track] = line.slice(7).trim().split(" ")
            current.msids.push({ stream, track })
        }
    }
    return sections
}

/** Adds `line` to the m-section with this mid (or index), or to every m-section when both are null. */
function addToMediaSections(sdp, mid, index, line) {
    const lines = sdp.split("\r\n")
    const trailing = lines.at(-1) === "" ? 1 : 0
    const starts = lines.flatMap((text, at) => (text.startsWith("m=") ? [at] : []))
    for (let section = starts.length - 1; section >= 0; section--) {
        const start = starts[section]
        const end = section + 1 < starts.length ? starts[section + 1] : lines.length - trailing
        const body = lines.slice(start, end)
        const matches = (mid == null && index == null) || (mid != null ? body.includes(`a=mid:${mid}`) : section === index)
        if (matches && !body.includes(line)) {
            lines.splice(end, 0, line)
        }
    }
    return lines.join("\r\n")
}

function description(value) {
    return value ? new RTCSessionDescription(value) : null
}

export class RTCPeerConnection extends EventTarget {
    #handle
    #configuration
    #options
    #closed = false
    #chain = Promise.resolve()
    #signalingState = "stable"
    #iceGatheringState = "new"
    #iceConnectionState = "new"
    #connectionState = "new"
    #descriptions = {}
    /** @type {RTCRtpTransceiver[]} */
    #transceivers = []
    /** addTrack's senders until their transceiver exists */
    #pendingSenders = new Map()
    #localTracks = new Map()
    #channels = new Set()
    #remoteStreams = new Map()
    /** transceiver -> mid whose remote side is sending */
    #remoteSending = new Set()
    #negotiationNeeded = false
    #sctp = null
    #maxMessageSize
    /** ICE events from before setLocalDescription finished; a browser only gathers after it */
    #heldIceEvents = []

    /**
     * @param {RTCConfiguration} [configuration]
     * @param {ServerOptions} [serverOptions] non-standard: listening addresses, ports, NAT, ...
     */
    constructor(configuration = {}, serverOptions = {}) {
        super()
        this.#configuration = normalizeConfiguration(configuration)
        const options = { ...(serverOptions ?? {}) }
        if (options.udpMux) {
            if (!(options.udpMux instanceof UdpMux)) {
                throw new TypeError("udpMux must be a nonstandard.UdpMux")
            }
            options.udpMux = options.udpMux._handle
        }
        this.#options = options
        this.#maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE
        this.#handle = call({
            op: "peerNew",
            ctx: context,
            configuration: {
                ...this.#configuration,
                certificates: this.#configuration.certificates.map((certificate) => RTCCertificate._handle(certificate)),
            },
            options,
        })
        register(this.#handle, this)
        retain()
    }

    static generateCertificate(keygenAlgorithm) {
        return RTCCertificate._generate(keygenAlgorithm)
    }

    get localDescription() {
        return description(this.#descriptions.localDescription)
    }
    get currentLocalDescription() {
        return description(this.#descriptions.currentLocalDescription)
    }
    get pendingLocalDescription() {
        return description(this.#descriptions.pendingLocalDescription)
    }
    get remoteDescription() {
        return description(this.#descriptions.remoteDescription)
    }
    get currentRemoteDescription() {
        return description(this.#descriptions.currentRemoteDescription)
    }
    get pendingRemoteDescription() {
        return description(this.#descriptions.pendingRemoteDescription)
    }
    get signalingState() {
        return this.#signalingState
    }
    get iceGatheringState() {
        return this.#iceGatheringState
    }
    get iceConnectionState() {
        return this.#iceConnectionState
    }
    get connectionState() {
        return this.#connectionState
    }
    get canTrickleIceCandidates() {
        const remote = this.#descriptions.remoteDescription
        return remote ? /^a=ice-options:.*\btrickle\b/m.test(remote.sdp) : null
    }
    get sctp() {
        return this.#sctp
    }
    get peerIdentity() {
        return new Promise(() => {})
    }
    get idpLoginUrl() {
        return null
    }
    getConfiguration() {
        return {
            ...this.#configuration,
            iceServers: this.#configuration.iceServers.map((server) => ({ ...server, urls: [...server.urls] })),
            certificates: [...this.#configuration.certificates],
        }
    }
    setConfiguration(configuration) {
        this.#throwIfClosed()
        const next = normalizeConfiguration(configuration)
        const same = JSON.stringify({ ...next, certificates: undefined }) === JSON.stringify({ ...this.#configuration, certificates: undefined })
        if (configuration.certificates && next.certificates.some((certificate, index) => certificate !== this.#configuration.certificates[index])) {
            throw new DOMException("certificates cannot change", "InvalidModificationError")
        }
        if (!same) {
            throw new DOMException("deno-webrtc cannot change a connection's configuration after construction", "NotSupportedError")
        }
    }

    #throwIfClosed() {
        if (this.#closed) {
            throw new DOMException("the RTCPeerConnection is closed", "InvalidStateError")
        }
    }

    /** Runs `operation` after every earlier one, as the browser's operations chain does. */
    #enqueue(operation) {
        if (this.#closed) {
            return Promise.reject(new DOMException("the RTCPeerConnection is closed", "InvalidStateError"))
        }
        const result = this.#chain.then(() => {
            if (this.#closed) {
                throw new DOMException("the RTCPeerConnection is closed", "InvalidStateError")
            }
            return operation()
        })
        this.#chain = result.catch(() => {})
        return result
    }

    #request(op, args = {}) {
        return request({ op, pc: this.#handle, ...args })
    }

    createOffer(options = {}) {
        return this.#enqueue(async () => {
            const offer = await this.#request("createOffer", { iceRestart: Boolean(options?.iceRestart) })
            return new RTCSessionDescription(offer)
        })
    }

    createAnswer() {
        return this.#enqueue(async () => {
            if (this.#signalingState !== "have-remote-offer" && this.#signalingState !== "have-local-pranswer") {
                throw new DOMException(`createAnswer needs a remote offer (signalingState is "${this.#signalingState}")`, "InvalidStateError")
            }
            return new RTCSessionDescription(await this.#request("createAnswer"))
        })
    }

    /** @param {RTCSessionDescriptionInit} [descriptionInit] none: create the offer or answer the state calls for */
    setLocalDescription(descriptionInit) {
        return this.#enqueue(async () => {
            let local = descriptionInit
            if (!local?.sdp) {
                const answering = this.#signalingState === "have-remote-offer" || this.#signalingState === "have-local-pranswer"
                const type = local?.type ?? (answering ? "answer" : "offer")
                const created = await this.#request(type === "offer" ? "createOffer" : "createAnswer", {})
                local = { type, sdp: created.sdp }
            }
            const snapshot = await this.#request("setLocalDescription", { description: { type: local.type, sdp: local.sdp } })
            this.#apply(snapshot, false)
            // after the promise resolves, as in the browser
            setTimeout(() => this.#releaseIceEvents(), 0)
        })
    }

    /** @param {RTCSessionDescriptionInit} descriptionInit */
    setRemoteDescription(descriptionInit) {
        if (!descriptionInit || typeof descriptionInit.type !== "string") {
            return Promise.reject(new TypeError("setRemoteDescription needs an RTCSessionDescriptionInit"))
        }
        return this.#enqueue(async () => {
            const snapshot = await this.#request("setRemoteDescription", {
                description: { type: descriptionInit.type, sdp: descriptionInit.sdp ?? "" },
            })
            this.#apply(snapshot, true)
        })
    }

    /** @param {RTCIceCandidateInit|RTCIceCandidate|null} [candidate] */
    addIceCandidate(candidate) {
        return this.#enqueue(async () => {
            if (candidate == null || candidate.candidate === "") {
                return
            }
            if (candidate.sdpMid == null && candidate.sdpMLineIndex == null) {
                throw new TypeError("addIceCandidate: the candidate needs an sdpMid or sdpMLineIndex")
            }
            if (!this.#descriptions.remoteDescription) {
                throw new DOMException("addIceCandidate needs a remote description first", "InvalidStateError")
            }
            const init = candidate instanceof RTCIceCandidate ? candidate.toJSON() : candidate
            await this.#request("addIceCandidate", {
                candidate: {
                    candidate: init.candidate,
                    sdpMid: init.sdpMid ?? null,
                    sdpMLineIndex: init.sdpMLineIndex ?? null,
                    usernameFragment: init.usernameFragment ?? null,
                },
            })
        })
    }

    restartIce() {
        if (this.#closed) {
            return
        }
        this.#enqueue(() => this.#request("restartIce")).catch(() => {})
    }

    /** @param {MediaStreamTrack|null} [selector] */
    async getStats(selector = null) {
        this.#throwIfClosed()
        const entries = await this.#request("getStats")
        const report = new RTCStatsReport(entries)
        if (!selector) {
            return report
        }
        const sending = this.getSenders().some((sender) => sender.track === selector)
        const type = sending ? "outbound-rtp" : "inbound-rtp"
        return new RTCStatsReport([...report.values()].filter((entry) => entry.type === type))
    }

    /** @private */
    async _statsOfType(type) {
        const report = await this.getStats()
        return new RTCStatsReport([...report.values()].filter((entry) => entry.type === type))
    }

    /**
     * @param {string} label
     * @param {RTCDataChannelInit} [init]
     */
    createDataChannel(label, init = {}) {
        this.#throwIfClosed()
        label = String(label)
        init = init ?? {}
        if (encoder.encode(label).length > 65535) {
            throw new TypeError("createDataChannel: the label is over 65535 bytes")
        }
        const protocol = String(init.protocol ?? "")
        if (encoder.encode(protocol).length > 65535) {
            throw new TypeError("createDataChannel: the protocol is over 65535 bytes")
        }
        const attributes = {
            label,
            ordered: init.ordered ?? true,
            maxPacketLifeTime: init.maxPacketLifeTime ?? null,
            maxRetransmits: init.maxRetransmits ?? null,
            protocol,
            negotiated: Boolean(init.negotiated),
            id: init.negotiated ? init.id ?? null : null,
            readyState: "connecting",
        }
        const handle = call({ op: "channelNew", pc: this.#handle, label, init: attributes.negotiated ? { ...attributes, id: init.id } : attributes })
        const channel = new RTCDataChannel(handle, attributes, this.#maxMessageSize, RTCDataChannel)
        this.#channels.add(channel)
        channel.addEventListener("close", () => this.#channels.delete(channel))
        return channel
    }

    getTransceivers() {
        return this.#transceivers.filter((transceiver) => !transceiver._stopped)
    }

    getSenders() {
        const bound = this.getTransceivers().map((transceiver) => transceiver.sender)
        return [...bound, ...[...this.#pendingSenders.values()].filter((sender) => !bound.includes(sender))]
    }

    getReceivers() {
        return this.getTransceivers().map((transceiver) => transceiver.receiver)
    }

    /**
     * @param {RtpTrack} track a `nonstandard.RtpTrack`
     * @param {...MediaStream} streams
     */
    addTrack(track, ...streams) {
        this.#throwIfClosed()
        if (!(track instanceof RtpTrack)) {
            throw new TypeError("addTrack: deno-webrtc sends nonstandard.RtpTrack tracks (it has no camera or microphone)")
        }
        if (this.getSenders().some((sender) => sender.track === track)) {
            throw new DOMException("addTrack: the track is already being sent", "InvalidAccessError")
        }
        const sender = new RTCRtpSender(this, track, SECRET)
        this.#pendingSenders.set(track._handle, sender)
        this.#localTracks.set(track._handle, track)
        const streamIds = streams.length ? streams.map((stream) => stream.id) : [track._streamId]
        this.#enqueue(async () => {
            const snapshot = await this.#request("addTrack", { track: track._handle, streams: streamIds })
            this.#apply(snapshot, false)
        }).catch((error) => {
            this.#pendingSenders.delete(track._handle)
            reportError(error)
        })
        return sender
    }

    /** @param {RTCRtpSender} sender */
    removeTrack(sender) {
        this.#throwIfClosed()
        if (!(sender instanceof RTCRtpSender)) {
            throw new TypeError("removeTrack needs an RTCRtpSender")
        }
        if (!this.getSenders().includes(sender)) {
            throw new DOMException("removeTrack: that sender is not from this connection", "InvalidAccessError")
        }
        const track = sender.track
        if (!track) {
            return
        }
        sender._setTrack(null)
        this.#enqueue(async () => {
            const transceiver = sender._transceiver
            if (transceiver?._id != null) {
                const snapshot = await this.#request("removeTrack", { tr: transceiver._id })
                this.#apply(snapshot, false)
            }
            this.#pendingSenders.delete(track._handle)
        }).catch(reportError)
    }

    /**
     * @param {RtpTrack|"audio"|"video"} trackOrKind
     * @param {RTCRtpTransceiverInit} [init]
     */
    addTransceiver(trackOrKind, init = {}) {
        this.#throwIfClosed()
        let track = null
        let kind = trackOrKind
        if (trackOrKind instanceof RtpTrack) {
            track = trackOrKind
            kind = track.kind
        } else if (kind !== "audio" && kind !== "video") {
            throw new TypeError(`addTransceiver: ${JSON.stringify(trackOrKind)} is not "audio", "video" or a nonstandard.RtpTrack`)
        }
        const direction = init?.direction ?? "sendrecv"
        if (!["sendrecv", "sendonly", "recvonly", "inactive"].includes(direction)) {
            throw new TypeError(`${JSON.stringify(direction)} is not a valid RTCRtpTransceiverDirection`)
        }
        const sender = new RTCRtpSender(this, track, SECRET)
        const transceiver = new RTCRtpTransceiver(this, { id: null, kind, direction, sender }, SECRET)
        this.#transceivers.push(transceiver)
        if (track) {
            this.#localTracks.set(track._handle, track)
        }
        const streams = (init?.streams ?? []).map((stream) => stream.id)
        if (track && streams.length === 0) {
            streams.push(track._streamId)
        }
        this.#enqueue(async () => {
            const snapshot = await this.#request("addTransceiver", {
                track: track?._handle,
                kind,
                init: { direction, streams },
            })
            transceiver._id = snapshot.added
            this.#apply(snapshot, false)
            if (transceiver._wantRtp != null) {
                this._wantRtp(transceiver, transceiver._wantRtp)
            }
        }).catch(reportError)
        return transceiver
    }

    /** @private */
    _replaceTrack(sender, track) {
        if (track) {
            this.#localTracks.set(track._handle, track)
        }
        return this.#enqueue(async () => {
            const transceiver = sender._transceiver
            if (transceiver?._id == null) {
                throw new DOMException("replaceTrack: the sender is not negotiated yet", "InvalidStateError")
            }
            await this.#request("replaceTrack", { tr: transceiver._id, track: track?._handle ?? null })
        })
    }

    /** @private */
    _setDirection(transceiver, direction) {
        this.#enqueue(async () => {
            if (transceiver._id != null) {
                await this.#request("setDirection", { tr: transceiver._id, direction })
            }
        }).catch(reportError)
    }

    /** @private */
    _stopTransceiver(transceiver) {
        this.#enqueue(async () => {
            if (transceiver._id != null) {
                await this.#request("stopTransceiver", { tr: transceiver._id })
            }
        }).catch(reportError)
    }

    /** @private a remote track gained or lost its first `rtp` listener */
    _wantRtp(transceiver, wanted) {
        if (transceiver._id == null || this.#closed) {
            transceiver._wantRtp = wanted
            return
        }
        call({ op: "peerWantRtp", pc: this.#handle, tr: transceiver._id, wanted })
    }

    close() {
        if (this.#closed) {
            return
        }
        this.#closed = true
        this.#signalingState = "closed"
        this.#iceConnectionState = "closed"
        this.#connectionState = "closed"
        for (const channel of this.#channels) {
            channel._connectionClosed()
        }
        this.#channels.clear()
        for (const transceiver of this.#transceivers) {
            transceiver.receiver.track.stop()
            transceiver._setCurrentDirection("stopped")
        }
        if (this.#sctp) {
            this.#sctp.state = "closed"
        }
        call({ op: "peerClose", pc: this.#handle })
    }

    /** Mirrors the native side's descriptions and transceivers after a negotiation step. */
    #apply(snapshot, remoteChanged) {
        this.#descriptions = snapshot
        const sections = [snapshot.remoteDescription, snapshot.localDescription].flatMap((value) => (value ? mediaSections(value.sdp) : []))
        for (const described of snapshot.transceivers) {
            if (described.kind == null || described.kind === "unspecified") {
                described.kind = sections.find((section) => section.mid != null && section.mid === described.mid)?.kind ?? null
            }
            let transceiver = this.#transceivers.find((existing) => existing._id === described.id)
            const pendingSender = described.senderTrack != null ? this.#pendingSenders.get(described.senderTrack) : undefined
            if (!transceiver) {
                transceiver = new RTCRtpTransceiver(this, { ...described, sender: pendingSender }, SECRET)
                this.#transceivers.push(transceiver)
            } else if (pendingSender && transceiver.sender !== pendingSender) {
                transceiver._setSender(pendingSender)
            }
            if (pendingSender) {
                this.#pendingSenders.delete(described.senderTrack)
            }
            if (described.senderTrack != null && transceiver.sender.track?._handle !== described.senderTrack) {
                transceiver.sender._setTrack(this.#localTracks.get(described.senderTrack) ?? null)
            }
            transceiver._update(described)
        }
        if (snapshot.signalingState !== this.#signalingState && !this.#closed) {
            this.#signalingState = snapshot.signalingState
            this.dispatchEvent(new Event("signalingstatechange"))
        }
        if (remoteChanged && snapshot.remoteDescription) {
            this.#processRemoteTracks(snapshot.remoteDescription.sdp)
            if (!this.#sctp && /^m=application /m.test(snapshot.remoteDescription.sdp)) {
                const match = snapshot.remoteDescription.sdp.match(/^a=max-message-size:(\d+)/m)
                const remoteLimit = match ? Number(match[1]) : 65536
                this.#sctp = {
                    transport: null,
                    state: "connecting",
                    maxMessageSize: Math.min(remoteLimit || Infinity, this.#maxMessageSize),
                    maxChannels: null,
                    onstatechange: null,
                }
            }
        }
        if (this.#signalingState === "stable" && this.#negotiationNeeded) {
            this.#negotiationNeeded = false
            queueMicrotask(() => this.#fireNegotiationNeeded())
        }
    }

    /** Fires `track` for each transceiver the remote side has started sending on. */
    #processRemoteTracks(sdp) {
        const sections = mediaSections(sdp)
        for (const transceiver of this.getTransceivers()) {
            const section = sections.find((section) => section.mid != null && section.mid === transceiver.mid)
            if (!section) {
                continue
            }
            const sending = section.direction === "sendrecv" || section.direction === "sendonly"
            const track = transceiver.receiver.track
            const streams = section.msids
                .filter(({ stream }) => stream && stream !== "-")
                .map(({ stream }) => {
                    if (!this.#remoteStreams.has(stream)) {
                        this.#remoteStreams.set(stream, MediaStream._remote(stream))
                    }
                    return this.#remoteStreams.get(stream)
                })
            if (sending && !this.#remoteSending.has(transceiver)) {
                this.#remoteSending.add(transceiver)
                for (const stream of streams) {
                    stream._remoteAdd(track)
                }
                this.dispatchEvent(new RTCTrackEvent("track", { receiver: transceiver.receiver, track, streams, transceiver }))
            } else if (!sending && this.#remoteSending.has(transceiver)) {
                this.#remoteSending.delete(transceiver)
                track._setMuted(true)
                for (const stream of this.#remoteStreams.values()) {
                    stream._remoteRemove(track)
                }
            }
        }
    }

    #releaseIceEvents() {
        const held = this.#heldIceEvents
        this.#heldIceEvents = null
        for (const event of held ?? []) {
            this.onNativeEvent(event)
        }
    }

    #fireNegotiationNeeded() {
        if (this.#closed) {
            return
        }
        if (this.#signalingState !== "stable") {
            this.#negotiationNeeded = true
            return
        }
        this.dispatchEvent(new Event("negotiationneeded"))
    }

    /** The local description includes candidates as they are gathered, as in the browser. */
    #addToLocalDescriptions(mid, index, line) {
        for (const key of ["localDescription", "pendingLocalDescription", "currentLocalDescription"]) {
            const local = this.#descriptions[key]
            if (local?.sdp) {
                this.#descriptions = { ...this.#descriptions, [key]: { ...local, sdp: addToMediaSections(local.sdp, mid, index, line) } }
            }
        }
    }

    #transceiverById(id) {
        return this.#transceivers.find((transceiver) => transceiver._id === id)
    }

    /** @private */
    onNativeEvent(event, payload) {
        if (event.t === "pc_closed") {
            unregister(this.#handle)
            release()
            return
        }
        if (this.#closed) {
            return
        }
        if (this.#heldIceEvents && (event.t === "pc_icecandidate" || event.t === "pc_icegatheringstate" || event.t === "pc_icecandidateerror")) {
            this.#heldIceEvents.push(event)
            return
        }
        switch (event.t) {
            case "pc_icecandidate": {
                const candidate = new RTCIceCandidate(event.candidate)
                if (candidate.candidate) {
                    const line = candidate.candidate.startsWith("a=") ? candidate.candidate : `a=${candidate.candidate}`
                    this.#addToLocalDescriptions(candidate.sdpMid, candidate.sdpMLineIndex, line)
                }
                this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate, url: event.url ?? null }))
                break
            }
            case "pc_icecandidateerror":
                this.dispatchEvent(new RTCPeerConnectionIceErrorEvent("icecandidateerror", event))
                break
            case "pc_icegatheringstate":
                if (event.state !== this.#iceGatheringState) {
                    this.#iceGatheringState = event.state
                    this.dispatchEvent(new Event("icegatheringstatechange"))
                    if (event.state === "complete") {
                        this.#addToLocalDescriptions(null, null, "a=end-of-candidates")
                        this.dispatchEvent(new RTCPeerConnectionIceEvent("icecandidate", { candidate: null }))
                    }
                }
                break
            case "pc_iceconnectionstate":
                if (event.state !== this.#iceConnectionState) {
                    this.#iceConnectionState = event.state
                    this.dispatchEvent(new Event("iceconnectionstatechange"))
                }
                break
            case "pc_connectionstate":
                if (event.state !== this.#connectionState) {
                    this.#connectionState = event.state
                    if (this.#sctp && event.state === "connected" && this.#sctp.state === "connecting") {
                        this.#sctp.state = "connected"
                    }
                    this.dispatchEvent(new Event("connectionstatechange"))
                }
                break
            case "pc_signalingstate":
                // derived from the descriptions instead, so it changes before the promise resolves
                break
            case "pc_negotiationneeded":
                this.#fireNegotiationNeeded()
                break
            case "pc_datachannel": {
                const channel = new RTCDataChannel(event.dc, { ...event }, this.#maxMessageSize, RTCDataChannel)
                this.#channels.add(channel)
                channel.addEventListener("close", () => this.#channels.delete(channel))
                this.dispatchEvent(new RTCDataChannelEvent("datachannel", { channel }))
                break
            }
            case "track_open":
                this.#transceiverById(event.tr)?.receiver.track._setMuted(false)
                break
            case "track_rtp":
                this.#transceiverById(event.tr)?.receiver.track._rtp(payload)
                break
            case "track_mute":
                this.#transceiverById(event.tr)?.receiver.track._setMuted(true)
                break
            case "track_unmute":
                this.#transceiverById(event.tr)?.receiver.track._setMuted(false)
                break
            case "track_ended":
                this.#transceiverById(event.tr)?.receiver.track._end()
                break
        }
    }
}

defineEventHandlers(RTCPeerConnection, [
    "negotiationneeded",
    "icecandidate",
    "icecandidateerror",
    "signalingstatechange",
    "iceconnectionstatechange",
    "icegatheringstatechange",
    "connectionstatechange",
    "datachannel",
    "track",
])
