//! UdpMux: every connection shares one UDP port (per local address), told apart by ICE username.
//!
//! Each connection gets its own ICE username fragment. The first packet from a new remote address
//! is a STUN binding request whose USERNAME starts with that fragment; it pins the address to the
//! connection, and later packets from that address go straight to it.

use rand::Rng;
use rand::distr::Alphanumeric;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{self, IoSliceMut};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll, Waker};
use webrtc::runtime::{AsyncUdpSocket, RecvMeta, Transmit};

/// A queue this long means the connection stopped reading; drop rather than grow.
const INBOX_LIMIT: usize = 4096;

pub struct UdpMux {
    pub port: u16,
    sockets: Vec<Arc<SharedSocket>>,
    readers: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for UdpMux {
    fn drop(&mut self) {
        // frees the port once the connections using it are gone too
        for reader in &self.readers {
            reader.abort();
        }
    }
}

struct SharedSocket {
    local: SocketAddr,
    socket: Arc<tokio::net::UdpSocket>,
    by_remote: Mutex<HashMap<SocketAddr, Weak<ConnectionSocket>>>,
    by_ufrag: Mutex<HashMap<String, Weak<ConnectionSocket>>>,
}

/// One connection's view of a shared socket.
pub struct ConnectionSocket {
    local: SocketAddr,
    socket: Arc<tokio::net::UdpSocket>,
    inbox: Mutex<Inbox>,
}

#[derive(Default)]
struct Inbox {
    datagrams: VecDeque<(Vec<u8>, SocketAddr)>,
    waker: Option<Waker>,
}

impl fmt::Debug for ConnectionSocket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ConnectionSocket({})", self.local)
    }
}

pub fn credentials() -> (String, String) {
    let random = |length| rand::rng().sample_iter(&Alphanumeric).take(length).map(char::from).collect::<String>();
    (random(16), random(32))
}

fn usable_ips(addresses: &[String], include_loopback: bool) -> Result<Vec<IpAddr>, String> {
    let mut ips: Vec<IpAddr> = Vec::new();
    if addresses.is_empty() {
        let interfaces = rtc::shared::ifaces::ifaces().map_err(|error| format!("OperationError: listing interfaces: {error}"))?;
        for interface in interfaces {
            let Some(addr) = interface.addr else { continue };
            let ip = addr.ip();
            let link_local = match ip {
                IpAddr::V4(ip) => ip.is_link_local(),
                IpAddr::V6(_) => true,
            };
            if ip.is_ipv4() && !ip.is_unspecified() && !link_local && !ip.is_loopback() && !ips.contains(&ip) {
                ips.push(ip);
            }
        }
    } else {
        for address in addresses {
            ips.push(address.parse().map_err(|_| format!("SyntaxError: {address:?} is not an IP address"))?);
        }
    }
    if include_loopback && !ips.iter().any(IpAddr::is_loopback) {
        ips.push(IpAddr::from([127, 0, 0, 1]));
    }
    if ips.is_empty() {
        return Err("OperationError: no network interface to listen on".to_owned());
    }
    Ok(ips)
}

impl UdpMux {
    pub fn new(port: u16, addresses: &[String], include_loopback: bool) -> Result<Arc<UdpMux>, String> {
        let ips = usable_ips(addresses, include_loopback)?;
        let _guard = crate::runtime().enter();
        let mut port = port;
        let mut sockets = Vec::new();
        let mut readers = Vec::new();
        for ip in ips {
            let socket = std::net::UdpSocket::bind((ip, port)).map_err(|error| format!("OperationError: binding {ip}:{port}: {error}"))?;
            socket.set_nonblocking(true).map_err(|error| format!("OperationError: {error}"))?;
            let local = socket.local_addr().map_err(|error| format!("OperationError: {error}"))?;
            // the other addresses take the port the first one was given
            port = local.port();
            let socket = Arc::new(tokio::net::UdpSocket::from_std(socket).map_err(|error| format!("OperationError: {error}"))?);
            let shared = Arc::new(SharedSocket {
                local,
                socket,
                by_remote: Mutex::new(HashMap::new()),
                by_ufrag: Mutex::new(HashMap::new()),
            });
            readers.push(crate::runtime().spawn(read_loop(Arc::downgrade(&shared), shared.socket.clone())));
            sockets.push(shared);
        }
        Ok(Arc::new(UdpMux { port, sockets, readers }))
    }

    pub fn addresses(&self) -> Vec<String> {
        self.sockets.iter().map(|socket| socket.local.to_string()).collect()
    }

    /// A connection's sockets, one per shared address, answering to ICE username `ufrag`.
    pub fn connection_sockets(&self, ufrag: &str) -> Vec<Arc<dyn AsyncUdpSocket>> {
        self.sockets
            .iter()
            .map(|shared| {
                let socket = Arc::new(ConnectionSocket {
                    local: shared.local,
                    socket: shared.socket.clone(),
                    inbox: Mutex::new(Inbox::default()),
                });
                shared.by_ufrag.lock().unwrap().insert(ufrag.to_owned(), Arc::downgrade(&socket));
                socket as Arc<dyn AsyncUdpSocket>
            })
            .collect()
    }
}

pub fn socket_for(mux: u32, ufrag: String) -> Result<Vec<Arc<dyn AsyncUdpSocket>>, String> {
    Ok(crate::handles::mux(mux)?.connection_sockets(&ufrag))
}

/// The ICE username fragment the sender addressed (the part of USERNAME before ':'), if this is a STUN request.
fn stun_recipient(packet: &[u8]) -> Option<&str> {
    const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
    const USERNAME: u16 = 0x0006;
    if packet.len() < 20 || packet[0] & 0xC0 != 0 || packet[4..8] != MAGIC_COOKIE {
        return None;
    }
    let length = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    let attributes = packet.get(20..20 + length)?;
    let mut offset = 0;
    while offset + 4 <= attributes.len() {
        let kind = u16::from_be_bytes([attributes[offset], attributes[offset + 1]]);
        let size = u16::from_be_bytes([attributes[offset + 2], attributes[offset + 3]]) as usize;
        let value = attributes.get(offset + 4..offset + 4 + size)?;
        if kind == USERNAME {
            let username = std::str::from_utf8(value).ok()?;
            return username.split(':').next();
        }
        offset += 4 + size.div_ceil(4) * 4;
    }
    None
}

async fn read_loop(shared: Weak<SharedSocket>, socket: Arc<tokio::net::UdpSocket>) {
    let mut buffer = vec![0u8; 65536];
    loop {
        let Ok((length, from)) = socket.recv_from(&mut buffer).await else {
            // e.g. ICMP port unreachable surfacing on some platforms; keep serving everyone else
            if shared.strong_count() == 0 {
                return;
            }
            continue;
        };
        let Some(shared) = shared.upgrade() else { return };
        let packet = &buffer[..length];
        let mut target = None;
        if let Some(ufrag) = stun_recipient(packet) {
            let mut by_ufrag = shared.by_ufrag.lock().unwrap();
            match by_ufrag.get(ufrag).map(Weak::upgrade) {
                Some(Some(connection)) => {
                    shared.by_remote.lock().unwrap().insert(from, Arc::downgrade(&connection));
                    target = Some(connection);
                }
                Some(None) => {
                    by_ufrag.remove(ufrag);
                }
                None => {}
            }
        }
        if target.is_none() {
            let mut by_remote = shared.by_remote.lock().unwrap();
            match by_remote.get(&from).map(Weak::upgrade) {
                Some(Some(connection)) => target = Some(connection),
                Some(None) => {
                    by_remote.remove(&from);
                }
                None => {}
            }
        }
        let Some(connection) = target else { continue };
        let mut inbox = connection.inbox.lock().unwrap();
        if inbox.datagrams.len() < INBOX_LIMIT {
            inbox.datagrams.push_back((packet.to_vec(), from));
        }
        if let Some(waker) = inbox.waker.take() {
            waker.wake();
        }
    }
}

impl AsyncUdpSocket for ConnectionSocket {
    fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.local)
    }

    fn poll_send(&self, cx: &mut Context<'_>, transmit: &Transmit<'_>) -> Poll<io::Result<usize>> {
        self.socket.poll_send_to(cx, transmit.contents, transmit.destination)
    }

    fn poll_recv(&self, cx: &mut Context<'_>, bufs: &mut [IoSliceMut<'_>], meta: &mut [RecvMeta]) -> Poll<io::Result<usize>> {
        let mut inbox = self.inbox.lock().unwrap();
        let mut received = 0;
        while received < bufs.len().min(meta.len()) {
            let Some((datagram, from)) = inbox.datagrams.pop_front() else { break };
            let length = datagram.len().min(bufs[received].len());
            bufs[received][..length].copy_from_slice(&datagram[..length]);
            meta[received] = RecvMeta::default();
            meta[received].len = length;
            meta[received].stride = length.max(1);
            meta[received].addr = from;
            meta[received].dst_ip = Some(self.local.ip());
            received += 1;
        }
        if received > 0 {
            return Poll::Ready(Ok(received));
        }
        inbox.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}
