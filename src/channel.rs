//! RTCDataChannel: sends go through one queue per channel so they keep their order.

use crate::events::EventQueue;
use crate::handles::{self, Object};
use bytes::BytesMut;
use serde_json::{Value, json};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState};

enum Outgoing {
    Data(BytesMut, bool),
    LowThreshold(u32),
    Close,
}

pub struct Channel {
    pub handle: u32,
    events: Arc<EventQueue>,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    /// bytes handed to `send` that SCTP hasn't taken yet
    queued: AtomicU64,
    /// SCTP's outstanding (unacknowledged) bytes, as of the last refresh
    in_sctp: AtomicU64,
    closed: AtomicBool,
}

pub fn ready_state_name(state: RTCDataChannelState) -> &'static str {
    match state {
        RTCDataChannelState::Connecting => "connecting",
        RTCDataChannelState::Open => "open",
        RTCDataChannelState::Closing => "closing",
        RTCDataChannelState::Closed => "closed",
        _ => "connecting",
    }
}

/// The channel's attributes, for a remotely opened channel's `datachannel` event.
pub async fn describe(dc: &Arc<dyn DataChannel>) -> Value {
    json!({
        "label": dc.label().await.unwrap_or_default(),
        "ordered": dc.ordered().await.unwrap_or(true),
        "maxPacketLifeTime": dc.max_packet_life_time().await.ok().flatten(),
        "maxRetransmits": dc.max_retransmits().await.ok().flatten(),
        "protocol": dc.protocol().await.unwrap_or_default(),
        "negotiated": dc.negotiated().await.unwrap_or(false),
        "id": dc.id(),
        "readyState": dc.ready_state().await.map(ready_state_name).unwrap_or("open"),
    })
}

impl Channel {
    /// Registers `handle` now; `source` yields the channel later. `announce` (a remote channel's
    /// `datachannel` event) is emitted once it exists, before any of the channel's own events.
    pub fn start<F>(handle: u32, events: Arc<EventQueue>, source: F, announce: Option<Value>) -> Arc<Channel>
    where
        F: Future<Output = Result<Arc<dyn DataChannel>, String>> + Send + 'static,
    {
        let (outgoing, outgoing_rx) = mpsc::unbounded_channel();
        let channel = Arc::new(Channel {
            handle,
            events: events.clone(),
            outgoing,
            queued: AtomicU64::new(0),
            in_sctp: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        });
        handles::insert(handle, Object::Channel(channel.clone()));
        let weak = Arc::downgrade(&channel);
        crate::runtime().spawn(async move {
            let dc = match source.await {
                Ok(dc) => dc,
                Err(error) => {
                    events.emit(json!({"t": "dc_error", "dc": handle, "error": error}));
                    events.emit(json!({"t": "dc_close", "dc": handle}));
                    handles::remove(handle);
                    return;
                }
            };
            if let Some(mut announce) = announce {
                let attributes = describe(&dc).await;
                if let (Value::Object(announce), Value::Object(attributes)) = (&mut announce, attributes) {
                    announce.extend(attributes);
                }
                events.emit(announce);
            } else {
                events.emit(json!({"t": "dc_id", "dc": handle, "id": dc.id()}));
            }
            crate::runtime().spawn(send_loop(dc.clone(), weak.clone(), outgoing_rx));
            crate::runtime().spawn(refresh_loop(dc.clone(), weak.clone()));
            receive_loop(dc, weak, handle, events).await;
        });
        channel
    }

    /// Queues a message; false once the channel is closed.
    pub fn send(&self, data: &[u8], text: bool) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        self.queued.fetch_add(data.len() as u64, Ordering::AcqRel);
        self.outgoing.send(Outgoing::Data(BytesMut::from(data), text)).is_ok()
    }

    pub fn buffered_amount(&self) -> u64 {
        self.queued.load(Ordering::Acquire) + self.in_sctp.load(Ordering::Acquire)
    }

    pub fn set_low_threshold(&self, threshold: u32) {
        let _ = self.outgoing.send(Outgoing::LowThreshold(threshold));
    }

    pub fn close(&self) {
        let _ = self.outgoing.send(Outgoing::Close);
    }
}

async fn send_loop(dc: Arc<dyn DataChannel>, channel: Weak<Channel>, mut outgoing: mpsc::UnboundedReceiver<Outgoing>) {
    while let Some(item) = outgoing.recv().await {
        match item {
            Outgoing::Data(data, text) => {
                let length = data.len() as u64;
                let result = if text {
                    dc.send_text(&String::from_utf8_lossy(&data)).await
                } else {
                    dc.send(data).await
                };
                let in_sctp = dc.outstanding_bytes().await.unwrap_or(0) as u64;
                let Some(channel) = channel.upgrade() else { return };
                channel.in_sctp.store(in_sctp, Ordering::Release);
                channel.queued.fetch_sub(length, Ordering::AcqRel);
                if let Err(error) = result {
                    channel.events.emit(json!({"t": "dc_error", "dc": channel.handle, "error": format!("OperationError: {error}")}));
                }
            }
            Outgoing::LowThreshold(threshold) => {
                let _ = dc.set_buffered_amount_low_threshold(threshold).await;
            }
            Outgoing::Close => {
                // the browser sends what's queued before closing; an SCTP reset would drop it
                let mut last = u64::MAX;
                let mut stalled = 0;
                loop {
                    let outstanding = dc.outstanding_bytes().await.unwrap_or(0) as u64;
                    if outstanding == 0 || stalled >= 250 {
                        break;
                    }
                    stalled = if outstanding < last { 0 } else { stalled + 1 };
                    last = outstanding;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                if let Some(channel) = channel.upgrade() {
                    channel.closed.store(true, Ordering::Release);
                }
                let _ = dc.close().await;
                return;
            }
        }
    }
}

/// Keeps `bufferedAmount` current while SCTP drains.
async fn refresh_loop(dc: Arc<dyn DataChannel>, channel: Weak<Channel>) {
    loop {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let Some(channel) = channel.upgrade() else { return };
        if channel.closed.load(Ordering::Acquire) && channel.buffered_amount() == 0 {
            return;
        }
        if channel.in_sctp.load(Ordering::Acquire) > 0 {
            match dc.outstanding_bytes().await {
                Ok(outstanding) => channel.in_sctp.store(outstanding as u64, Ordering::Release),
                Err(_) => {
                    channel.in_sctp.store(0, Ordering::Release);
                    return;
                }
            }
        }
    }
}

async fn receive_loop(dc: Arc<dyn DataChannel>, channel: Weak<Channel>, handle: u32, events: Arc<EventQueue>) {
    while let Some(event) = dc.poll().await {
        match event {
            DataChannelEvent::OnOpen => events.emit(json!({"t": "dc_open", "dc": handle})),
            DataChannelEvent::OnMessage(message) => {
                events.emit_with(json!({"t": "dc_msg", "dc": handle, "s": message.is_string}), &message.data)
            }
            DataChannelEvent::OnBufferedAmountLow => {
                if let Some(channel) = channel.upgrade() {
                    let outstanding = dc.outstanding_bytes().await.unwrap_or(0) as u64;
                    channel.in_sctp.store(outstanding, Ordering::Release);
                }
                events.emit(json!({"t": "dc_low", "dc": handle}))
            }
            DataChannelEvent::OnClosing => events.emit(json!({"t": "dc_closing", "dc": handle})),
            DataChannelEvent::OnError => events.emit(json!({"t": "dc_error", "dc": handle, "error": "OperationError: data channel failure"})),
            DataChannelEvent::OnClose => break,
            _ => {}
        }
    }
    if let Some(channel) = channel.upgrade() {
        channel.closed.store(true, Ordering::Release);
        channel.in_sctp.store(0, Ordering::Release);
    }
    events.emit(json!({"t": "dc_close", "dc": handle}));
    handles::remove(handle);
}
