# deno-webrtc

The browser's WebRTC API (`RTCPeerConnection`, `RTCDataChannel`, ...) for Deno, built on
[webrtc-rs](https://github.com/webrtc-rs/webrtc) and called through `Deno.dlopen`. It also has
what a server needs and a browser doesn't: fixed ports, one shared UDP port, a 1:1 NAT address,
ICE-lite, and sending/receiving already-encoded media and raw RTP.

```js
import { RTCPeerConnection } from "https://raw.githubusercontent.com/jeff-hykin/deno-webrtc/v0.1.0/mod.js"
```

On first use the module downloads the native library for your OS/CPU from this repository's
GitHub release, checks it against the sha256 stored in the module, and caches it
(`~/Library/Caches/deno-webrtc`, `~/.cache/deno-webrtc`, or `%LOCALAPPDATA%\deno-webrtc`).
After that, no network access is needed.

Permissions: `--allow-ffi --allow-env --allow-read --allow-write --allow-net` (`-A` works too).
`--allow-write` and `--allow-net` are used only for that first download.

| Platform | Library |
|---|---|
| Linux x86_64 (glibc ≥ 2.28) | `libdeno_webrtc-linux-x86_64.so` |
| Linux aarch64 (glibc ≥ 2.28) | `libdeno_webrtc-linux-aarch64.so` |
| macOS Apple silicon (11+) | `libdeno_webrtc-darwin-aarch64.dylib` |
| macOS Intel (11+) | `libdeno_webrtc-darwin-x86_64.dylib` |
| Windows x86_64 | `deno_webrtc-windows-x86_64.dll` |

`DENO_WEBRTC_LIB=/path/to/library` uses a library you built instead of downloading one, and
`DENO_WEBRTC_CACHE` changes the cache directory.

## Example: a server answering a browser

The browser makes an offer and POSTs it. Deno answers with every candidate already in the
answer, so no further signaling is needed.

```js
// server.js: deno run -A server.js
import { RTCPeerConnection } from "https://raw.githubusercontent.com/jeff-hykin/deno-webrtc/v0.1.0/mod.js"

Deno.serve({ port: 8000 }, async (request) => {
    if (request.method !== "POST") {
        return new Response(PAGE, { headers: { "content-type": "text/html" } })
    }
    const pc = new RTCPeerConnection(
        { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
        // non-standard: listen on a known port range
        { portRange: { min: 50000, max: 50100 } },
    )
    pc.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => channel.send(`echo: ${data}`)
    }
    pc.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(pc.connectionState)) {
            pc.close()
        }
    }
    await pc.setRemoteDescription(await request.json())
    await pc.setLocalDescription()
    await new Promise((resolve) => {
        pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve()
    })
    return Response.json(pc.localDescription)
})

const PAGE = `<script type="module">
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] })
    const channel = pc.createDataChannel("chat")
    channel.onopen = () => channel.send("hi")
    channel.onmessage = ({ data }) => document.body.append(data)
    await pc.setLocalDescription()
    const answer = await fetch("/", { method: "POST", body: JSON.stringify(pc.localDescription) })
    await pc.setRemoteDescription(await answer.json())
</script>`
```

The same code works on the other end too: Deno to Deno, Deno to browser, or a browser to Deno.
[`examples/loopback.js`](examples/loopback.js) connects two connections in one process.

## Media

There is no camera, microphone, or codec here. You bring encoded media and it goes over the wire
(SRTP, NACK, RTCP reports included), or you receive the RTP packets and decode them yourself.

```js
import { RTCPeerConnection, nonstandard } from ".../mod.js"

// sending: whole encoded frames (packetized for you) or finished RTP packets
const track = new nonstandard.RtpTrack({ kind: "video", mimeType: "video/H264" })
pc.addTrack(track)
track.writeSample(h264AnnexBFrame, { duration: 33 }) // milliseconds
track.writeRtp(rtpPacketBytes) // SSRC and payload type become the negotiated ones
track.onkeyframerequest = () => encoder.forceKeyframe() // the receiver sent a PLI/FIR

// receiving: every RTP packet of a remote track
pc.ontrack = ({ track, streams }) => {
    track.onrtp = ({ data }) => depacketizeAndDecode(data) // data: Uint8Array, header included
}
```

The codecs are the ones browsers use: Opus, G.722, PCMU/PCMA, VP8, VP9, H.264, AV1 and H.265.
`mimeType` picks one. `clockRate`, `channels` and `sdpFmtpLine` are filled in for the common
ones and can be overridden.

## Server options

These are non-standard, so they go in a second argument to the constructor:
`new RTCPeerConnection(configuration, serverOptions)`.

| Option | What it does |
|---|---|
| `portRange: { min, max }` | Takes each connection's UDP port from this range. |
| `udpMux: new nonstandard.UdpMux({ port })` | All connections share **one** UDP port (on each local address). The first STUN request's ICE username decides which connection a remote address belongs to. |
| `nat1to1Ips: ["203.0.113.7"]` | Advertises this public IP, e.g. on a cloud VM behind 1:1 NAT. With several addresses, write `"public/private"` pairs (`"203.0.113.7/10.0.0.5"`). |
| `nat1to1CandidateType: "host"` or `"srflx"` | `"host"` (the default) replaces the private address. `"srflx"` keeps it and adds the public one. |
| `bindAddresses: ["0.0.0.0"]` | Addresses to listen on. A wildcard expands to every interface. |
| `interfaces: ["eth0"]` | Only use these network interfaces. |
| `includeLoopback: true` | Also offers 127.0.0.1 (for same-machine peers, CI). |
| `tcpPort: 0` | Also accepts ICE over TCP (passive), for networks that block UDP. |
| `iceLite: true` | ICE-lite: only answers connectivity checks. Suits a server with a public IP. |
| `mdns: "disabled"` or `"query"` or `"gather"` | Resolving peers' `.local` candidates (`"query"`, the default), turning that off, or also hiding behind a `.local` name. |
| `maxMessageSize: 262144` | The largest data channel message, in bytes. |
| `iceTimeouts: { disconnected, failed, keepAlive }` | ICE timers, in milliseconds. |

TURN and STUN are configured as in a browser:
`{ iceServers: [{ urls: "turn:turn.example.com:3478", username, credential }] }`. Set
`iceTransportPolicy: "relay"` to use only TURN.

Other extras, all under `nonstandard` (and also exported by name):

- `RTCCertificate.prototype.toPEM()` and `RTCCertificate.fromPEM(pem)` keep a server's DTLS fingerprint across restarts.
- `nonstandard.setLogLevel("debug")` turns on the native library's logs (env_logger syntax, to stderr).
- `nonstandard.installGlobals()` puts `RTCPeerConnection` and the rest on `globalThis`, for libraries that expect a browser.

## Where it differs from the browser

- **Media sources:** there is no `getUserMedia`. You send media with `nonstandard.RtpTrack`. A remote `MediaStreamTrack` has no decoded frames; it has `rtp` events instead.
- **One connection per RtpTrack:** a track can be sent on one connection at a time. For fan-out, make one `RtpTrack` per connection and write to each.
- **`MediaStreamTrack.clone()`, `RTCRtpSender.setParameters()`, `setStreams()` and `RTCRtpTransceiver.setCodecPreferences()`** throw `NotSupportedError`. `getParameters()` returns a minimal object.
- **`replaceTrack(null)`** stops sending, but the old track stays attached in the SDP.
- **`setConfiguration()`** accepts only the configuration the connection already has (anything else is `NotSupportedError`).
- **`rollback`** descriptions are not supported.
- **Certificates:** `generateCertificate` makes ECDSA (P-256 or P-384) and Ed25519 keys, not RSA.
- **`RTCSctpTransport` / `RTCDtlsTransport` / `RTCIceTransport`:** `pc.sctp` is a plain object with `state` and `maxMessageSize`. `sender.transport` and `receiver.transport` are `null`.
- **Identity** (`peerIdentity`, `getIdentityAssertion`) is not implemented.
- **Getting stats:** `getStats()` returns every entry the webrtc-rs stack has (the W3C dictionaries). A track selector filters them to `inbound-rtp` or `outbound-rtp`.
- **Process lifetime:** an open `RTCPeerConnection` keeps Deno running (like an open socket) until you `close()` it.

## How it works

`src/` is a Rust `cdylib` around webrtc-rs. JS calls it with JSON for most operations and with raw
bytes for data channel sends and media writes. Each connection runs its operations one at a time,
in the order JS issued them. Everything that happens on the Rust side (candidates, state changes,
messages, RTP) goes into a per-context queue. JS waits for that queue with a `nonblocking` FFI
call, so it waits off the main thread, then drains it and dispatches DOM events. Each Worker gets
its own queue.

`vendor/webrtc` is Jeff Hykin's fork of webrtc-rs 0.21 (`zenoh-web-webrtc`, with SCTP and data
channel fixes) plus one addition, `PeerConnectionBuilder::with_udp_sockets`, which `UdpMux` needs.
See `vendor/webrtc/PATCHES.md`.

## Development

```sh
cargo build --release   # the module uses target/release when run from a checkout
deno task test          # Deno<->Deno and headless-Chrome interop tests
```

CI (`.github/workflows/ci.yml`) builds the library on all five platforms (Linux in a
manylinux_2_28 container) and runs the tests against those exact binaries. The **release**
workflow (run it from the Actions tab with a version) does the same, then commits the binaries'
sha256 and the version, tags `vX.Y.Z`, attaches the binaries to that release, and imports the
released module by URL on every platform to check that it downloads and connects.

License: MIT OR Apache-2.0.
