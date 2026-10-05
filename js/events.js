// The WebRTC event classes, and `on<event>` handler properties.

/**
 * Adds `on<name>` properties that behave like a browser's event handler attributes.
 * @param {Function} constructor
 * @param {string[]} names
 */
export function defineEventHandlers(constructor, names) {
    for (const name of names) {
        const key = Symbol(`on${name}`)
        Object.defineProperty(constructor.prototype, `on${name}`, {
            get() {
                return this[key]?.handler ?? null
            },
            set(handler) {
                if (this[key]) {
                    this.removeEventListener(name, this[key].listener)
                }
                if (typeof handler === "function") {
                    const listener = (event) => handler.call(this, event)
                    this[key] = { handler, listener }
                    this.addEventListener(name, listener)
                } else {
                    this[key] = undefined
                }
            },
            configurable: true,
            enumerable: true,
        })
    }
}

export class RTCPeerConnectionIceEvent extends Event {
    #candidate
    #url
    constructor(type, init = {}) {
        super(type, init)
        this.#candidate = init.candidate ?? null
        this.#url = init.url ?? null
    }
    get candidate() {
        return this.#candidate
    }
    /** @deprecated in the spec, still in browsers */
    get url() {
        return this.#url
    }
}

export class RTCPeerConnectionIceErrorEvent extends Event {
    #init
    constructor(type, init = {}) {
        super(type, init)
        this.#init = init
    }
    get address() {
        return this.#init.address ?? null
    }
    get port() {
        return this.#init.port ?? null
    }
    get url() {
        return this.#init.url ?? ""
    }
    get errorCode() {
        return this.#init.errorCode ?? 0
    }
    get errorText() {
        return this.#init.errorText ?? ""
    }
}

export class RTCDataChannelEvent extends Event {
    #channel
    constructor(type, init) {
        super(type, init)
        if (!init?.channel) {
            throw new TypeError("RTCDataChannelEvent needs a channel")
        }
        this.#channel = init.channel
    }
    get channel() {
        return this.#channel
    }
}

export class RTCTrackEvent extends Event {
    #init
    constructor(type, init) {
        super(type, init)
        if (!init?.receiver || !init?.track || !init?.transceiver) {
            throw new TypeError("RTCTrackEvent needs a receiver, track and transceiver")
        }
        this.#init = init
    }
    get receiver() {
        return this.#init.receiver
    }
    get track() {
        return this.#init.track
    }
    get streams() {
        return Object.freeze([...(this.#init.streams ?? [])])
    }
    get transceiver() {
        return this.#init.transceiver
    }
}

export class RTCError extends DOMException {
    #init
    constructor(init = {}, message = "") {
        super(message, "OperationError")
        if (!init.errorDetail) {
            throw new TypeError("RTCError needs an errorDetail")
        }
        this.#init = init
    }
    get errorDetail() {
        return this.#init.errorDetail
    }
    get sdpLineNumber() {
        return this.#init.sdpLineNumber ?? null
    }
    get sctpCauseCode() {
        return this.#init.sctpCauseCode ?? null
    }
    get receivedAlert() {
        return this.#init.receivedAlert ?? null
    }
    get sentAlert() {
        return this.#init.sentAlert ?? null
    }
    get httpRequestStatusCode() {
        return this.#init.httpRequestStatusCode ?? null
    }
}

export class RTCErrorEvent extends Event {
    #error
    constructor(type, init) {
        super(type, init)
        if (!init?.error) {
            throw new TypeError("RTCErrorEvent needs an error")
        }
        this.#error = init.error
    }
    get error() {
        return this.#error
    }
}

export class MediaStreamTrackEvent extends Event {
    #track
    constructor(type, init) {
        super(type, init)
        if (!init?.track) {
            throw new TypeError("MediaStreamTrackEvent needs a track")
        }
        this.#track = init.track
    }
    get track() {
        return this.#track
    }
}

/** Non-standard: one received RTP packet (`rtp` event on a remote track). */
export class RTCRtpPacketEvent extends Event {
    #data
    constructor(type, init) {
        super(type, init)
        this.#data = init.data
    }
    /** @returns {Uint8Array} the whole packet, header included */
    get data() {
        return this.#data
    }
}
