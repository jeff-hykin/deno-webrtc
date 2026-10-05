//! RTCPeerConnection: configuration, the event handler, and the operations JS awaits.

use crate::channel::Channel;
use crate::events::EventQueue;
use crate::handles;
use crate::media::{LocalTrack, kind_name, parse_kind};
use rtc::data_channel::RTCDataChannelInit;
use rtc::peer_connection::configuration::RTCIceTransportPolicy;
use rtc::peer_connection::configuration::setting_engine::SctpMaxMessageSize;
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use rtc::shared::marshal::Marshal;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use webrtc::data_channel::DataChannel;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCBundlePolicy,
    RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceConnectionState, RTCIceGatheringState, RTCIceServer,
    RTCPeerConnectionIceErrorEvent, RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription,
    RTCSignalingState, Registry, SettingEngineBuilder, StatsSelector, register_default_interceptors,
};
use webrtc::rtp_transceiver::RtpTransceiver;

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// The standard RTCConfiguration (JS has already normalized it).
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Configuration {
    pub ice_servers: Vec<IceServer>,
    pub ice_transport_policy: Option<String>,
    pub bundle_policy: Option<String>,
    pub certificates: Vec<u32>,
    pub ice_candidate_pool_size: Option<u8>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortRange {
    pub min: u16,
    pub max: u16,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IceTimeouts {
    pub disconnected: Option<u64>,
    pub failed: Option<u64>,
    pub keep_alive: Option<u64>,
}

/// The non-standard second constructor argument: what a server needs that a browser decides for itself.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerOptions {
    /// addresses to listen on; default `["0.0.0.0"]`
    pub bind_addresses: Vec<String>,
    /// only use these network interfaces (by name, e.g. "eth0")
    pub interfaces: Option<Vec<String>>,
    /// pick each connection's UDP port from this range
    pub port_range: Option<PortRange>,
    /// every connection shares this one UDP port (a `UdpMux` handle)
    pub udp_mux: Option<u32>,
    /// also listen for ICE-TCP on this port (0: any)
    pub tcp_port: Option<u16>,
    /// advertise these public IPs (1:1 NAT, e.g. a cloud VM's public address)
    pub nat1to1_ips: Vec<String>,
    /// "host" (replace the private address) or "srflx" (advertise both)
    pub nat1to1_candidate_type: Option<String>,
    pub include_loopback: bool,
    pub ice_lite: bool,
    /// "disabled", "query" (default: resolve .local candidates) or "gather"
    pub mdns: Option<String>,
    pub max_message_size: Option<u32>,
    pub ice_timeouts: Option<IceTimeouts>,
}

type Connection = Option<Result<Arc<dyn PeerConnection>, String>>;

/// 1:1 NAT: advertise a public address for host candidates (webrtc-rs keeps the setting but never applies it).
#[derive(Clone, Default)]
pub struct Nat {
    /// (public, the private address it maps; None: every private address)
    mappings: Vec<(String, Option<IpAddr>)>,
    /// keep the host candidate and add a server-reflexive one, rather than replacing it
    as_srflx: bool,
}

impl Nat {
    fn new(options: &ServerOptions) -> Nat {
        let mappings = options
            .nat1to1_ips
            .iter()
            .map(|entry| match entry.split_once('/') {
                Some((public, private)) => (public.to_owned(), private.parse().ok()),
                None => (entry.clone(), None),
            })
            .collect();
        Nat { mappings, as_srflx: options.nat1to1_candidate_type.as_deref() == Some("srflx") }
    }

    /// The candidate lines to advertise in place of `candidate` ("candidate:..." without "a=").
    fn rewrite(&self, candidate: &str) -> Vec<String> {
        let fields: Vec<&str> = candidate.split_whitespace().collect();
        if self.mappings.is_empty() || fields.len() < 8 || fields[7] != "host" {
            return vec![candidate.to_owned()];
        }
        let Ok(address) = fields[4].parse::<IpAddr>() else { return vec![candidate.to_owned()] };
        if address.is_loopback() {
            return vec![candidate.to_owned()];
        }
        let public = self
            .mappings
            .iter()
            .find(|(_, private)| *private == Some(address))
            .or_else(|| self.mappings.iter().find(|(public, private)| private.is_none() && public.parse::<IpAddr>().map(|ip| ip.is_ipv4() == address.is_ipv4()).unwrap_or(true)))
            .map(|(public, _)| public.clone());
        let Some(public) = public else { return vec![candidate.to_owned()] };
        if self.as_srflx {
            let priority = fields[3].parse::<u32>().unwrap_or(0) & 0x00ff_ffff | (100 << 24);
            let srflx = format!(
                "{}1 {} {} {} {} {} typ srflx raddr {} rport {}",
                fields[0], fields[1], fields[2], priority, public, fields[5], fields[4], fields[5]
            );
            vec![candidate.to_owned(), srflx]
        } else {
            let mut fields: Vec<String> = fields.iter().map(|field| field.to_string()).collect();
            fields[4] = public;
            vec![fields.join(" ")]
        }
    }

    fn rewrite_sdp(&self, description: Value) -> Value {
        let Some(sdp) = description.get("sdp").and_then(Value::as_str) else { return description };
        if self.mappings.is_empty() {
            return description;
        }
        let mut lines = Vec::new();
        for line in sdp.split("\r\n") {
            match line.strip_prefix("a=") {
                Some(candidate) if candidate.starts_with("candidate:") => {
                    lines.extend(self.rewrite(candidate).into_iter().map(|candidate| format!("a={candidate}")))
                }
                _ => lines.push(line.to_owned()),
            }
        }
        let mut description = description;
        description["sdp"] = Value::String(lines.join("\r\n"));
        description
    }
}

type Job = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

pub struct Peer {
    pub handle: u32,
    /// operations run one at a time, in the order JS issued them
    jobs: tokio::sync::mpsc::UnboundedSender<Job>,
    pub events: Arc<EventQueue>,
    connection: watch::Receiver<Connection>,
    pub tracks: Mutex<Vec<Arc<LocalTrack>>>,
    /// transceivers whose received RTP JS wants
    rtp_wanted: Arc<Mutex<HashSet<usize>>>,
    port: Mutex<Option<u16>>,
    closed: AtomicBool,
    nat: Nat,
}

static PORTS_IN_USE: LazyLock<Mutex<HashSet<u16>>> = LazyLock::new(Default::default);

fn reserve_port(range: &PortRange) -> Result<u16, String> {
    let mut in_use = PORTS_IN_USE.lock().unwrap();
    for port in range.min..=range.max {
        if !in_use.contains(&port) && std::net::UdpSocket::bind(("0.0.0.0", port)).is_ok() {
            in_use.insert(port);
            return Ok(port);
        }
    }
    Err(format!("OperationError: no free UDP port in {}-{}", range.min, range.max))
}

fn error_text(error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    // already "Name: message"
    if text.split(':').next().is_some_and(|name| name.ends_with("Error") && !name.contains(' ')) {
        text
    } else {
        format!("OperationError: {text}")
    }
}

fn bind_addresses(options: &ServerOptions, port: u16) -> Result<Vec<String>, String> {
    let mut hosts: Vec<String> = if options.bind_addresses.is_empty() {
        vec!["0.0.0.0".to_owned()]
    } else {
        options.bind_addresses.clone()
    };
    if let Some(names) = &options.interfaces {
        let interfaces = rtc::shared::ifaces::ifaces().map_err(|error| format!("OperationError: listing interfaces: {error}"))?;
        hosts = interfaces
            .into_iter()
            .filter(|interface| names.iter().any(|name| name == &interface.name))
            .filter_map(|interface| interface.addr.map(|addr| addr.ip()))
            .filter(|ip| ip.is_ipv4() && !ip.is_unspecified() && (options.include_loopback || !ip.is_loopback()))
            .map(|ip| ip.to_string())
            .collect();
        if hosts.is_empty() {
            return Err(format!("OperationError: no IPv4 address on interfaces {names:?}"));
        }
    }
    if options.include_loopback && !hosts.iter().any(|host| host.starts_with("127.")) {
        hosts.push("127.0.0.1".to_owned());
    }
    Ok(hosts
        .into_iter()
        .map(|host| match host.parse::<IpAddr>() {
            Ok(IpAddr::V6(ip)) => format!("[{ip}]:{port}"),
            _ => format!("{host}:{port}"),
        })
        .collect())
}

struct Handler {
    handle: u32,
    nat: Nat,
    events: Arc<EventQueue>,
    connection: watch::Receiver<Connection>,
    rtp_wanted: Arc<Mutex<HashSet<usize>>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_negotiation_needed(&self) {
        self.events.emit(json!({"t": "pc_negotiationneeded", "pc": self.handle}));
    }

    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let Ok(candidate) = event.candidate.to_json() else { return };
        for advertised in self.nat.rewrite(&candidate.candidate) {
            let mut candidate = candidate.clone();
            candidate.candidate = advertised;
            self.events.emit(json!({"t": "pc_icecandidate", "pc": self.handle, "candidate": candidate, "url": event.url}));
        }
    }

    async fn on_ice_candidate_error(&self, event: RTCPeerConnectionIceErrorEvent) {
        self.events.emit(json!({
            "t": "pc_icecandidateerror",
            "pc": self.handle,
            "address": event.address,
            "port": event.port,
            "url": event.url,
            "errorCode": event.error_code,
            "errorText": event.error_text,
        }));
    }

    async fn on_signaling_state_change(&self, state: RTCSignalingState) {
        self.events.emit(json!({"t": "pc_signalingstate", "pc": self.handle, "state": state.to_string()}));
    }

    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        self.events.emit(json!({"t": "pc_iceconnectionstate", "pc": self.handle, "state": state.to_string()}));
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        self.events.emit(json!({"t": "pc_icegatheringstate", "pc": self.handle, "state": state.to_string()}));
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        self.events.emit(json!({"t": "pc_connectionstate", "pc": self.handle, "state": state.to_string()}));
    }

    async fn on_data_channel(&self, data_channel: Arc<dyn DataChannel>) {
        let handle = handles::reserve();
        Channel::start(
            handle,
            self.events.clone(),
            async move { Ok(data_channel) },
            Some(json!({"t": "pc_datachannel", "pc": self.handle, "dc": handle})),
        );
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        // the driver waits for this to return, and finding the transceiver asks the driver
        crate::runtime().spawn(forward_track(
            self.handle,
            self.events.clone(),
            self.connection.clone(),
            self.rtp_wanted.clone(),
            track,
        ));
    }
}

async fn wait_connection(mut connection: watch::Receiver<Connection>) -> Result<Arc<dyn PeerConnection>, String> {
    loop {
        if let Some(result) = &*connection.borrow() {
            return result.clone();
        }
        connection
            .changed()
            .await
            .map_err(|_| "InvalidStateError: the connection failed to start".to_owned())?;
    }
}

/// Forwards a remote track's RTP (when JS wants it) and its lifecycle, tagged with its transceiver.
async fn forward_track(
    handle: u32,
    events: Arc<EventQueue>,
    connection: watch::Receiver<Connection>,
    rtp_wanted: Arc<Mutex<HashSet<usize>>>,
    track: Arc<dyn TrackRemote>,
) {
    let Ok(connection) = wait_connection(connection).await else { return };
    let same = |other: &Arc<dyn TrackRemote>| std::ptr::addr_eq(Arc::as_ptr(other), Arc::as_ptr(&track));
    let mut transceiver_id = None;
    for _ in 0..100 {
        for transceiver in connection.get_transceivers().await {
            if let Ok(Some(receiver)) = transceiver.receiver().await
                && same(receiver.track())
            {
                transceiver_id = Some(transceiver.id());
            }
        }
        if transceiver_id.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let Some(transceiver_id) = transceiver_id else {
        log::warn!("deno-webrtc: a remote track arrived on no known transceiver");
        return;
    };
    events.emit(json!({"t": "track_open", "pc": handle, "tr": transceiver_id}));
    while let Some(event) = track.poll().await {
        match event {
            TrackRemoteEvent::OnRtpPacket(packet) => {
                if !rtp_wanted.lock().unwrap().contains(&transceiver_id) {
                    continue;
                }
                if let Ok(bytes) = packet.marshal() {
                    events.emit_with(json!({"t": "track_rtp", "pc": handle, "tr": transceiver_id}), &bytes);
                }
            }
            TrackRemoteEvent::OnMute => events.emit(json!({"t": "track_mute", "pc": handle, "tr": transceiver_id})),
            TrackRemoteEvent::OnUnmute => events.emit(json!({"t": "track_unmute", "pc": handle, "tr": transceiver_id})),
            TrackRemoteEvent::OnEnded => break,
            _ => {}
        }
    }
    events.emit(json!({"t": "track_ended", "pc": handle, "tr": transceiver_id}));
}

fn description_json(description: Option<RTCSessionDescription>) -> Value {
    match description {
        Some(description) => json!({"type": description.sdp_type.to_string(), "sdp": description.sdp}),
        None => Value::Null,
    }
}

/// Browsers announce trickle ICE in every offer and answer; webrtc-rs trickles but doesn't say so.
fn with_trickle(mut description: Value) -> Value {
    if let Some(sdp) = description.get("sdp").and_then(Value::as_str)
        && !sdp.contains("a=ice-options:")
        && let Some(timing) = sdp.find("\r\nt=")
    {
        let line_end = sdp[timing + 2..].find("\r\n").map(|end| timing + 2 + end + 2).unwrap_or(sdp.len());
        let sdp = format!("{}a=ice-options:trickle\r\n{}", &sdp[..line_end], &sdp[line_end..]);
        description["sdp"] = Value::String(sdp);
    }
    description
}

fn parse_description(value: &Value) -> Result<RTCSessionDescription, String> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let sdp = value.get("sdp").and_then(Value::as_str).unwrap_or_default().to_owned();
    let result = match kind {
        "offer" => RTCSessionDescription::offer(sdp),
        "answer" => RTCSessionDescription::answer(sdp),
        "pranswer" => RTCSessionDescription::pranswer(sdp),
        "rollback" => return Err("NotSupportedError: rollback is not supported".to_owned()),
        _ => return Err(format!("TypeError: {kind:?} is not a valid RTCSdpType")),
    };
    result.map_err(|error| format!("InvalidAccessError: {error}"))
}

fn parse_direction(direction: Option<&str>) -> Result<RTCRtpTransceiverDirection, String> {
    let direction = direction.unwrap_or("sendrecv");
    match RTCRtpTransceiverDirection::from(direction) {
        RTCRtpTransceiverDirection::Unspecified => Err(format!("TypeError: {direction:?} is not a valid RTCRtpTransceiverDirection")),
        parsed => Ok(parsed),
    }
}

impl Peer {
    pub fn new(handle: u32, events: Arc<EventQueue>, configuration: Configuration, options: ServerOptions) -> Result<Arc<Peer>, String> {
        for server in &configuration.ice_servers {
            for url in &server.urls {
                let scheme = url.split(':').next().unwrap_or_default();
                if !["stun", "stuns", "turn", "turns"].contains(&scheme) {
                    return Err(format!("SyntaxError: {url:?} is not a stun:, stuns:, turn: or turns: URL"));
                }
                if scheme.starts_with("turn") && (server.username.is_none() || server.credential.is_none()) {
                    return Err(format!("InvalidAccessError: {url:?} needs a username and credential"));
                }
            }
        }
        let mut certificates = Vec::new();
        for certificate in &configuration.certificates {
            certificates.push((*handles::certificate(*certificate)?).clone());
        }
        let port = match (&options.port_range, options.udp_mux) {
            (Some(range), None) => Some(reserve_port(range)?),
            _ => None,
        };
        let (connection_tx, connection) = watch::channel(None);
        let rtp_wanted = Arc::new(Mutex::new(HashSet::new()));
        let (jobs, mut jobs_rx) = tokio::sync::mpsc::unbounded_channel::<Job>();
        crate::runtime().spawn(async move {
            while let Some(job) = jobs_rx.recv().await {
                job.await;
            }
        });
        let peer = Arc::new(Peer {
            handle,
            jobs,
            events: events.clone(),
            connection: connection.clone(),
            tracks: Mutex::new(Vec::new()),
            rtp_wanted: rtp_wanted.clone(),
            port: Mutex::new(port),
            closed: AtomicBool::new(false),
            nat: Nat::new(&options),
        });
        let handler = Arc::new(Handler { handle, nat: Nat::new(&options), events, connection, rtp_wanted });
        crate::runtime().spawn(async move {
            let result = build(configuration, certificates, options, port.unwrap_or(0), handler)
                .await
                .map(|connection| Arc::new(connection) as Arc<dyn PeerConnection>);
            let _ = connection_tx.send(Some(result));
        });
        Ok(peer)
    }

    pub async fn connection(&self) -> Result<Arc<dyn PeerConnection>, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("InvalidStateError: the RTCPeerConnection is closed".to_owned());
        }
        wait_connection(self.connection.clone()).await
    }

    /// Queues `job` behind every operation issued before it.
    pub fn enqueue(&self, job: impl std::future::Future<Output = ()> + Send + 'static) {
        let _ = self.jobs.send(Box::pin(job));
    }

    pub fn want_rtp(&self, transceiver: usize, wanted: bool) {
        let mut set = self.rtp_wanted.lock().unwrap();
        if wanted {
            set.insert(transceiver);
        } else {
            set.remove(&transceiver);
        }
    }

    fn renegotiated(&self) {
        for track in self.tracks.lock().unwrap().iter() {
            track.renegotiated();
        }
    }

    /// What JS mirrors after every negotiation step: descriptions and transceivers.
    pub async fn snapshot(&self) -> Result<Value, String> {
        let connection = self.connection().await?;
        let pending_local = connection.pending_local_description().await;
        let pending_remote = connection.pending_remote_description().await;
        let signaling_state = match (&pending_local, &pending_remote) {
            (Some(local), _) if local.sdp_type.to_string() == "offer" => "have-local-offer",
            (Some(_), _) => "have-local-pranswer",
            (_, Some(remote)) if remote.sdp_type.to_string() == "offer" => "have-remote-offer",
            (_, Some(_)) => "have-remote-pranswer",
            _ => "stable",
        };
        let mut transceivers = Vec::new();
        let tracks = self.tracks.lock().unwrap().clone();
        for transceiver in connection.get_transceivers().await {
            transceivers.push(describe_transceiver(&transceiver, &tracks).await);
        }
        Ok(json!({
            "localDescription": self.nat.rewrite_sdp(with_trickle(description_json(connection.local_description().await))),
            "currentLocalDescription": self.nat.rewrite_sdp(with_trickle(description_json(connection.current_local_description().await))),
            "pendingLocalDescription": self.nat.rewrite_sdp(with_trickle(description_json(pending_local))),
            "remoteDescription": description_json(connection.remote_description().await),
            "currentRemoteDescription": description_json(connection.current_remote_description().await),
            "pendingRemoteDescription": description_json(pending_remote),
            "signalingState": signaling_state,
            "transceivers": transceivers,
        }))
    }

    async fn transceiver(&self, id: usize) -> Result<Arc<dyn RtpTransceiver>, String> {
        let connection = self.connection().await?;
        connection
            .get_transceivers()
            .await
            .into_iter()
            .find(|transceiver| transceiver.id() == id)
            .ok_or_else(|| "InvalidStateError: that transceiver no longer exists".to_owned())
    }

    /// Runs one asynchronous operation; the value becomes the JS promise's result.
    pub async fn request(self: &Arc<Self>, op: &str, args: &Value) -> Result<Value, String> {
        let connection = self.connection().await?;
        let string = |key: &str| args.get(key).and_then(Value::as_str);
        match op {
            "createOffer" => {
                let ice_restart = args.get("iceRestart").and_then(Value::as_bool).unwrap_or(false);
                let options = ice_restart.then(|| rtc::peer_connection::configuration::RTCOfferOptions { ice_restart });
                let offer = connection.create_offer(options).await.map_err(error_text)?;
                Ok(with_trickle(description_json(Some(offer))))
            }
            "createAnswer" => {
                let answer = connection.create_answer(None).await.map_err(error_text)?;
                Ok(with_trickle(description_json(Some(answer))))
            }
            "setLocalDescription" => {
                // webrtc-rs only takes back exactly the SDP it made, without the trickle line we add
                let mut description = args.get("description").cloned().unwrap_or(Value::Null);
                if let Some(sdp) = description.get("sdp").and_then(Value::as_str) {
                    description["sdp"] = Value::String(sdp.replacen("a=ice-options:trickle\r\n", "", 1));
                }
                let description = parse_description(&description)?;
                connection.set_local_description(description).await.map_err(error_text)?;
                self.renegotiated();
                self.snapshot().await
            }
            "setRemoteDescription" => {
                let description = parse_description(args.get("description").unwrap_or(&Value::Null))?;
                connection.set_remote_description(description).await.map_err(error_text)?;
                self.renegotiated();
                self.snapshot().await
            }
            "addIceCandidate" => {
                let candidate: RTCIceCandidateInit = serde_json::from_value(args.get("candidate").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("TypeError: {error}"))?;
                if candidate.candidate.is_empty() {
                    // end-of-candidates
                    return Ok(Value::Null);
                }
                connection.add_ice_candidate(candidate).await.map_err(|error| format!("OperationError: {error}"))?;
                Ok(Value::Null)
            }
            "restartIce" => {
                connection.restart_ice().await.map_err(error_text)?;
                Ok(Value::Null)
            }
            "getStats" => {
                let report = connection.get_stats(Instant::now(), StatsSelector::None).await;
                Ok(Value::Array(report.iter().filter_map(crate::stats::entry_json).collect()))
            }
            "snapshot" => self.snapshot().await,
            "addTrack" => {
                let track = handles::track(args.get("track").and_then(Value::as_u64).unwrap_or(0) as u32)?;
                let sender = connection
                    .add_track(track.track.clone() as Arc<dyn TrackLocal>)
                    .await
                    .map_err(|error| format!("InvalidAccessError: {error}"))?;
                if let Some(streams) = args.get("streams").and_then(Value::as_array) {
                    let streams = streams.iter().filter_map(Value::as_str).map(str::to_owned).collect();
                    let _ = sender.set_streams(streams).await;
                }
                track.attach(Some(sender));
                self.tracks.lock().unwrap().push(track);
                self.snapshot().await
            }
            "addTransceiver" => {
                let init = args.get("init").cloned().unwrap_or(Value::Null);
                let streams = init
                    .get("streams")
                    .and_then(Value::as_array)
                    .map(|streams| streams.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_default();
                let init = RTCRtpTransceiverInit {
                    direction: parse_direction(init.get("direction").and_then(Value::as_str))?,
                    streams,
                    send_encodings: vec![],
                };
                let transceiver = if let Some(track) = args.get("track").and_then(Value::as_u64) {
                    let track = handles::track(track as u32)?;
                    let transceiver = connection
                        .add_transceiver_from_track(track.track.clone() as Arc<dyn TrackLocal>, Some(init))
                        .await
                        .map_err(|error| format!("InvalidAccessError: {error}"))?;
                    track.attach(transceiver.sender().await.ok().flatten());
                    self.tracks.lock().unwrap().push(track);
                    transceiver
                } else {
                    let kind = parse_kind(string("kind").unwrap_or_default())?;
                    connection
                        .add_transceiver_from_kind(kind, Some(init))
                        .await
                        .map_err(|error| format!("InvalidAccessError: {error}"))?
                };
                let mut snapshot = self.snapshot().await?;
                snapshot["added"] = json!(transceiver.id());
                Ok(snapshot)
            }
            "removeTrack" => {
                let transceiver = self.transceiver(args["tr"].as_u64().unwrap_or(0) as usize).await?;
                if let Some(sender) = transceiver.sender().await.map_err(error_text)? {
                    connection.remove_track(&sender).await.map_err(error_text)?;
                }
                self.snapshot().await
            }
            "replaceTrack" => {
                let transceiver = self.transceiver(args["tr"].as_u64().unwrap_or(0) as usize).await?;
                let sender = transceiver
                    .sender()
                    .await
                    .map_err(error_text)?
                    .ok_or_else(|| "InvalidStateError: the transceiver has no sender".to_owned())?;
                let previous = self.tracks.lock().unwrap().iter().find(|track| track_is(&track.track, sender.track())).cloned();
                match args.get("track").and_then(Value::as_u64) {
                    Some(track) => {
                        let track = handles::track(track as u32)?;
                        sender
                            .replace_track(track.track.clone() as Arc<dyn TrackLocal>)
                            .await
                            .map_err(|error| format!("InvalidModificationError: {error}"))?;
                        if let Some(previous) = previous {
                            previous.attach(None);
                        }
                        track.attach(Some(sender));
                        self.tracks.lock().unwrap().push(track);
                    }
                    // the sender keeps the old track but nothing it writes goes out
                    None => {
                        if let Some(previous) = previous {
                            previous.attach(None);
                        }
                    }
                }
                Ok(Value::Null)
            }
            "setDirection" => {
                let transceiver = self.transceiver(args["tr"].as_u64().unwrap_or(0) as usize).await?;
                transceiver
                    .set_direction(parse_direction(string("direction"))?)
                    .await
                    .map_err(error_text)?;
                Ok(Value::Null)
            }
            "stopTransceiver" => {
                let transceiver = self.transceiver(args["tr"].as_u64().unwrap_or(0) as usize).await?;
                transceiver.stop().await.map_err(error_text)?;
                Ok(Value::Null)
            }
            "createDataChannel" => unreachable!("synchronous"),
            _ => Err(format!("NotSupportedError: unknown operation {op:?}")),
        }
    }

    /// `createDataChannel` is synchronous in the browser: the handle exists now, the channel soon.
    pub fn create_data_channel(self: &Arc<Self>, label: String, init: &Value) -> Result<u32, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("InvalidStateError: the RTCPeerConnection is closed".to_owned());
        }
        let max_packet_life_time = init.get("maxPacketLifeTime").and_then(Value::as_u64).map(|value| value.min(u16::MAX as u64) as u16);
        let max_retransmits = init.get("maxRetransmits").and_then(Value::as_u64).map(|value| value.min(u16::MAX as u64) as u16);
        if max_packet_life_time.is_some() && max_retransmits.is_some() {
            return Err("TypeError: maxPacketLifeTime and maxRetransmits are mutually exclusive".to_owned());
        }
        let negotiated = init.get("negotiated").and_then(Value::as_bool).unwrap_or(false);
        let id = init.get("id").and_then(Value::as_u64);
        if negotiated && id.is_none() {
            return Err("TypeError: a negotiated channel needs an id".to_owned());
        }
        if id.is_some_and(|id| id > 65534) {
            return Err("TypeError: id must be at most 65534".to_owned());
        }
        let init = RTCDataChannelInit {
            ordered: init.get("ordered").and_then(Value::as_bool).unwrap_or(true),
            max_packet_life_time,
            max_retransmits,
            protocol: init.get("protocol").and_then(Value::as_str).unwrap_or_default().to_owned(),
            negotiated: if negotiated { id.map(|id| id as u16) } else { None },
        };
        let handle = handles::reserve();
        let peer = self.clone();
        let (created_tx, created) = tokio::sync::oneshot::channel();
        // in line with the other operations, so an offer made after this includes the channel
        self.enqueue(async move {
            let result = match peer.connection().await {
                Ok(connection) => connection
                    .create_data_channel(&label, Some(init))
                    .await
                    .map_err(|error| format!("OperationError: {error}")),
                Err(error) => Err(error),
            };
            let _ = created_tx.send(result);
        });
        Channel::start(
            handle,
            self.events.clone(),
            async move { created.await.unwrap_or_else(|_| Err("OperationError: the connection closed".to_owned())) },
            None,
        );
        Ok(handle)
    }

    pub fn close(self: &Arc<Self>) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(port) = self.port.lock().unwrap().take() {
            PORTS_IN_USE.lock().unwrap().remove(&port);
        }
        let connection = self.connection.clone();
        let events = self.events.clone();
        let handle = self.handle;
        crate::runtime().spawn(async move {
            if let Ok(connection) = wait_connection(connection).await {
                // a connection whose transport already broke can take a long time to close
                let _ = tokio::time::timeout(Duration::from_secs(5), connection.close()).await;
            }
            events.emit(json!({"t": "pc_closed", "pc": handle}));
            handles::remove(handle);
        });
    }
}

fn track_is(track: &Arc<webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample>, other: &Arc<dyn TrackLocal>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(track), Arc::as_ptr(other))
}

async fn describe_transceiver(transceiver: &Arc<dyn RtpTransceiver>, tracks: &[Arc<LocalTrack>]) -> Value {
    let sender = transceiver.sender().await.ok().flatten();
    let receiver = transceiver.receiver().await.ok().flatten();
    let sender_track = sender
        .as_ref()
        .and_then(|sender| tracks.iter().find(|track| track_is(&track.track, sender.track())))
        .map(|track| track.handle);
    let kind = match (&receiver, &sender) {
        (Some(receiver), _) => Some(receiver.track().kind().await),
        (None, Some(sender)) => Some(sender.track().kind().await),
        _ => None,
    };
    let receiver_track_id = match &receiver {
        Some(receiver) => Some(receiver.track().track_id().await),
        None => None,
    };
    let current_direction = transceiver.current_direction().await.ok().map(|direction| direction.to_string());
    json!({
        "id": transceiver.id(),
        "mid": transceiver.mid().await.ok().flatten(),
        "kind": kind.map(kind_name),
        "direction": transceiver.direction().await.map(|direction| direction.to_string()).unwrap_or_else(|_| "stopped".to_owned()),
        "currentDirection": current_direction.filter(|direction| direction != "unspecified"),
        "senderTrack": sender_track,
        "receiverTrackId": receiver_track_id,
    })
}

async fn build(
    configuration: Configuration,
    certificates: Vec<rtc::peer_connection::certificate::RTCCertificate>,
    options: ServerOptions,
    port: u16,
    handler: Arc<Handler>,
) -> Result<impl PeerConnection, String> {
    let ice_servers = configuration
        .ice_servers
        .iter()
        .map(|server| RTCIceServer {
            urls: server.urls.clone(),
            username: server.username.clone().unwrap_or_default(),
            credential: server.credential.clone().unwrap_or_default(),
        })
        .collect();
    let mut rtc_configuration = RTCConfigurationBuilder::new().with_ice_servers(ice_servers);
    if configuration.ice_transport_policy.as_deref() == Some("relay") {
        rtc_configuration = rtc_configuration.with_ice_transport_policy(RTCIceTransportPolicy::Relay);
    }
    match configuration.bundle_policy.as_deref() {
        Some("max-compat") => rtc_configuration = rtc_configuration.with_bundle_policy(RTCBundlePolicy::MaxCompat),
        Some("max-bundle") => rtc_configuration = rtc_configuration.with_bundle_policy(RTCBundlePolicy::MaxBundle),
        _ => {}
    }
    if !certificates.is_empty() {
        rtc_configuration = rtc_configuration.with_certificates(certificates);
    }
    if let Some(size) = configuration.ice_candidate_pool_size {
        rtc_configuration = rtc_configuration.with_ice_candidate_pool_size(size);
    }

    let mut settings = SettingEngineBuilder::new()
        .with_sctp_max_message_size(SctpMaxMessageSize::Bounded(options.max_message_size.unwrap_or(256 * 1024)));
    if options.ice_lite {
        settings = settings.with_lite(true);
    }
    if options.include_loopback {
        settings = settings.with_include_loopback_candidate(true);
    }
    match options.mdns.as_deref() {
        Some("disabled") => settings = settings.with_multicast_dns_mode(rtc::ice::mdns::MulticastDnsMode::Disabled),
        Some("gather") => settings = settings.with_multicast_dns_mode(rtc::ice::mdns::MulticastDnsMode::QueryAndGather),
        _ => {}
    }
    if let Some(timeouts) = &options.ice_timeouts {
        settings = settings.with_ice_timeouts(
            timeouts.disconnected.map(Duration::from_millis),
            timeouts.failed.map(Duration::from_millis),
            timeouts.keep_alive.map(Duration::from_millis),
        );
    }
    let mut mux_ufrag = None;
    if let Some(mux) = options.udp_mux {
        let (ufrag, password) = crate::mux::credentials();
        settings = settings.with_ice_credentials(ufrag.clone(), password);
        mux_ufrag = Some((mux, ufrag));
    }

    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().map_err(error_text)?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine).map_err(error_text)?;

    let mut builder = PeerConnectionBuilder::new()
        .with_configuration(rtc_configuration.build())
        .with_setting_engine(settings.build())
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_handler(handler);
    if let Some((mux, ufrag)) = mux_ufrag {
        builder = builder.with_udp_sockets(crate::mux::socket_for(mux, ufrag)?).with_udp_addrs(Vec::<String>::new());
    } else {
        builder = builder.with_udp_addrs(bind_addresses(&options, port)?);
    }
    if let Some(tcp_port) = options.tcp_port {
        let mut tcp = options.clone();
        tcp.include_loopback = false;
        builder = builder.with_tcp_addrs(bind_addresses(&tcp, tcp_port)?);
    }
    builder.build().await.map_err(error_text)
}
