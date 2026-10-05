//! getStats entries as the W3C dictionaries (the stats types already serialize that way).

use serde_json::Value;
use webrtc::peer_connection::RTCStatsReportEntry;

pub fn entry_json(entry: &RTCStatsReportEntry) -> Option<Value> {
    let value = match entry {
        RTCStatsReportEntry::PeerConnection(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::Transport(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::IceCandidatePair(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::LocalCandidate(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::RemoteCandidate(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::Certificate(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::Codec(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::DataChannel(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::InboundRtp(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::OutboundRtp(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::RemoteInboundRtp(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::RemoteOutboundRtp(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::AudioSource(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::VideoSource(stats) => serde_json::to_value(stats),
        RTCStatsReportEntry::AudioPlayout(stats) => serde_json::to_value(stats),
        _ => return None,
    };
    value.ok()
}
