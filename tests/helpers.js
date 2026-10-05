import { RTCPeerConnection } from "../mod.js"

/** Deno.test options: the native event pump is an FFI call that outlives a single test. */
export const options = { sanitizeOps: false, sanitizeResources: false }

/**
 * Resolves with the first `type` event on `target`, or rejects after `ms`.
 * @template T
 * @returns {Promise<T>}
 */
export function nextEvent(target, type, ms = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} event within ${ms} ms`)), ms)
        target.addEventListener(type, (event) => {
            clearTimeout(timer)
            resolve(event)
        }, { once: true })
    })
}

/** Rejects if `promise` takes longer than `ms`. */
export function within(promise, ms, what) {
    let timer
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms)
        }),
    ])
}

/** Trickles candidates between `a` and `b` and runs one offer/answer, `a` offering. */
export async function negotiate(a, b) {
    a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate).catch(() => {})
    b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate).catch(() => {})
    await a.setLocalDescription()
    await b.setRemoteDescription(a.localDescription)
    await b.setLocalDescription()
    await a.setRemoteDescription(b.localDescription)
}

export function pair(configuration = {}, optionsA = {}, optionsB = optionsA) {
    return [new RTCPeerConnection(configuration, optionsA), new RTCPeerConnection(configuration, optionsB)]
}

export function waitForState(pc, state, ms = 15000) {
    if (pc.connectionState === state) {
        return Promise.resolve()
    }
    return within(
        new Promise((resolve) => {
            const listener = () => {
                if (pc.connectionState === state) {
                    pc.removeEventListener("connectionstatechange", listener)
                    resolve()
                }
            }
            pc.addEventListener("connectionstatechange", listener)
        }),
        ms,
        `reaching connectionState ${state}`,
    )
}

/** The channel's open, as a promise (already open counts). */
export function opened(channel, ms = 15000) {
    if (channel.readyState === "open") {
        return Promise.resolve(channel)
    }
    return nextEvent(channel, "open", ms).then(() => channel)
}

export async function sha256(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
