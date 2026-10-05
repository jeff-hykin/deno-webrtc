// deno-webrtc: the browser's WebRTC API for Deno, on webrtc-rs through FFI.

import { call } from "./js/ffi.js"
import { RTCPeerConnection } from "./js/peer_connection.js"
import { RTCDataChannel } from "./js/data_channel.js"
import { RTCCertificate, RTCIceCandidate, RTCSessionDescription, RTCStatsReport } from "./js/dictionaries.js"
import {
    MediaStreamTrackEvent,
    RTCDataChannelEvent,
    RTCError,
    RTCErrorEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCPeerConnectionIceEvent,
    RTCRtpPacketEvent,
    RTCTrackEvent,
} from "./js/events.js"
import { MediaStream, MediaStreamTrack, RTCRtpReceiver, RTCRtpSender, RTCRtpTransceiver, RtpTrack } from "./js/media.js"
import { UdpMux } from "./js/mux.js"
import { VERSION } from "./js/version.js"

/**
 * Turns on the native library's logging (to stderr), e.g. `"debug"` or `"webrtc=trace,warn"`.
 * Only the first call takes effect.
 * @param {string} filter env_logger syntax
 */
function setLogLevel(filter) {
    call({ op: "logInit", filter })
}

const standard = {
    RTCPeerConnection,
    RTCDataChannel,
    RTCSessionDescription,
    RTCIceCandidate,
    RTCCertificate,
    RTCStatsReport,
    RTCRtpSender,
    RTCRtpReceiver,
    RTCRtpTransceiver,
    RTCPeerConnectionIceEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCDataChannelEvent,
    RTCTrackEvent,
    RTCError,
    RTCErrorEvent,
    MediaStream,
    MediaStreamTrack,
    MediaStreamTrackEvent,
}

/** Puts the standard classes on `globalThis`, for libraries that expect a browser. */
function installGlobals() {
    Object.assign(globalThis, standard)
}

/** What a browser doesn't have: media you encode yourself, a shared UDP port, logging. */
export const nonstandard = { RtpTrack, UdpMux, RTCRtpPacketEvent, setLogLevel, installGlobals, VERSION }

export {
    MediaStream,
    MediaStreamTrack,
    MediaStreamTrackEvent,
    RTCCertificate,
    RTCDataChannel,
    RTCDataChannelEvent,
    RTCError,
    RTCErrorEvent,
    RTCIceCandidate,
    RTCPeerConnection,
    RTCPeerConnectionIceErrorEvent,
    RTCPeerConnectionIceEvent,
    RTCRtpPacketEvent,
    RTCRtpReceiver,
    RTCRtpSender,
    RTCRtpTransceiver,
    RTCSessionDescription,
    RTCStatsReport,
    RTCTrackEvent,
    RtpTrack,
    UdpMux,
    installGlobals,
    setLogLevel,
}
