//! Every object JS holds is a `u32` handle into this table.

use crate::channel::Channel;
use crate::media::LocalTrack;
use crate::mux::UdpMux;
use crate::peer::Peer;
use rtc::peer_connection::certificate::RTCCertificate;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Clone)]
pub enum Object {
    Peer(Arc<Peer>),
    Channel(Arc<Channel>),
    Track(Arc<LocalTrack>),
    Certificate(Arc<RTCCertificate>),
    Mux(Arc<UdpMux>),
}

static HANDLES: LazyLock<Mutex<HashMap<u32, Object>>> = LazyLock::new(Default::default);
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

pub fn reserve() -> u32 {
    NEXT_HANDLE.fetch_add(1, Ordering::Relaxed)
}

pub fn insert(handle: u32, object: Object) {
    HANDLES.lock().unwrap().insert(handle, object);
}

pub fn remove(handle: u32) -> Option<Object> {
    HANDLES.lock().unwrap().remove(&handle)
}

fn get(handle: u32) -> Option<Object> {
    HANDLES.lock().unwrap().get(&handle).cloned()
}

pub fn peer(handle: u32) -> Result<Arc<Peer>, String> {
    match get(handle) {
        Some(Object::Peer(peer)) => Ok(peer),
        _ => Err(format!("InvalidStateError: no RTCPeerConnection with handle {handle} (closed?)")),
    }
}

pub fn channel(handle: u32) -> Result<Arc<Channel>, String> {
    match get(handle) {
        Some(Object::Channel(channel)) => Ok(channel),
        _ => Err(format!("InvalidStateError: no RTCDataChannel with handle {handle}")),
    }
}

pub fn track(handle: u32) -> Result<Arc<LocalTrack>, String> {
    match get(handle) {
        Some(Object::Track(track)) => Ok(track),
        _ => Err(format!("InvalidStateError: no local track with handle {handle}")),
    }
}

pub fn certificate(handle: u32) -> Result<Arc<RTCCertificate>, String> {
    match get(handle) {
        Some(Object::Certificate(certificate)) => Ok(certificate),
        _ => Err(format!("InvalidAccessError: no RTCCertificate with handle {handle}")),
    }
}

pub fn mux(handle: u32) -> Result<Arc<UdpMux>, String> {
    match get(handle) {
        Some(Object::Mux(mux)) => Ok(mux),
        _ => Err(format!("InvalidAccessError: no UdpMux with handle {handle} (closed?)")),
    }
}
