// The bridge to the native library: synchronous calls, awaited requests, and the event pump.

import { libraryPath } from "./library.js"

const ABI_VERSION = 1

const symbols = {
    dwrtc_abi_version: { parameters: [], result: "u32" },
    dwrtc_call: { parameters: ["buffer", "usize"], result: "u32" },
    dwrtc_result: { parameters: ["buffer", "usize"], result: "void" },
    dwrtc_request: { parameters: ["u32", "u32", "buffer", "usize"], result: "void" },
    dwrtc_wait: { parameters: ["u32", "i32"], result: "u32", nonblocking: true },
    dwrtc_wake: { parameters: ["u32"], result: "void" },
    dwrtc_next_size: { parameters: ["u32"], result: "u32" },
    dwrtc_next: { parameters: ["u32", "buffer", "usize"], result: "u32" },
    dwrtc_channel_send: { parameters: ["u32", "buffer", "usize", "u8"], result: "i32" },
    dwrtc_channel_buffered_amount: { parameters: ["u32"], result: "f64" },
    dwrtc_track_write_rtp: { parameters: ["u32", "buffer", "usize"], result: "i32" },
    dwrtc_track_write_sample: { parameters: ["u32", "buffer", "usize", "f64"], result: "i32" },
}

const library = Deno.dlopen(await libraryPath(), symbols)
export const native = library.symbols

if (native.dwrtc_abi_version() !== ABI_VERSION) {
    throw new Error(`deno-webrtc: the native library speaks ABI ${native.dwrtc_abi_version()}, this module needs ${ABI_VERSION}`)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const DOM_EXCEPTION_NAMES = new Set([
    "InvalidStateError",
    "InvalidAccessError",
    "InvalidModificationError",
    "NotSupportedError",
    "OperationError",
    "SyntaxError",
    "NotFoundError",
    "NetworkError",
    "DataError",
    "QuotaExceededError",
    "NotAllowedError",
])

/**
 * Turns the native side's "Name: message" into the error a browser would throw.
 * @param {string} text
 */
export function toError(text) {
    const separator = text.indexOf(": ")
    const name = separator > 0 ? text.slice(0, separator) : "OperationError"
    const message = separator > 0 ? text.slice(separator + 2) : text
    if (name === "TypeError") {
        return new TypeError(message)
    }
    if (name === "RangeError") {
        return new RangeError(message)
    }
    return new DOMException(message, DOM_EXCEPTION_NAMES.has(name) ? name : "OperationError")
}

/**
 * Runs a synchronous native operation.
 * @param {Record<string, unknown>} args
 */
export function call(args) {
    const input = encoder.encode(JSON.stringify(args))
    const length = native.dwrtc_call(input, input.length)
    const output = new Uint8Array(length)
    native.dwrtc_result(output, length)
    const result = JSON.parse(decoder.decode(output))
    if (!result.ok) {
        throw toError(result.error)
    }
    return result.v
}

export const context = call({ op: "contextNew" })

const pending = new Map()
let nextRequest = 1
/** handle -> { onNativeEvent(header, payload) } */
const targets = new Map()

/**
 * Starts an asynchronous native operation.
 * @param {Record<string, unknown>} args
 * @returns {Promise<any>}
 */
export function request(args) {
    const id = nextRequest++
    const input = encoder.encode(JSON.stringify(args))
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        retain()
        native.dwrtc_request(context, id, input, input.length)
    })
}

export function register(handle, target) {
    targets.set(handle, target)
}

export function unregister(handle) {
    targets.delete(handle)
}

let keepAlive = 0
let pumping = false

/** Something is open (a connection, a request): keep reading events, which keeps the process alive. */
export function retain() {
    keepAlive++
    if (!pumping) {
        pump()
    }
}

export function release() {
    keepAlive--
    if (keepAlive <= 0) {
        keepAlive = 0
        native.dwrtc_wake(context)
    }
}

let buffer = new Uint8Array(64 * 1024)

function drain() {
    for (;;) {
        const size = native.dwrtc_next_size(context)
        if (size === 0) {
            return
        }
        if (size > buffer.length) {
            buffer = new Uint8Array(Math.max(size, buffer.length * 2))
        }
        const length = native.dwrtc_next(context, buffer, buffer.length)
        if (length === 0) {
            return
        }
        const headerLength = new DataView(buffer.buffer).getUint32(0, true)
        const header = JSON.parse(decoder.decode(buffer.subarray(4, 4 + headerLength)))
        const payload = buffer.slice(4 + headerLength, length)
        dispatch(header, payload)
    }
}

function dispatch(header, payload) {
    if (header.t === "result") {
        const waiter = pending.get(header.id)
        if (!waiter) {
            return
        }
        pending.delete(header.id)
        release()
        if (header.ok) {
            waiter.resolve(header.v)
        } else {
            waiter.reject(toError(header.error))
        }
        return
    }
    const handle = header.pc ?? header.dc ?? header.track
    let target = targets.get(handle)
    if (target instanceof WeakRef) {
        target = target.deref()
    }
    if (target) {
        try {
            target.onNativeEvent(header, payload)
        } catch (error) {
            // what a browser does with an exception thrown by an event listener
            reportError(error)
        }
    }
}

async function pump() {
    pumping = true
    try {
        while (keepAlive > 0) {
            await native.dwrtc_wait(context, -1)
            drain()
        }
    } finally {
        pumping = false
    }
}
