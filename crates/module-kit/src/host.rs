//! The module host: one process serving one or several crate modules over
//! adapter protocol 2, each under its own path (`/<name>`; `/` too when it
//! serves only one). A shared host carries trusted modules together; an
//! untrusted module gets a host of its own. The host never links into lf: lf
//! reaches it as any module server, by `url`, or by `command` when it starts
//! the host itself.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::rc::Rc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use module_wire::envelope::{ADAPTER_TEAM_HEADER, PROTOCOL_VERSION, PROTOCOL_VERSION_CODE};
use module_wire::json::{Js, Obj};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;

use crate::adapter::{Adapter, AdapterModule};
use crate::context::{Ctx, ModuleError};
use crate::core::{Limiter, LimiterModule, LoopGuard, LoopGuardModule, Ocr, OcrModule, Store, StoreModule, Wake, WakeModule};
use crate::module::Module;
use crate::plugin::{PluginModule, Plugins};

/// Where a host listens: loopback TCP (another box reaches it through
/// whatever fronts it), or a Unix socket on the same box.
#[derive(Debug, Clone)]
pub enum Address {
    Tcp(SocketAddr),
    Unix(PathBuf),
}

impl Address {
    /// From the environment, as serve-module reads it: `LF_MODULE_SOCKET`
    /// names a Unix socket; otherwise loopback on `PORT` (0, or unset, picks
    /// one). `--socket <path>` and `--port <n>` override them.
    pub fn from_env_and_args(args: impl IntoIterator<Item = String>) -> Result<Address, String> {
        let (mut socket, mut port) = (std::env::var("LF_MODULE_SOCKET").ok().filter(|s| !s.is_empty()), std::env::var("PORT").ok());
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--socket" => socket = Some(args.next().ok_or("--socket needs a path")?),
                "--port" => port = Some(args.next().ok_or("--port needs a number")?),
                other => return Err(format!("unknown argument {other} (expected --socket <path> or --port <n>)")),
            }
        }
        if let Some(path) = socket {
            return Ok(Address::Unix(PathBuf::from(path)));
        }
        let port = match port.as_deref() {
            None | Some("") => 0,
            Some(text) => text.parse::<u16>().map_err(|_| format!("PORT: not a port: {text}"))?,
        };
        Ok(Address::Tcp(SocketAddr::from(([127, 0, 0, 1], port))))
    }
}

/// A bound listener.
pub enum Listener {
    Tcp(TcpListener),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener, PathBuf),
}

impl Listener {
    pub async fn bind(address: &Address) -> std::io::Result<Listener> {
        match address {
            Address::Tcp(addr) => Ok(Listener::Tcp(TcpListener::bind(addr).await?)),
            #[cfg(unix)]
            Address::Unix(path) => {
                // A socket left by a host that died is in the way of this one.
                use std::os::unix::fs::FileTypeExt;
                if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket()) {
                    std::fs::remove_file(path)?;
                }
                Ok(Listener::Unix(tokio::net::UnixListener::bind(path)?, path.clone()))
            }
            #[cfg(not(unix))]
            Address::Unix(_) => Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Unix sockets need a Unix host")),
        }
    }

    /// What the `listening` line names: the port, or `unix:<path>`.
    pub fn address(&self) -> String {
        match self {
            Listener::Tcp(listener) => listener.local_addr().map(|a| a.port().to_string()).unwrap_or_default(),
            #[cfg(unix)]
            Listener::Unix(_, path) => format!("unix:{}", path.display()),
        }
    }
}

#[derive(Default)]
pub struct Host {
    modules: Vec<(String, Rc<dyn Module>)>,
    token: Option<String>,
}

impl Host {
    pub fn new() -> Host {
        Host::default()
    }

    /// Serve `module` at `/<name>`, `name` being its manifest's (its install's).
    pub fn module(mut self, module: impl Module + 'static) -> Host {
        let name = module.manifest().get("adapterType").and_then(Js::as_str).unwrap_or_default().to_string();
        assert!(!self.modules.iter().any(|(n, _)| *n == name), "two modules named \"{name}\" in one host");
        self.modules.push((name, Rc::new(module)));
        self
    }

    pub fn adapter(self, adapter: impl Adapter + 'static) -> Host {
        self.module(AdapterModule::new(adapter))
    }

    pub fn plugins(self, plugins: impl Plugins + 'static) -> Host {
        self.module(PluginModule::new(plugins))
    }

    pub fn store(self, name: &str, store: impl Store + 'static) -> Host {
        self.module(StoreModule::new(name, store))
    }

    pub fn limiter(self, name: &str, limiter: impl Limiter + 'static) -> Host {
        self.module(LimiterModule::new(name, limiter))
    }

    pub fn loop_guard(self, name: &str, guard: impl LoopGuard + 'static) -> Host {
        self.module(LoopGuardModule::new(name, guard))
    }

    pub fn wake(self, name: &str, wake: impl Wake + 'static) -> Host {
        self.module(WakeModule::new(name, wake))
    }

    pub fn ocr(self, name: &str, ocr: impl Ocr + 'static) -> Host {
        self.module(OcrModule::new(name, ocr))
    }

    /// Require `Authorization: Bearer <token>` on every call.
    pub fn token(mut self, token: Option<String>) -> Host {
        self.token = token.filter(|t| !t.is_empty());
        self
    }

    /// Serve until the listener fails. Every connection is driven on this
    /// thread: call it inside a `LocalSet`.
    pub async fn serve(self, listener: Listener) -> std::io::Result<()> {
        let host = Rc::new(self);
        loop {
            match &listener {
                Listener::Tcp(tcp) => {
                    let (stream, _) = tcp.accept().await?;
                    host.clone().connect(stream);
                }
                #[cfg(unix)]
                Listener::Unix(unix, _) => {
                    let (stream, _) = unix.accept().await?;
                    host.clone().connect(stream);
                }
            }
        }
    }

    fn connect(self: Rc<Host>, stream: impl AsyncRead + AsyncWrite + Unpin + 'static) {
        tokio::task::spawn_local(async move {
            let service = hyper::service::service_fn(move |request| {
                let host = self.clone();
                async move { Ok::<_, std::convert::Infallible>(host.answer(request).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }

    /// The host as a process: binds where the environment and `args` say
    /// ([`Address::from_env_and_args`]), prints `listening <port>` (or
    /// `listening unix:<path>`) for whoever started it, and requires
    /// `MODULE_TOKEN` as the bearer when that is set.
    pub fn run(self, args: impl IntoIterator<Item = String>) -> Result<(), String> {
        let address = Address::from_env_and_args(args)?;
        if std::env::var("LF_EXIT_WITH_PARENT").is_ok_and(|v| !v.is_empty()) {
            exit_with_parent();
        }
        let host = self.token(std::env::var("MODULE_TOKEN").ok());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        tokio::task::LocalSet::new().block_on(&runtime, async move {
            let listener = Listener::bind(&address).await.map_err(|e| format!("{address:?}: {e}"))?;
            println!("listening {}", listener.address());
            host.serve(listener).await.map_err(|e| e.to_string())
        })
    }

    async fn answer(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        if request.method() != hyper::Method::POST {
            return plain(StatusCode::NOT_FOUND, "not found");
        }
        let path = request.uri().path().trim_matches('/').to_string();
        let (name, module) = match (path.as_str(), self.modules.as_slice()) {
            ("", [(name, only)]) => (name.clone(), only.clone()),
            (name, modules) => match modules.iter().find(|(n, _)| n == name) {
                Some((name, module)) => (name.clone(), module.clone()),
                None => {
                    let served: Vec<&str> = modules.iter().map(|(n, _)| n.as_str()).collect();
                    return plain(StatusCode::NOT_FOUND, &format!("no module at /{path} (this host serves /{})", served.join(", /")));
                }
            },
        };
        if let Some(token) = &self.token {
            let presented = request.headers().get("authorization").and_then(|v| v.to_str().ok());
            if presented != Some(format!("Bearer {token}").as_str()) {
                return plain(StatusCode::UNAUTHORIZED, "unauthorized");
            }
        }
        let team_id = request.headers().get(ADAPTER_TEAM_HEADER).and_then(|v| v.to_str().ok()).map(str::to_string);
        let Ok(body) = request.into_body().collect().await.map(|b| b.to_bytes()) else {
            return plain(StatusCode::BAD_REQUEST, "bad_request: the body could not be read");
        };
        let Ok(envelope) = Js::parse(&body) else {
            return plain(StatusCode::BAD_REQUEST, "bad_request: the body is not JSON");
        };
        let Some(method) = envelope.get("method").and_then(Js::as_str) else {
            return plain(StatusCode::BAD_REQUEST, "bad_request: not a request envelope (no method)");
        };
        if envelope.get("protocolVersion").and_then(Js::as_str) != Some(PROTOCOL_VERSION) {
            let refused = ModuleError::new(PROTOCOL_VERSION_CODE, format!("this module speaks adapter protocol {PROTOCOL_VERSION}"));
            return json(answered(Err(refused), &Ctx::default()));
        }
        let text = |key: &str| envelope.get(key).and_then(Js::as_str).map(str::to_string);
        let ctx = Ctx::new(team_id, text("cacheScopeId"), envelope.get("credential").cloned(), envelope.get("settings").cloned())
            .with_host_limits(crate::host_limits::HostLimits::of(&envelope))
            .with_host_doors(crate::host_ocr::HostDoors::of_env(&name));
        let params = envelope.get("params").cloned().unwrap_or(Js::Obj(Obj::new()));
        let result = match method {
            "manifest" => Ok(module.manifest()),
            other => module.call(&ctx, other, params).await,
        };
        json(answered(result, &ctx))
    }
}

/// The envelope's answer, with what rode beside the result.
fn answered(result: Result<Js, ModuleError>, ctx: &Ctx) -> Js {
    let mut answer = Obj::new();
    match result {
        Ok(result) => {
            answer.insert("ok".into(), Js::Bool(true));
            answer.insert("result".into(), result);
        }
        Err(error) => {
            answer.insert("ok".into(), Js::Bool(false));
            answer.insert("error".into(), error.to_wire());
        }
    }
    let beside = ctx.take_beside();
    if !beside.cost.is_empty() {
        let lines = beside
            .cost
            .into_iter()
            .filter_map(|(label, micro)| Some(Js::Obj(module_wire::obj! { "microdollars" => Js::Num(serde_json::Number::from_f64(micro)?), "label" => Js::str(label) })))
            .collect();
        answer.insert("cost".into(), Js::Arr(lines));
    }
    if let Some(update) = beside.credential_update {
        answer.insert("credentialUpdate".into(), update);
    }
    if let Some(seconds) = beside.retry_after_seconds.and_then(serde_json::Number::from_f64) {
        answer.insert("retryAfter".into(), Js::Num(seconds));
    }
    Js::Obj(answer)
}

fn json(body: Js) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_json())));
    response.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static("application/json"));
    response
}

/// The process ends when whoever started it does (serve-module's
/// `LF_EXIT_WITH_PARENT`): lf holds this process's stdin, so its end closing
/// is lf gone, through any shim in between (`cargo run`); being re-parented
/// to init is the same news from a parent that gave no stdin.
fn exit_with_parent() {
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
        std::process::exit(0);
    });
    #[cfg(unix)]
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if std::os::unix::process::parent_id() == 1 {
            std::process::exit(0);
        }
    });
}

fn plain(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(text.to_string())));
    *response.status_mut() = status;
    response
}
