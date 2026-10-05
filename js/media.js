// MediaStreamTrack, MediaStream, the RTP sender/receiver/transceiver, and the non-standard RtpTrack.

import { call, context, native, register } from "./ffi.js"
import { MediaStreamTrackEvent, RTCRtpPacketEvent, defineEventHandlers } from "./events.js"

const SECRET = Symbol("deno-webrtc internal")

export class MediaStreamTrack extends EventTarget {
    #kind
    #id
    #label
    #enabled = true
    #muted
    #readyState = "live"
    #contentHint = ""

    /** @private remote tracks come from RTCRtpReceiver; local ones are `nonstandard.RtpTrack` */
    constructor(init, secret) {
        if (secret !== SECRET) {
            throw new TypeError("Illegal constructor: create a nonstandard.RtpTrack to send media")
        }
        super()
        this.#kind = init.kind
        this.#id = init.id ?? crypto.randomUUID()
        this.#label = init.label ?? ""
        this.#muted = init.muted ?? false
    }
    get kind() {
        return this.#kind
    }
    get id() {
        return this.#id
    }
    get label() {
        return this.#label
    }
    get enabled() {
        return this.#enabled
    }
    set enabled(value) {
        this.#enabled = Boolean(value)
        this._enabledChanged(this.#enabled)
    }
    get muted() {
        return this.#muted
    }
    get readyState() {
        return this.#readyState
    }
    get contentHint() {
        return this.#contentHint
    }
    set contentHint(value) {
        this.#contentHint = String(value)
    }
    stop() {
        if (this.#readyState === "ended") {
            return
        }
        this.#readyState = "ended"
        this._enabledChanged(false)
    }
    clone() {
        throw new DOMException("MediaStreamTrack.clone() is not supported by deno-webrtc", "NotSupportedError")
    }
    getCapabilities() {
        return {}
    }
    getConstraints() {
        return {}
    }
    getSettings() {
        return {}
    }
    applyConstraints() {
        return Promise.resolve()
    }

    /** @private */
    _enabledChanged() {}
    /** @private */
    _setMuted(muted) {
        if (this.#muted !== muted && this.#readyState === "live") {
            this.#muted = muted
            this.dispatchEvent(new Event(muted ? "mute" : "unmute"))
        }
    }
    /** @private */
    _end() {
        if (this.#readyState !== "ended") {
            this.#readyState = "ended"
            this.dispatchEvent(new Event("ended"))
        }
    }
}

defineEventHandlers(MediaStreamTrack, ["mute", "unmute", "ended"])

/** A track arriving from the other peer. Non-standard: `rtp` events carry its raw RTP packets. */
export class RemoteMediaStreamTrack extends MediaStreamTrack {
    #wantRtp
    #rtpListeners = 0
    constructor(init, wantRtp) {
        super({ ...init, muted: true }, SECRET)
        this.#wantRtp = wantRtp
    }
    addEventListener(type, listener, options) {
        if (type === "rtp" && listener && this.#rtpListeners++ === 0) {
            this.#wantRtp(true)
        }
        super.addEventListener(type, listener, options)
    }
    removeEventListener(type, listener, options) {
        if (type === "rtp" && listener && this.#rtpListeners > 0 && --this.#rtpListeners === 0) {
            this.#wantRtp(false)
        }
        super.removeEventListener(type, listener, options)
    }
    /** @private */
    _rtp(packet) {
        if (this.enabled && this.readyState === "live") {
            this.dispatchEvent(new RTCRtpPacketEvent("rtp", { data: packet }))
        }
    }
}

defineEventHandlers(RemoteMediaStreamTrack, ["rtp"])

/**
 * Non-standard: a track you feed with already-encoded media, either whole frames
 * (`writeSample`, packetized for you) or finished RTP packets (`writeRtp`).
 * No encoding or decoding happens here.
 *
 * ```js
 * const track = new RtpTrack({ kind: "video", mimeType: "video/H264" })
 * pc.addTrack(track)
 * track.writeSample(annexBFrame, { duration: 33 })
 * ```
 */
export class RtpTrack extends MediaStreamTrack {
    #handle
    #streamId
    #mimeType

    /**
     * @param {{kind: "audio"|"video", mimeType: string, clockRate?: number, channels?: number, sdpFmtpLine?: string, id?: string, label?: string, streamId?: string}} init
     */
    constructor(init) {
        if (!init || (init.kind !== "audio" && init.kind !== "video")) {
            throw new TypeError('RtpTrack needs kind "audio" or "video"')
        }
        if (typeof init.mimeType !== "string") {
            throw new TypeError('RtpTrack needs a mimeType such as "video/H264", "video/VP8" or "audio/opus"')
        }
        const described = call({ op: "trackNew", ctx: context, init: { ...init } })
        super({ kind: init.kind, id: described.id, label: init.label }, SECRET)
        this.#handle = described.handle
        this.#streamId = described.streamId
        this.#mimeType = init.mimeType
        register(this.#handle, this)
    }
    get mimeType() {
        return this.#mimeType
    }
    /** @private */
    get _handle() {
        return this.#handle
    }
    /** @private */
    get _streamId() {
        return this.#streamId
    }
    /** @private */
    _enabledChanged(enabled) {
        call({ op: "trackEnabled", track: this.#handle, enabled: enabled && this.readyState === "live" })
    }

    /**
     * Sends one encoded frame: H.264 Annex B, a VP8/VP9/AV1 frame, an Opus packet, ...
     * @param {Uint8Array|ArrayBuffer} data
     * @param {{duration: number}|number} timing the frame's duration in milliseconds
     */
    writeSample(data, timing) {
        const duration = typeof timing === "number" ? timing : timing?.duration
        if (!(duration >= 0)) {
            throw new TypeError("writeSample needs the frame's duration in milliseconds")
        }
        const bytes = toBytes(data)
        if (native.dwrtc_track_write_sample(this.#handle, bytes, bytes.length, duration * 1000) !== 0) {
            throw new DOMException("the track is gone", "InvalidStateError")
        }
    }

    /**
     * Sends one RTP packet as is, except its SSRC and payload type, which become the negotiated ones.
     * @param {Uint8Array|ArrayBuffer} packet
     */
    writeRtp(packet) {
        const bytes = toBytes(packet)
        if (native.dwrtc_track_write_rtp(this.#handle, bytes, bytes.length) !== 0) {
            throw new DOMException("the track is gone", "InvalidStateError")
        }
    }

    /** @private */
    onNativeEvent(event) {
        if (event.t === "track_keyframe") {
            this.dispatchEvent(new Event("keyframerequest"))
        } else if (event.t === "track_error") {
            this.dispatchEvent(new ErrorEvent("error", { message: event.error }))
        }
    }
}

defineEventHandlers(RtpTrack, ["keyframerequest", "error"])

function toBytes(data) {
    if (data instanceof Uint8Array) {
        return data.length === 0 ? new Uint8Array(1).subarray(0, 0) : data
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data)
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    throw new TypeError("expected a Uint8Array or ArrayBuffer")
}

export class MediaStream extends EventTarget {
    #id
    #tracks = new Set()
    /** @param {MediaStream|MediaStreamTrack[]} [init] */
    constructor(init) {
        super()
        this.#id = crypto.randomUUID()
        const tracks = init instanceof MediaStream ? init.getTracks() : init ?? []
        for (const track of tracks) {
            this.#tracks.add(track)
        }
    }
    get id() {
        return this.#id
    }
    get active() {
        return [...this.#tracks].some((track) => track.readyState === "live")
    }
    getTracks() {
        return [...this.#tracks]
    }
    getAudioTracks() {
        return this.getTracks().filter((track) => track.kind === "audio")
    }
    getVideoTracks() {
        return this.getTracks().filter((track) => track.kind === "video")
    }
    getTrackById(id) {
        return this.getTracks().find((track) => track.id === id) ?? null
    }
    addTrack(track) {
        this.#tracks.add(track)
    }
    removeTrack(track) {
        this.#tracks.delete(track)
    }
    clone() {
        return new MediaStream(this.getTracks())
    }
    /** @private a stream the remote side named */
    static _remote(id) {
        const stream = new MediaStream()
        stream.#id = id
        return stream
    }
    /** @private the remote side added a track to it */
    _remoteAdd(track) {
        if (!this.#tracks.has(track)) {
            this.#tracks.add(track)
            this.dispatchEvent(new MediaStreamTrackEvent("addtrack", { track }))
        }
    }
    /** @private */
    _remoteRemove(track) {
        if (this.#tracks.delete(track)) {
            this.dispatchEvent(new MediaStreamTrackEvent("removetrack", { track }))
        }
    }
}

defineEventHandlers(MediaStream, ["addtrack", "removetrack"])

const CAPABILITIES = {
    audio: {
        codecs: [
            { mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "minptime=10;useinbandfec=1" },
            { mimeType: "audio/G722", clockRate: 8000, channels: 1 },
            { mimeType: "audio/PCMU", clockRate: 8000, channels: 1 },
            { mimeType: "audio/PCMA", clockRate: 8000, channels: 1 },
        ],
        headerExtensions: [],
    },
    video: {
        codecs: [
            { mimeType: "video/VP8", clockRate: 90000 },
            { mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=0" },
            { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" },
            { mimeType: "video/AV1", clockRate: 90000 },
            { mimeType: "video/H265", clockRate: 90000 },
        ],
        headerExtensions: [],
    },
}

function capabilities(kind) {
    const known = CAPABILITIES[kind]
    return known ? structuredClone(known) : null
}

export class RTCRtpSender {
    #connection
    #transceiver
    #track
    /** @private */
    constructor(connection, track, secret) {
        if (secret !== SECRET) {
            throw new TypeError("Illegal constructor")
        }
        this.#connection = connection
        this.#track = track
    }
    get track() {
        return this.#track
    }
    get transport() {
        return null
    }
    get dtmf() {
        return null
    }
    /** @param {RtpTrack|null} track */
    replaceTrack(track) {
        if (track !== null && !(track instanceof RtpTrack)) {
            return Promise.reject(new TypeError("replaceTrack: only a nonstandard.RtpTrack (or null) can be sent"))
        }
        if (track && this.#track && track.kind !== this.#track.kind) {
            return Promise.reject(new TypeError("replaceTrack: the new track is a different kind"))
        }
        return this.#connection._replaceTrack(this, track).then(() => {
            this.#track = track
        })
    }
    setStreams() {
        throw new DOMException("RTCRtpSender.setStreams is not supported by deno-webrtc; pass streams to addTrack", "NotSupportedError")
    }
    getParameters() {
        return { transactionId: "", encodings: [{ active: true }], codecs: [], headerExtensions: [], rtcp: { cname: "", reducedSize: true } }
    }
    setParameters() {
        return Promise.reject(new DOMException("RTCRtpSender.setParameters is not supported by deno-webrtc", "NotSupportedError"))
    }
    async getStats() {
        return this.#connection._statsOfType("outbound-rtp")
    }
    static getCapabilities(kind) {
        return capabilities(kind)
    }
    /** @private */
    _setTrack(track) {
        this.#track = track
    }
    /** @private */
    get _transceiver() {
        return this.#transceiver
    }
    set _transceiver(transceiver) {
        this.#transceiver = transceiver
    }
}

export class RTCRtpReceiver {
    #connection
    #track
    /** @private */
    constructor(connection, track, secret) {
        if (secret !== SECRET) {
            throw new TypeError("Illegal constructor")
        }
        this.#connection = connection
        this.#track = track
    }
    get track() {
        return this.#track
    }
    get transport() {
        return null
    }
    get jitterBufferTarget() {
        return null
    }
    getParameters() {
        return { codecs: [], headerExtensions: [], rtcp: { cname: "", reducedSize: true } }
    }
    getContributingSources() {
        return []
    }
    getSynchronizationSources() {
        return []
    }
    async getStats() {
        return this.#connection._statsOfType("inbound-rtp")
    }
    static getCapabilities(kind) {
        return capabilities(kind)
    }
}

const DIRECTIONS = ["sendrecv", "sendonly", "recvonly", "inactive", "stopped"]

export class RTCRtpTransceiver {
    #connection
    #id
    #mid = null
    #direction
    #currentDirection = null
    #sender
    #receiver
    #stopped = false

    /** @private */
    constructor(connection, { id, kind, direction, sender, receiverTrackId }, secret) {
        if (secret !== SECRET) {
            throw new TypeError("Illegal constructor")
        }
        this.#connection = connection
        this.#id = id
        this.#direction = direction ?? "sendrecv"
        this.#sender = sender ?? new RTCRtpSender(connection, null, SECRET)
        this.#sender._transceiver = this
        const track = new RemoteMediaStreamTrack(
            { kind, id: receiverTrackId ?? crypto.randomUUID() },
            (wanted) => connection._wantRtp(this, wanted),
        )
        this.#receiver = new RTCRtpReceiver(connection, track, SECRET)
    }
    get mid() {
        return this.#mid
    }
    get sender() {
        return this.#sender
    }
    get receiver() {
        return this.#receiver
    }
    get direction() {
        return this.#direction
    }
    set direction(direction) {
        if (!DIRECTIONS.includes(direction) || direction === "stopped") {
            throw new TypeError(`${JSON.stringify(direction)} is not a valid RTCRtpTransceiverDirection`)
        }
        if (this.#stopped) {
            throw new DOMException("the transceiver is stopped", "InvalidStateError")
        }
        if (direction !== this.#direction) {
            this.#direction = direction
            this.#connection._setDirection(this, direction)
        }
    }
    get currentDirection() {
        return this.#currentDirection
    }
    stop() {
        if (this.#stopped) {
            return
        }
        this.#stopped = true
        this.#direction = "stopped"
        this.#receiver.track._end()
        this.#connection._stopTransceiver(this)
    }
    setCodecPreferences() {
        throw new DOMException("setCodecPreferences is not supported by deno-webrtc", "NotSupportedError")
    }
    /** @private */
    get _id() {
        return this.#id
    }
    set _id(id) {
        this.#id = id
    }
    /** @private */
    get _stopped() {
        return this.#stopped
    }
    /** @private update from the native side's view */
    _update(described) {
        this.#mid = described.mid ?? this.#mid
        if (!this.#stopped && described.direction && described.direction !== "unspecified") {
            this.#direction = described.direction
        }
        this.#currentDirection = described.currentDirection ?? this.#currentDirection
    }
    /** @private addTrack reused this transceiver */
    _setSender(sender) {
        this.#sender = sender
        sender._transceiver = this
    }
    /** @private */
    _setCurrentDirection(direction) {
        this.#currentDirection = direction
    }
}

export { SECRET }
