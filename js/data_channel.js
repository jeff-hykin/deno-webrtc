// RTCDataChannel

import { call, native, register, unregister } from "./ffi.js"
import { RTCError, RTCErrorEvent, defineEventHandlers } from "./events.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class RTCDataChannel extends EventTarget {
    #handle
    #attributes
    #readyState
    #binaryType = "arraybuffer"
    #lowThreshold = 0
    #maxMessageSize
    /** sends waiting on a Blob's bytes, so later sends keep their place */
    #blobQueue = null

    /** @private created by RTCPeerConnection */
    constructor(handle, attributes, maxMessageSize, secret) {
        if (secret !== RTCDataChannel) {
            throw new TypeError("Illegal constructor: use RTCPeerConnection.createDataChannel()")
        }
        super()
        this.#handle = handle
        this.#attributes = attributes
        this.#readyState = attributes.readyState ?? "connecting"
        this.#maxMessageSize = maxMessageSize
        register(handle, this)
    }

    get label() {
        return this.#attributes.label
    }
    get ordered() {
        return this.#attributes.ordered
    }
    get maxPacketLifeTime() {
        return this.#attributes.maxPacketLifeTime ?? null
    }
    get maxRetransmits() {
        return this.#attributes.maxRetransmits ?? null
    }
    get protocol() {
        return this.#attributes.protocol
    }
    get negotiated() {
        return this.#attributes.negotiated
    }
    get id() {
        return this.#attributes.id ?? null
    }
    get readyState() {
        return this.#readyState
    }
    get bufferedAmount() {
        return this.#readyState === "closed" ? 0 : native.dwrtc_channel_buffered_amount(this.#handle)
    }
    get bufferedAmountLowThreshold() {
        return this.#lowThreshold
    }
    set bufferedAmountLowThreshold(value) {
        this.#lowThreshold = Math.max(0, Math.min(Number(value) >>> 0, 0xffffffff))
        if (this.#readyState !== "closed") {
            call({ op: "channelLowThreshold", dc: this.#handle, value: this.#lowThreshold })
        }
    }
    get binaryType() {
        return this.#binaryType
    }
    set binaryType(value) {
        // browsers ignore an invalid value
        if (value === "arraybuffer" || value === "blob") {
            this.#binaryType = value
        }
    }

    /** @param {string|ArrayBuffer|ArrayBufferView|Blob} data */
    send(data) {
        if (this.#readyState !== "open") {
            throw new DOMException(`RTCDataChannel.send: readyState is "${this.#readyState}", not "open"`, "InvalidStateError")
        }
        if (data instanceof Blob) {
            if (data.size > this.#maxMessageSize) {
                throw new TypeError(`RTCDataChannel.send: ${data.size} bytes is over the ${this.#maxMessageSize} byte limit`)
            }
            this.#blobQueue = (this.#blobQueue ?? Promise.resolve()).then(async () => {
                this.#write(new Uint8Array(await data.arrayBuffer()), false)
            })
            return
        }
        let bytes
        let text = false
        if (typeof data === "string") {
            bytes = encoder.encode(data)
            text = true
        } else if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) {
            bytes = new Uint8Array(data)
        } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        } else {
            bytes = encoder.encode(String(data))
            text = true
        }
        if (bytes.length > this.#maxMessageSize) {
            throw new TypeError(`RTCDataChannel.send: ${bytes.length} bytes is over the ${this.#maxMessageSize} byte limit`)
        }
        if (this.#blobQueue) {
            const copy = bytes.slice()
            this.#blobQueue = this.#blobQueue.then(() => this.#write(copy, text))
            return
        }
        this.#write(bytes, text)
    }

    #write(bytes, text) {
        if (this.#readyState !== "open") {
            return
        }
        // an empty buffer still has to be a valid pointer
        const buffer = bytes.length === 0 ? new Uint8Array(1) : bytes
        if (native.dwrtc_channel_send(this.#handle, buffer, bytes.length, text ? 1 : 0) !== 0) {
            throw new DOMException("RTCDataChannel.send: the channel is closed", "InvalidStateError")
        }
    }

    close() {
        if (this.#readyState === "closing" || this.#readyState === "closed") {
            return
        }
        this.#readyState = "closing"
        call({ op: "channelClose", dc: this.#handle })
    }

    /** @private the connection closed: closed without events, as in the browser */
    _connectionClosed() {
        this.#readyState = "closed"
        unregister(this.#handle)
    }

    /** @private */
    onNativeEvent(event, payload) {
        switch (event.t) {
            case "dc_id":
                this.#attributes.id = event.id
                break
            case "dc_open":
                if (this.#readyState === "connecting") {
                    this.#readyState = "open"
                    this.dispatchEvent(new Event("open"))
                }
                break
            case "dc_msg": {
                let data
                if (event.s) {
                    data = decoder.decode(payload)
                } else if (this.#binaryType === "blob") {
                    data = new Blob([payload])
                } else {
                    data = payload.buffer.byteLength === payload.length ? payload.buffer : payload.slice().buffer
                }
                this.dispatchEvent(new MessageEvent("message", { data }))
                break
            }
            case "dc_low":
                if (this.bufferedAmount <= this.#lowThreshold) {
                    this.dispatchEvent(new Event("bufferedamountlow"))
                }
                break
            case "dc_closing":
                if (this.#readyState !== "closed") {
                    this.#readyState = "closing"
                    this.dispatchEvent(new Event("closing"))
                }
                break
            case "dc_error":
                this.dispatchEvent(new RTCErrorEvent("error", { error: new RTCError({ errorDetail: "data-channel-failure" }, event.error) }))
                break
            case "dc_close":
                unregister(this.#handle)
                if (this.#readyState !== "closed") {
                    this.#readyState = "closed"
                    this.dispatchEvent(new Event("close"))
                }
                break
        }
    }
}

defineEventHandlers(RTCDataChannel, ["open", "message", "bufferedamountlow", "error", "closing", "close"])
