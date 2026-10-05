//! The native half of deno-webrtc: webrtc-rs behind a small C ABI for `Deno.dlopen`.
//!
//! JS calls in with JSON (`dwrtc_call` for synchronous operations, `dwrtc_request` for ones it
//! awaits) or raw bytes (sends and media writes). Everything that happens on the Rust side comes
//! back as events on the caller's context queue, which JS waits on off-thread and then drains.

mod channel;
mod events;
mod handles;
mod media;
mod mux;
mod peer;
mod stats;

use handles::Object;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, UNIX_EPOCH};

/// Bumped whenever the JS side must change with this library.
const ABI_VERSION: u32 = 1;

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .thread_name("deno-webrtc")
        .enable_all()
        .build()
        .expect("starting the tokio runtime")
});

pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    &RUNTIME
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// # Safety
/// `pointer` must be valid for `length` bytes (or null).
unsafe fn bytes<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if pointer.is_null() || length == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(pointer, length) }
    }
}

fn guard<T>(fallback: T, body: impl FnOnce() -> T) -> T {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or(fallback)
}

fn handle_arg(args: &Value, key: &str) -> u32 {
    args.get(key).and_then(Value::as_u64).unwrap_or(0) as u32
}

fn context_arg(args: &Value) -> Result<Arc<events::EventQueue>, String> {
    events::context(handle_arg(args, "ctx")).ok_or_else(|| "InvalidStateError: unknown context".to_owned())
}

fn certificate_json(handle: u32, certificate: &rtc::peer_connection::certificate::RTCCertificate) -> Result<Value, String> {
    let provider = rtc::crypto::default_provider().map_err(|error| format!("OperationError: {error}"))?;
    let fingerprints = certificate
        .get_fingerprints(provider.crypto())
        .map_err(|error| format!("OperationError: {error}"))?
        .into_iter()
        .map(|fingerprint| json!({"algorithm": fingerprint.algorithm, "value": fingerprint.value}))
        .collect::<Vec<_>>();
    let expires = certificate.expires.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as f64;
    Ok(json!({"handle": handle, "expires": expires, "fingerprints": fingerprints}))
}

fn generate_certificate(args: &Value) -> Result<Value, String> {
    use rtc::crypto::SignatureScheme;
    use rtc::peer_connection::certificate::{CertificateParams, RTCCertificate};
    let name = args.get("name").and_then(Value::as_str).unwrap_or("ECDSA");
    let scheme = match name.to_ascii_uppercase().as_str() {
        "ECDSA" => match args.get("namedCurve").and_then(Value::as_str).unwrap_or("P-256") {
            "P-256" => SignatureScheme::EcdsaP256Sha256,
            "P-384" => SignatureScheme::EcdsaP384Sha384,
            curve => return Err(format!("NotSupportedError: curve {curve:?}")),
        },
        "ED25519" => SignatureScheme::Ed25519,
        _ => return Err(format!("NotSupportedError: {name:?} certificates (use ECDSA)")),
    };
    let provider = rtc::crypto::default_provider().map_err(|error| format!("OperationError: {error}"))?;
    let params = CertificateParams::new(vec!["WebRTC".to_owned()]).map_err(|error| format!("OperationError: {error}"))?;
    let certificate = RTCCertificate::generate(provider.crypto(), scheme, params).map_err(|error| format!("OperationError: {error}"))?;
    let handle = handles::reserve();
    let described = certificate_json(handle, &certificate)?;
    handles::insert(handle, Object::Certificate(Arc::new(certificate)));
    Ok(described)
}

fn call(args: &Value) -> Result<Value, String> {
    let op = args.get("op").and_then(Value::as_str).unwrap_or_default();
    match op {
        "contextNew" => Ok(json!(events::new_context())),
        "contextFree" => {
            events::free_context(handle_arg(args, "ctx"));
            Ok(Value::Null)
        }
        "logInit" => {
            let filter = args.get("filter").and_then(Value::as_str).unwrap_or("warn");
            let _ = env_logger::Builder::new().parse_filters(filter).try_init();
            Ok(Value::Null)
        }
        "peerNew" => {
            let events = context_arg(args)?;
            let configuration = serde_json::from_value(args.get("configuration").cloned().unwrap_or_default())
                .map_err(|error| format!("TypeError: RTCConfiguration: {error}"))?;
            let options = serde_json::from_value(args.get("options").cloned().unwrap_or_default())
                .map_err(|error| format!("TypeError: server options: {error}"))?;
            let handle = handles::reserve();
            let peer = peer::Peer::new(handle, events, configuration, options)?;
            handles::insert(handle, Object::Peer(peer));
            Ok(json!(handle))
        }
        "peerClose" => {
            if let Ok(peer) = handles::peer(handle_arg(args, "pc")) {
                peer.close();
            }
            Ok(Value::Null)
        }
        "peerWantRtp" => {
            let peer = handles::peer(handle_arg(args, "pc"))?;
            peer.want_rtp(handle_arg(args, "tr") as usize, args.get("wanted").and_then(Value::as_bool).unwrap_or(true));
            Ok(Value::Null)
        }
        "channelNew" => {
            let peer = handles::peer(handle_arg(args, "pc"))?;
            let label = args.get("label").and_then(Value::as_str).unwrap_or_default().to_owned();
            Ok(json!(peer.create_data_channel(label, args.get("init").unwrap_or(&Value::Null))?))
        }
        "channelClose" => {
            if let Ok(channel) = handles::channel(handle_arg(args, "dc")) {
                channel.close();
            }
            Ok(Value::Null)
        }
        "channelLowThreshold" => {
            let channel = handles::channel(handle_arg(args, "dc"))?;
            channel.set_low_threshold(args.get("value").and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32);
            Ok(Value::Null)
        }
        "trackNew" => {
            let events = context_arg(args)?;
            let init = serde_json::from_value(args.get("init").cloned().unwrap_or_default())
                .map_err(|error| format!("TypeError: track init: {error}"))?;
            let handle = handles::reserve();
            let track = media::LocalTrack::new(handle, events, init)?;
            let described = json!({"handle": handle, "id": track.id, "streamId": track.stream_id, "kind": media::kind_name(track.kind)});
            handles::insert(handle, Object::Track(track));
            Ok(described)
        }
        "trackEnabled" => {
            let track = handles::track(handle_arg(args, "track"))?;
            track.set_enabled(args.get("enabled").and_then(Value::as_bool).unwrap_or(true));
            Ok(Value::Null)
        }
        "muxNew" => {
            let port = args.get("port").and_then(Value::as_u64).unwrap_or(0).min(u16::MAX as u64) as u16;
            let addresses: Vec<String> = serde_json::from_value(args.get("addresses").cloned().unwrap_or(json!([]))).unwrap_or_default();
            let include_loopback = args.get("includeLoopback").and_then(Value::as_bool).unwrap_or(false);
            let mux = mux::UdpMux::new(port, &addresses, include_loopback)?;
            let handle = handles::reserve();
            let described = json!({"handle": handle, "port": mux.port, "addresses": mux.addresses()});
            handles::insert(handle, Object::Mux(mux));
            Ok(described)
        }
        "certificatePem" => {
            let certificate = handles::certificate(handle_arg(args, "cert"))?;
            certificate.serialize_pem().map(Value::String).map_err(|error| format!("OperationError: {error}"))
        }
        "certificateFromPem" => {
            let pem = args.get("pem").and_then(Value::as_str).unwrap_or_default();
            let provider = rtc::crypto::default_provider().map_err(|error| format!("OperationError: {error}"))?;
            let certificate = rtc::peer_connection::certificate::RTCCertificate::from_pem(pem, provider.crypto())
                .map_err(|error| format!("InvalidAccessError: {error}"))?;
            let handle = handles::reserve();
            let described = certificate_json(handle, &certificate)?;
            handles::insert(handle, Object::Certificate(Arc::new(certificate)));
            Ok(described)
        }
        "free" => {
            match handles::remove(handle_arg(args, "handle")) {
                Some(Object::Peer(peer)) => peer.close(),
                Some(Object::Channel(channel)) => channel.close(),
                _ => {}
            }
            Ok(Value::Null)
        }
        _ => Err(format!("NotSupportedError: unknown call {op:?}")),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn dwrtc_abi_version() -> u32 {
    ABI_VERSION
}

/// Runs a synchronous operation; returns the length of its JSON result (read with `dwrtc_result`).
///
/// # Safety
/// `pointer` must be valid for `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_call(pointer: *const u8, length: usize) -> u32 {
    let input = unsafe { bytes(pointer, length) };
    let output = guard(json!({"ok": false, "error": "OperationError: deno-webrtc panicked"}), || {
        match serde_json::from_slice::<Value>(input).map_err(|error| format!("TypeError: {error}")).and_then(|args| call(&args)) {
            Ok(value) => json!({"ok": true, "v": value}),
            Err(error) => json!({"ok": false, "error": error}),
        }
    });
    let output = serde_json::to_vec(&output).unwrap_or_default();
    let length = output.len() as u32;
    RESULT.with(|result| *result.borrow_mut() = output);
    length
}

/// Copies the last `dwrtc_call` result into `pointer` (which has room for `length` bytes).
///
/// # Safety
/// `pointer` must be valid for writes of `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_result(pointer: *mut u8, length: usize) {
    RESULT.with(|result| {
        let result = result.borrow();
        let count = result.len().min(length);
        if !pointer.is_null() {
            unsafe { std::ptr::copy_nonoverlapping(result.as_ptr(), pointer, count) };
        }
    });
}

/// Starts an asynchronous operation; its result arrives as a `result` event with this `id`.
///
/// # Safety
/// `pointer` must be valid for `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_request(context: u32, id: u32, pointer: *const u8, length: usize) {
    let input = unsafe { bytes(pointer, length) };
    guard((), || {
        let Some(events) = events::context(context) else { return };
        let respond = move |result: Result<Value, String>| match result {
            Ok(value) => events.emit(json!({"t": "result", "id": id, "ok": true, "v": value})),
            Err(error) => events.emit(json!({"t": "result", "id": id, "ok": false, "error": error})),
        };
        let args = match serde_json::from_slice::<Value>(input) {
            Ok(args) => args,
            Err(error) => return respond(Err(format!("TypeError: {error}"))),
        };
        let op = args.get("op").and_then(Value::as_str).unwrap_or_default().to_owned();
        if op == "generateCertificate" {
            runtime().spawn(async move {
                let result = tokio::task::spawn_blocking(move || generate_certificate(&args))
                    .await
                    .unwrap_or_else(|_| Err("OperationError: deno-webrtc panicked".to_owned()));
                respond(result);
            });
            return;
        }
        let peer = match handles::peer(handle_arg(&args, "pc")) {
            Ok(peer) => peer,
            Err(error) => return respond(Err(error)),
        };
        // queued now, on the JS thread, so operations keep the order JS issued them in
        let queued = peer.clone();
        peer.enqueue(async move {
            let task = runtime().spawn(async move { queued.request(&op, &args).await });
            respond(task.await.unwrap_or_else(|_| Err("OperationError: deno-webrtc panicked".to_owned())));
        });
    })
}

/// Blocks (call it nonblocking from JS) until the context has events, is woken, or `timeout_ms` passes.
#[unsafe(no_mangle)]
pub extern "C" fn dwrtc_wait(context: u32, timeout_ms: i32) -> u32 {
    guard(0, || events::context(context).map(|events| events.wait(timeout_ms)).unwrap_or(0))
}

#[unsafe(no_mangle)]
pub extern "C" fn dwrtc_wake(context: u32) {
    guard((), || {
        if let Some(events) = events::context(context) {
            events.wake();
        }
    })
}

/// The size of the next event, 0 if there is none.
#[unsafe(no_mangle)]
pub extern "C" fn dwrtc_next_size(context: u32) -> u32 {
    guard(0, || events::context(context).map(|events| events.next_size()).unwrap_or(0))
}

/// Pops the next event into `pointer` (sized with `dwrtc_next_size`); returns its length.
///
/// # Safety
/// `pointer` must be valid for writes of `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_next(context: u32, pointer: *mut u8, length: usize) -> u32 {
    guard(0, || {
        let Some(events) = events::context(context) else { return 0 };
        if events.next_size() as usize > length || pointer.is_null() {
            return 0;
        }
        let Some(event) = events.pop() else { return 0 };
        unsafe { std::ptr::copy_nonoverlapping(event.as_ptr(), pointer, event.len()) };
        event.len() as u32
    })
}

/// Queues a message on a data channel: 0 when queued, -1 when the channel is gone or closed.
///
/// # Safety
/// `pointer` must be valid for `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_channel_send(channel: u32, pointer: *const u8, length: usize, text: u8) -> i32 {
    let data = unsafe { bytes(pointer, length) };
    guard(-1, || match handles::channel(channel) {
        Ok(channel) if channel.send(data, text != 0) => 0,
        _ => -1,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn dwrtc_channel_buffered_amount(channel: u32) -> f64 {
    guard(0.0, || handles::channel(channel).map(|channel| channel.buffered_amount() as f64).unwrap_or(0.0))
}

/// Sends one RTP packet on a local track (its SSRC and payload type are replaced with the negotiated ones).
///
/// # Safety
/// `pointer` must be valid for `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_track_write_rtp(track: u32, pointer: *const u8, length: usize) -> i32 {
    let data = unsafe { bytes(pointer, length) };
    guard(-1, || match handles::track(track) {
        Ok(track) if track.write_rtp(data) => 0,
        _ => -1,
    })
}

/// Packetizes and sends one encoded frame lasting `duration_us` microseconds.
///
/// # Safety
/// `pointer` must be valid for `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dwrtc_track_write_sample(track: u32, pointer: *const u8, length: usize, duration_us: f64) -> i32 {
    let data = unsafe { bytes(pointer, length) };
    let duration = Duration::from_micros(duration_us.max(0.0) as u64);
    guard(-1, || match handles::track(track) {
        Ok(track) if track.write_sample(data, duration) => 0,
        _ => -1,
    })
}
