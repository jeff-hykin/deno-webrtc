//! Local tracks the application feeds with encoded samples or whole RTP packets (no codecs here).

use crate::events::EventQueue;
use bytes::Bytes;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{RTCPFeedback, RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind};
use rtc::shared::marshal::Unmarshal;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::rtp_transceiver::RtpSender;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackInit {
    pub kind: String,
    pub id: Option<String>,
    pub label: Option<String>,
    pub stream_id: Option<String>,
    pub mime_type: String,
    pub clock_rate: Option<u32>,
    pub channels: Option<u16>,
    pub sdp_fmtp_line: Option<String>,
}

enum Write {
    Rtp(Vec<u8>),
    Sample(Bytes, Duration),
}

pub struct LocalTrack {
    pub handle: u32,
    pub kind: RtpCodecKind,
    pub id: String,
    pub stream_id: String,
    pub track: Arc<TrackLocalStaticSample>,
    mime_type: String,
    ssrc: u32,
    writes: mpsc::UnboundedSender<Write>,
    /// the sender it is attached to, for the negotiated payload type
    sender: Mutex<Option<Arc<dyn RtpSender>>>,
    payload_type: Mutex<Option<u8>>,
    enabled: AtomicBool,
}

pub fn parse_kind(kind: &str) -> Result<RtpCodecKind, String> {
    match kind {
        "audio" => Ok(RtpCodecKind::Audio),
        "video" => Ok(RtpCodecKind::Video),
        _ => Err(format!("TypeError: kind must be \"audio\" or \"video\", not {kind:?}")),
    }
}

pub fn kind_name(kind: RtpCodecKind) -> &'static str {
    match kind {
        RtpCodecKind::Audio => "audio",
        RtpCodecKind::Video => "video",
        _ => "unspecified",
    }
}

/// The codec a browser expects for `mime_type`, with any field `init` overrides.
pub fn codec_for(init: &TrackInit) -> RTCRtpCodec {
    let mime = init.mime_type.to_ascii_lowercase();
    let feedback = |typ: &str, parameter: &str| RTCPFeedback { typ: typ.to_owned(), parameter: parameter.to_owned() };
    let video_feedback = vec![feedback("goog-remb", ""), feedback("ccm", "fir"), feedback("nack", ""), feedback("nack", "pli")];
    let (clock_rate, channels, fmtp, rtcp_feedback) = match mime.as_str() {
        "audio/opus" => (48_000, 2, "minptime=10;useinbandfec=1", vec![]),
        "audio/pcmu" | "audio/pcma" | "audio/g722" => (8_000, 1, "", vec![]),
        "video/h264" => (90_000, 0, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", video_feedback),
        "video/vp9" => (90_000, 0, "profile-id=0", video_feedback),
        "video/h265" => (90_000, 0, "", video_feedback),
        _ if mime.starts_with("audio/") => (48_000, 2, "", vec![]),
        _ => (90_000, 0, "", video_feedback),
    };
    RTCRtpCodec {
        mime_type: init.mime_type.clone(),
        clock_rate: init.clock_rate.unwrap_or(clock_rate),
        channels: init.channels.unwrap_or(channels),
        sdp_fmtp_line: init.sdp_fmtp_line.clone().unwrap_or_else(|| fmtp.to_owned()),
        rtcp_feedback,
    }
}

fn random_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

impl LocalTrack {
    pub fn new(handle: u32, events: Arc<EventQueue>, init: TrackInit) -> Result<Arc<LocalTrack>, String> {
        let kind = parse_kind(&init.kind)?;
        if !init.mime_type.contains('/') {
            return Err(format!("TypeError: mimeType must look like \"video/H264\", not {:?}", init.mime_type));
        }
        let ssrc = rand::random::<u32>();
        let id = init.id.clone().unwrap_or_else(random_id);
        let stream_id = init.stream_id.clone().unwrap_or_else(random_id);
        let codec = codec_for(&init);
        let label = init.label.clone().unwrap_or_default();
        let track = MediaStreamTrack::new(
            stream_id.clone(),
            id.clone(),
            label,
            kind,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(ssrc), ..Default::default() },
                codec,
                ..Default::default()
            }],
        );
        let track = Arc::new(TrackLocalStaticSample::new(Instant::now(), track).map_err(|error| format!("NotSupportedError: {error}"))?);
        let (writes, writes_rx) = mpsc::unbounded_channel();
        let local = Arc::new(LocalTrack {
            handle,
            kind,
            id,
            stream_id,
            track,
            mime_type: init.mime_type,
            ssrc,
            writes,
            sender: Mutex::new(None),
            payload_type: Mutex::new(None),
            enabled: AtomicBool::new(true),
        });
        crate::runtime().spawn(write_loop(Arc::downgrade(&local), writes_rx, events.clone()));
        crate::runtime().spawn(rtcp_loop(Arc::downgrade(&local), events));
        Ok(local)
    }

    pub fn attach(&self, sender: Option<Arc<dyn RtpSender>>) {
        *self.sender.lock().unwrap() = sender;
        self.renegotiated();
    }

    /// The payload type may have changed: look it up again on the next write.
    pub fn renegotiated(&self) {
        *self.payload_type.lock().unwrap() = None;
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }

    pub fn write_rtp(&self, packet: &[u8]) -> bool {
        self.writes.send(Write::Rtp(packet.to_vec())).is_ok()
    }

    pub fn write_sample(&self, data: &[u8], duration: Duration) -> bool {
        self.writes.send(Write::Sample(Bytes::copy_from_slice(data), duration)).is_ok()
    }

    async fn payload_type(&self) -> Option<u8> {
        if let Some(payload_type) = *self.payload_type.lock().unwrap() {
            return Some(payload_type);
        }
        let sender = self.sender.lock().unwrap().clone()?;
        let parameters = sender.get_parameters().await.ok()?;
        let payload_type = parameters
            .rtp_parameters
            .codecs
            .iter()
            .find(|codec| codec.rtp_codec.mime_type.eq_ignore_ascii_case(&self.mime_type))
            .map(|codec| codec.payload_type)?;
        *self.payload_type.lock().unwrap() = Some(payload_type);
        Some(payload_type)
    }
}

async fn write_loop(track: Weak<LocalTrack>, mut writes: mpsc::UnboundedReceiver<Write>, events: Arc<EventQueue>) {
    let mut warned = false;
    while let Some(write) = writes.recv().await {
        let Some(track) = track.upgrade() else { return };
        if !track.enabled.load(Ordering::Acquire) {
            continue;
        }
        // nothing to send to until the track is negotiated on a connection
        let Some(payload_type) = track.payload_type().await else { continue };
        let result = match write {
            Write::Rtp(bytes) => match rtc::rtp::Packet::unmarshal(&mut bytes.as_slice()) {
                Ok(mut packet) => {
                    packet.header.ssrc = track.ssrc;
                    packet.header.payload_type = payload_type;
                    track.track.write_rtp(packet).await.map_err(|error| error.to_string())
                }
                Err(error) => Err(format!("not an RTP packet: {error}")),
            },
            Write::Sample(data, duration) => {
                let sample = Sample { data, duration, ..Sample::new(Instant::now()) };
                track
                    .track
                    .write_sample(track.ssrc, payload_type, &sample, &[])
                    .await
                    .map_err(|error| error.to_string())
            }
        };
        if let Err(error) = result
            && !warned
        {
            warned = true;
            events.emit(json!({"t": "track_error", "track": track.handle, "error": error}));
        }
    }
}

/// Forwards the receiver's keyframe requests (PLI/FIR) as `keyframerequest` events.
async fn rtcp_loop(track: Weak<LocalTrack>, events: Arc<EventQueue>) {
    loop {
        let Some(local) = track.upgrade() else { return };
        let inner = local.track.clone();
        let handle = local.handle;
        drop(local);
        match inner.poll().await {
            Some(TrackLocalEvent::OnRtcpPacket(packets)) => {
                let keyframe = packets.iter().any(|packet| {
                    let any = packet.as_any();
                    any.is::<PictureLossIndication>() || any.is::<FullIntraRequest>()
                });
                if keyframe {
                    events.emit(json!({"t": "track_keyframe", "track": handle}));
                }
            }
            // not bound to a sender yet (or unbound): look again shortly
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}
