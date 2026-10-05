// Non-standard: one UDP port shared by many connections.

import { call } from "./ffi.js"

/**
 * Listens on one UDP port (per local address) for every connection given it as
 * `new RTCPeerConnection(config, { udpMux })`, so a server opens one firewall port, not one per peer.
 *
 * ```js
 * const udpMux = new UdpMux({ port: 3478 })
 * const pc = new RTCPeerConnection({}, { udpMux })
 * ```
 */
export class UdpMux {
    #handle
    #port
    #addresses
    #closed = false

    /** @param {{port?: number, addresses?: string[], includeLoopback?: boolean}} [options] port 0 (default) picks a free one */
    constructor(options = {}) {
        const described = call({
            op: "muxNew",
            port: options.port ?? 0,
            addresses: options.addresses ?? [],
            includeLoopback: options.includeLoopback ?? false,
        })
        this.#handle = described.handle
        this.#port = described.port
        this.#addresses = described.addresses
    }
    /** the shared UDP port */
    get port() {
        return this.#port
    }
    /** every "ip:port" it listens on */
    get addresses() {
        return [...this.#addresses]
    }
    /** Stops listening once the connections using it have closed too. */
    close() {
        if (!this.#closed) {
            this.#closed = true
            call({ op: "free", handle: this.#handle })
        }
    }
    /** @private */
    get _handle() {
        if (this.#closed) {
            throw new DOMException("the UdpMux is closed", "InvalidStateError")
        }
        return this.#handle
    }
}
