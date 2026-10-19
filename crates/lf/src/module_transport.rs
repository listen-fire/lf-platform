//! The one transport every module kind is reached over (adapter protocol 2's
//! HTTP, docs/contracts/adapter-protocol.md#transport): a Unix socket for a
//! module on this box, plain HTTP over TCP where there is none (loopback),
//! and HTTPS for a remote module. A module's address is written as its base
//! URL: `unix:<socket path>`, `http://host:port/path` or `https://…`.
//!
//! A started module says where it listens on one line of its stdout:
//! `listening unix:<socket path>` or `listening <port>` (loopback TCP).

use std::path::{Path, PathBuf};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;

/// Where a module is, read off its base URL.
#[derive(Debug, Clone, PartialEq)]
pub enum Address {
    Unix(PathBuf),
    Tcp { tls: bool, host: String, port: u16, path: String },
}

impl Address {
    pub fn parse(base_url: &str) -> Result<Address, String> {
        if let Some(path) = base_url.strip_prefix("unix:") {
            let path = path.trim_start_matches("//");
            if path.is_empty() {
                return Err(format!("{base_url}: a unix: address names its socket's path"));
            }
            return Ok(Address::Unix(PathBuf::from(path)));
        }
        let (tls, rest) = match (base_url.strip_prefix("http://"), base_url.strip_prefix("https://")) {
            (Some(rest), _) => (false, rest),
            (_, Some(rest)) => (true, rest),
            _ => return Err(format!("{base_url}: a module is reached at unix:<socket>, http:// or https://")),
        };
        let (authority, path) = match rest.find('/') {
            Some(at) => (&rest[..at], &rest[at..]),
            None => (rest, "/"),
        };
        let default_port = if tls { 443 } else { 80 };
        let (host, port) = match authority.strip_prefix('[') {
            Some(bracketed) => {
                let (host, after) = bracketed.split_once(']').ok_or_else(|| format!("{base_url}: an IPv6 host closes its bracket"))?;
                (host, after.strip_prefix(':'))
            }
            None => match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            },
        };
        let port = match port {
            Some(port) => port.parse::<u16>().map_err(|_| format!("{base_url}: not a port: {port}"))?,
            None => default_port,
        };
        let host = host.to_string();
        if host.is_empty() {
            return Err(format!("{base_url}: no host"));
        }
        Ok(Address::Tcp { tls, host, port, path: path.to_string() })
    }

    /// The `host` header a request to it carries.
    fn authority(&self) -> String {
        match self {
            Address::Unix(_) => "localhost".into(),
            Address::Tcp { host, port, .. } if host.contains(':') => format!("[{host}]:{port}"),
            Address::Tcp { host, port, .. } => format!("{host}:{port}"),
        }
    }

    fn path(&self) -> &str {
        match self {
            Address::Unix(_) => "/",
            Address::Tcp { path, .. } => path,
        }
    }

    /// On this box: a socket, or a loopback address (where a credential may go
    /// in the clear).
    pub fn is_local(&self) -> bool {
        match self {
            Address::Unix(_) => true,
            Address::Tcp { tls: true, .. } => false,
            Address::Tcp { host, .. } => {
                host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
            }
        }
    }
}

/// An HTTP answer, whatever its status.
pub struct Answer {
    pub status: u16,
    pub body: Bytes,
}

/// POST `body` to the module at `base_url` with `headers`.
pub async fn post(base_url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<Answer, String> {
    send(hyper::Method::POST, base_url, headers, body).await
}

/// GET `url` with `headers`.
pub async fn get(url: &str, headers: &[(String, String)]) -> Result<Answer, String> {
    send(hyper::Method::GET, url, headers, Vec::new()).await
}

async fn send(method: hyper::Method, base_url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<Answer, String> {
    let address = Address::parse(base_url)?;
    let mut request = Request::builder().method(method).uri(address.path()).header("host", address.authority());
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let request = request.body(Full::new(Bytes::from(body))).map_err(|e| e.to_string())?;
    match &address {
        Address::Unix(path) => unix_exchange(path, request).await,
        Address::Tcp { tls, host, port, .. } => {
            let stream = tokio::net::TcpStream::connect((host.as_str(), *port)).await.map_err(|e| e.to_string())?;
            if *tls {
                let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
                let stream = crate::http_out::tls_connector().connect(name, stream).await.map_err(|e| e.to_string())?;
                exchange(stream, request).await
            } else {
                exchange(stream, request).await
            }
        }
    }
}

#[cfg(unix)]
async fn unix_exchange(path: &Path, request: Request<Full<Bytes>>) -> Result<Answer, String> {
    let stream = tokio::net::UnixStream::connect(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    exchange(stream, request).await
}

#[cfg(not(unix))]
async fn unix_exchange(path: &Path, _request: Request<Full<Bytes>>) -> Result<Answer, String> {
    Err(format!("unix:{}: this system has no Unix sockets; reach the module over loopback TCP", path.display()))
}

async fn exchange<S>(stream: S, request: Request<Full<Bytes>>) -> Result<Answer, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    Ok(Answer { status, body })
}

// ── Where a started module listens ──────────────────────────────────────────

/// The base URL a `listening …` line names: `listening unix:<path>` or
/// `listening <port>` (loopback TCP).
pub fn listening_address(line: &str) -> Option<String> {
    let rest = line.strip_prefix("listening ")?;
    if let Some(path) = rest.strip_prefix("unix:") {
        let path = path.trim();
        return (!path.is_empty()).then(|| format!("unix:{path}"));
    }
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let port: u16 = digits.parse().ok()?;
    Some(format!("http://127.0.0.1:{port}/"))
}

/// A fresh socket path for a module this host starts: short, since a socket
/// path is limited to about 100 bytes, in the system's temporary folder.
/// None where the system has no Unix sockets (the module listens on loopback
/// TCP instead).
pub fn fresh_socket_path() -> Option<PathBuf> {
    if !cfg!(unix) {
        return None;
    }
    let bytes = crate::http_out::random_bytes(6).ok()?;
    let path = std::env::temp_dir().join(format!("lf-{}.sock", crate::http_out::hex(&bytes)));
    (path.as_os_str().len() < 100).then_some(path)
}

/// The environment a started module is told where to listen by: the module
/// kit's `serve-module` (and any module that follows it) binds `MODULE_SOCKET`
/// when it is set, else loopback TCP on `PORT` (0 picks one).
pub fn listen_env(socket: Option<&Path>) -> Vec<(String, String)> {
    let mut env = vec![("PORT".to_string(), "0".to_string())];
    if let Some(socket) = socket {
        env.push(("MODULE_SOCKET".to_string(), socket.display().to_string()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_a_socket_a_loopback_port_or_a_remote_url() {
        assert_eq!(Address::parse("unix:/tmp/lf-1.sock"), Ok(Address::Unix("/tmp/lf-1.sock".into())));
        assert_eq!(
            Address::parse("http://127.0.0.1:5557/"),
            Ok(Address::Tcp { tls: false, host: "127.0.0.1".into(), port: 5557, path: "/".into() })
        );
        assert_eq!(
            Address::parse("https://store-abc.a.run.app/rpc"),
            Ok(Address::Tcp { tls: true, host: "store-abc.a.run.app".into(), port: 443, path: "/rpc".into() })
        );
        assert_eq!(Address::parse("http://[::1]:80/"), Ok(Address::Tcp { tls: false, host: "::1".into(), port: 80, path: "/".into() }));
        assert!(Address::parse("ftp://x/").is_err());
        assert!(Address::parse("unix:").is_err());
        assert!(Address::parse("unix:/s").unwrap().is_local());
        assert!(Address::parse("http://localhost:1/").unwrap().is_local());
        assert!(!Address::parse("http://10.0.0.2:1/").unwrap().is_local());
        assert!(!Address::parse("https://localhost/").unwrap().is_local());
    }

    #[test]
    fn a_listening_line_names_a_socket_or_a_port() {
        assert_eq!(listening_address("listening unix:/tmp/lf-a.sock").as_deref(), Some("unix:/tmp/lf-a.sock"));
        assert_eq!(listening_address("listening 5123").as_deref(), Some("http://127.0.0.1:5123/"));
        assert_eq!(listening_address("listening 5123 (acme)").as_deref(), Some("http://127.0.0.1:5123/"));
        assert_eq!(listening_address("ready"), None);
    }
}
