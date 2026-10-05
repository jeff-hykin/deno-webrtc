//! Per-context event queues: Rust threads push, the JS thread waits (off-thread) and drains.
//!
//! An event is `[u32 LE header length][JSON header][binary payload]`.

use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct EventQueue {
    queue: Mutex<Inner>,
    ready: Condvar,
}

#[derive(Default)]
struct Inner {
    events: VecDeque<Vec<u8>>,
    woken: bool,
}

impl EventQueue {
    pub fn emit(&self, header: Value) {
        self.emit_with(header, &[])
    }

    pub fn emit_with(&self, header: Value, payload: &[u8]) {
        let header = serde_json::to_vec(&header).expect("event headers are plain JSON");
        let mut event = Vec::with_capacity(4 + header.len() + payload.len());
        event.extend_from_slice(&(header.len() as u32).to_le_bytes());
        event.extend_from_slice(&header);
        event.extend_from_slice(payload);
        self.queue.lock().unwrap().events.push_back(event);
        self.ready.notify_all();
    }

    /// Blocks until there is an event, `wake` is called, or `timeout_ms` passes (negative: no timeout).
    pub fn wait(&self, timeout_ms: i32) -> u32 {
        let mut inner = self.queue.lock().unwrap();
        loop {
            if !inner.events.is_empty() || inner.woken {
                inner.woken = false;
                return inner.events.len() as u32;
            }
            if timeout_ms < 0 {
                inner = self.ready.wait(inner).unwrap();
            } else {
                let (next, result) = self
                    .ready
                    .wait_timeout(inner, Duration::from_millis(timeout_ms as u64))
                    .unwrap();
                inner = next;
                if result.timed_out() {
                    return inner.events.len() as u32;
                }
            }
        }
    }

    pub fn wake(&self) {
        self.queue.lock().unwrap().woken = true;
        self.ready.notify_all();
    }

    pub fn next_size(&self) -> u32 {
        self.queue
            .lock()
            .unwrap()
            .events
            .front()
            .map(|event| event.len() as u32)
            .unwrap_or(0)
    }

    pub fn pop(&self) -> Option<Vec<u8>> {
        self.queue.lock().unwrap().events.pop_front()
    }
}

static CONTEXTS: LazyLock<Mutex<HashMap<u32, Arc<EventQueue>>>> = LazyLock::new(Default::default);
static NEXT_CONTEXT: AtomicU32 = AtomicU32::new(1);

/// One per JS realm (main thread or Worker): every object it creates reports to its own queue.
pub fn new_context() -> u32 {
    let id = NEXT_CONTEXT.fetch_add(1, Ordering::Relaxed);
    CONTEXTS.lock().unwrap().insert(id, Arc::new(EventQueue::default()));
    id
}

pub fn context(id: u32) -> Option<Arc<EventQueue>> {
    CONTEXTS.lock().unwrap().get(&id).cloned()
}

pub fn free_context(id: u32) {
    if let Some(queue) = CONTEXTS.lock().unwrap().remove(&id) {
        queue.wake();
    }
}
