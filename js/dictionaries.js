// RTCSessionDescription, RTCIceCandidate, RTCCertificate and RTCStatsReport.

import { call, request } from "./ffi.js"

const SDP_TYPES = ["offer", "pranswer", "answer", "rollback"]

export class RTCSessionDescription {
    #type
    #sdp
    /** @param {{type: "offer"|"pranswer"|"answer"|"rollback", sdp?: string}} init */
    constructor(init) {
        if (!init || !SDP_TYPES.includes(init.type)) {
            throw new TypeError(`RTCSessionDescription: ${JSON.stringify(init?.type)} is not a valid RTCSdpType`)
        }
        this.#type = init.type
        this.#sdp = init.sdp ?? ""
    }
    get type() {
        return this.#type
    }
    get sdp() {
        return this.#sdp
    }
    toJSON() {
        return { type: this.#type, sdp: this.#sdp }
    }
}

/** @param {string} candidate */
function parseCandidate(candidate) {
    const fields = candidate.replace(/^a=/, "").replace(/^candidate:/, "").trim().split(/\s+/)
    if (fields.length < 8 || fields[6] !== "typ") {
        return null
    }
    const parsed = {
        foundation: fields[0],
        component: fields[1] === "1" ? "rtp" : "rtcp",
        protocol: fields[2].toLowerCase(),
        priority: Number(fields[3]),
        address: fields[4],
        port: Number(fields[5]),
        type: fields[7],
        tcpType: null,
        relatedAddress: null,
        relatedPort: null,
        usernameFragment: null,
    }
    for (let index = 8; index + 1 < fields.length; index += 2) {
        const [key, value] = [fields[index], fields[index + 1]]
        if (key === "raddr") {
            parsed.relatedAddress = value
        } else if (key === "rport") {
            parsed.relatedPort = Number(value)
        } else if (key === "tcptype") {
            parsed.tcpType = value
        } else if (key === "ufrag") {
            parsed.usernameFragment = value
        }
    }
    return parsed
}

export class RTCIceCandidate {
    #init
    #parsed
    /** @param {{candidate?: string, sdpMid?: string|null, sdpMLineIndex?: number|null, usernameFragment?: string|null}} init */
    constructor(init = {}) {
        if (init.sdpMid == null && init.sdpMLineIndex == null) {
            throw new TypeError("RTCIceCandidate needs an sdpMid or sdpMLineIndex")
        }
        this.#init = {
            candidate: init.candidate ?? "",
            sdpMid: init.sdpMid ?? null,
            sdpMLineIndex: init.sdpMLineIndex ?? null,
            usernameFragment: init.usernameFragment ?? null,
        }
        this.#parsed = parseCandidate(this.#init.candidate)
    }
    get candidate() {
        return this.#init.candidate
    }
    get sdpMid() {
        return this.#init.sdpMid
    }
    get sdpMLineIndex() {
        return this.#init.sdpMLineIndex
    }
    get usernameFragment() {
        return this.#init.usernameFragment ?? this.#parsed?.usernameFragment ?? null
    }
    get foundation() {
        return this.#parsed?.foundation ?? null
    }
    get component() {
        return this.#parsed?.component ?? null
    }
    get priority() {
        return this.#parsed?.priority ?? null
    }
    get address() {
        return this.#parsed?.address ?? null
    }
    get protocol() {
        return this.#parsed?.protocol ?? null
    }
    get port() {
        return this.#parsed?.port ?? null
    }
    get type() {
        return this.#parsed?.type ?? null
    }
    get tcpType() {
        return this.#parsed?.tcpType ?? null
    }
    get relatedAddress() {
        return this.#parsed?.relatedAddress ?? null
    }
    get relatedPort() {
        return this.#parsed?.relatedPort ?? null
    }
    toJSON() {
        return { ...this.#init }
    }
}

const certificateHandles = new WeakMap()

export class RTCCertificate {
    #expires
    #fingerprints
    /** @private use RTCPeerConnection.generateCertificate */
    constructor(described, secret) {
        if (secret !== certificateHandles) {
            throw new TypeError("Illegal constructor: use RTCPeerConnection.generateCertificate()")
        }
        this.#expires = described.expires
        this.#fingerprints = described.fingerprints
        certificateHandles.set(this, described.handle)
    }
    /** @returns {number} milliseconds since the epoch */
    get expires() {
        return this.#expires
    }
    getFingerprints() {
        return this.#fingerprints.map((fingerprint) => ({ ...fingerprint }))
    }
    /** Non-standard: the certificate and its private key, to keep a server's fingerprint across restarts. */
    toPEM() {
        return call({ op: "certificatePem", cert: certificateHandles.get(this) })
    }
    /** Non-standard: the inverse of `toPEM()`. */
    static fromPEM(pem) {
        return new RTCCertificate(call({ op: "certificateFromPem", pem }), certificateHandles)
    }
    static async _generate(keygenAlgorithm) {
        const algorithm = typeof keygenAlgorithm === "string" ? { name: keygenAlgorithm } : keygenAlgorithm ?? {}
        const described = await request({ op: "generateCertificate", name: algorithm.name, namedCurve: algorithm.namedCurve })
        return new RTCCertificate(described, certificateHandles)
    }
    static _handle(certificate) {
        return certificateHandles.get(certificate)
    }
}

/** Read-only maplike of stats objects by id, like the browser's. */
export class RTCStatsReport extends Map {
    constructor(entries = []) {
        super()
        for (const entry of entries) {
            super.set(entry.id, Object.freeze(entry))
        }
    }
    set() {
        throw new TypeError("RTCStatsReport is read-only")
    }
    delete() {
        throw new TypeError("RTCStatsReport is read-only")
    }
    clear() {
        throw new TypeError("RTCStatsReport is read-only")
    }
}
