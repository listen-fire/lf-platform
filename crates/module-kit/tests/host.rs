//! A host serving an adapter and a limiter, over TCP and a Unix socket:
//! each at its own path, answering in the protocol's envelope, refusing what
//! the protocol refuses.

use std::cell::Cell;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use module_kit::core::Grant;
use module_kit::*;

struct Tiny;

impl Adapter for Tiny {
    fn manifest(&self) -> AdapterManifest {
        AdapterManifest::new("tiny").optional(["wakeKeys"])
    }

    async fn list_entry_points(&self, ctx: &Ctx) -> Answer<Vec<EntryPoint>> {
        ctx.spent("lookup", 1500.0);
        Ok(vec![EntryPoint { type_id: "Thing".into(), display_name: "Thing".into(), writable: false, readable: true, fires: None, description: None, rest: Obj::new() }])
    }

    async fn describe(&self, _: &Ctx, _: Describe) -> Answer<Option<TypeDescriptor>> {
        Ok(None)
    }

    async fn get_related(&self, _: &Ctx, _: GetRelated) -> Answer<Vec<Related>> {
        // Typeless: the protocol refuses it, so the host does too.
        let mut position = Position::stable("tiny", "Thing", "t-1", Obj::new());
        position.record_type = None;
        Ok(vec![Related { position }])
    }

    async fn optional(&self, ctx: &Ctx, _: &str, _: Js) -> Answer<Js> {
        Ok(Js::strings([ctx.setting("prefix").unwrap_or("none")]))
    }
}

#[derive(Default)]
struct OnePermit {
    held: Cell<bool>,
}

impl Limiter for OnePermit {
    async fn open(&self, _: &Ctx, _: module_kit::core::LimiterOpen) -> Answer<()> {
        Ok(())
    }

    async fn acquire(&self, _: &Ctx, _: module_kit::core::LimiterAcquire) -> Answer<Grant> {
        Ok(if self.held.replace(true) { Grant::Refused { retry_at: "2026-10-19T00:00:01.000Z".into() } } else { Grant::Granted { permit: "p-1".into() } })
    }

    async fn release(&self, _: &Ctx, _: module_kit::core::LimiterRelease) -> Answer<()> {
        self.held.set(false);
        Ok(())
    }

    async fn throttle(&self, _: &Ctx, _: module_kit::core::LimiterThrottle) -> Answer<()> {
        Ok(())
    }
}

fn host() -> Host {
    Host::new().adapter(Tiny).limiter("one_permit", OnePermit::default()).token(Some("sesame".into()))
}

/// One POST; its status and body.
async fn post<S>(stream: S, path: &str, bearer: Option<&str>, body: &str) -> (u16, String)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
    tokio::task::spawn_local(connection);
    let mut request = Request::post(path).header("host", "module-host");
    if let Some(token) = bearer {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = sender.send_request(request.body(Full::new(Bytes::from(body.to_string()))).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    (status, String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

fn call(method: &str, params: &str) -> String {
    format!(r#"{{"protocolVersion":"2","method":"{method}","cacheScopeId":"c","params":{params},"settings":{{"prefix":"p-"}}}}"#)
}

#[tokio::test(flavor = "current_thread")]
async fn over_tcp_each_module_answers_at_its_own_path() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let listener = Listener::bind(&Address::Tcp(([127, 0, 0, 1], 0).into())).await.unwrap();
            let port: u16 = listener.address().parse().unwrap();
            tokio::task::spawn_local(host().serve(listener));
            let tcp = || async move { tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap() };

            let (status, body) = post(tcp().await, "/tiny", Some("sesame"), &call("manifest", "{}")).await;
            assert_eq!(status, 200);
            assert!(body.starts_with(r#"{"ok":true,"result":{"protocolVersion":2,"kind":"adapter","adapterType":"tiny","#), "{body}");
            assert!(body.contains(r#""wakeKeys"]"#), "{body}");

            let (_, body) = post(tcp().await, "/tiny", Some("sesame"), &call("listEntryPoints", "{}")).await;
            assert_eq!(
                body,
                r#"{"ok":true,"result":[{"typeId":"Thing","displayName":"Thing","writable":false,"readable":true}],"cost":[{"microdollars":1500.0,"label":"lookup"}]}"#
            );

            let (_, body) = post(tcp().await, "/tiny", Some("sesame"), &call("wakeKeys", r#"{"raw":{}}"#)).await;
            assert_eq!(body, r#"{"ok":true,"result":["p-"]}"#, "settings ride every request");

            let (_, body) = post(tcp().await, "/tiny", Some("sesame"), &call("poll", "{}")).await;
            assert!(body.contains(r#""code":"method_not_implemented""#), "{body}");

            let (_, body) = post(tcp().await, "/tiny", Some("sesame"), &call("describe", "{}")).await;
            assert!(body.contains(r#""code":"bad_request","message":"describe: missing field `typeId`"#), "{body}");

            let related = r#"{"position":{"recordType":"Thing","identity":{"kind":"stable","recordId":"t-1"}},"fieldId":"x"}"#;
            let (_, body) = post(tcp().await, "/tiny", Some("sesame"), &call("getRelated", related)).await;
            assert!(body.contains("this module's answer is not the protocol's") && body.contains("0.position.recordType"), "{body}");

            let (_, body) = post(tcp().await, "/one_permit", Some("sesame"), &call("limiter.acquire", r#"{"key":"k","cost":1,"limits":[],"holdMs":1000}"#)).await;
            assert_eq!(body, r#"{"ok":true,"result":{"granted":true,"permit":"p-1"}}"#);
            let (_, body) = post(tcp().await, "/one_permit", Some("sesame"), &call("limiter.acquire", r#"{"key":"k","cost":1,"limits":[],"holdMs":1000}"#)).await;
            assert_eq!(body, r#"{"ok":true,"result":{"granted":false,"retryAt":"2026-10-19T00:00:01.000Z"}}"#);
            let (_, body) = post(tcp().await, "/one_permit", Some("sesame"), &call("manifest", "{}")).await;
            assert!(body.contains(r#""kind":"core","adapterType":"one_permit""#) && body.contains(r#""slot":"limiter""#), "{body}");

            let (status, _) = post(tcp().await, "/tiny", None, &call("manifest", "{}")).await;
            assert_eq!(status, 401, "the token is required");
            let (status, body) = post(tcp().await, "/", Some("sesame"), &call("manifest", "{}")).await;
            assert_eq!((status, body.as_str()), (404, "no module at / (this host serves /tiny, /one_permit)"));
            let (_, body) = post(tcp().await, "/tiny", Some("sesame"), r#"{"protocolVersion":"1","method":"manifest","params":{}}"#).await;
            assert!(body.contains(r#""code":"protocol_version""#), "{body}");
            let (status, _) = post(tcp().await, "/tiny", Some("sesame"), "not json").await;
            assert_eq!(status, 400);
        })
        .await;
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn over_a_unix_socket_a_lone_module_answers_at_the_root_too() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let path = std::env::temp_dir().join(format!("module-kit-{}.sock", std::process::id()));
            let listener = Listener::bind(&Address::Unix(path.clone())).await.unwrap();
            assert_eq!(listener.address(), format!("unix:{}", path.display()));
            tokio::task::spawn_local(Host::new().adapter(Tiny).serve(listener));
            for at in ["/", "/tiny"] {
                let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
                let (status, body) = post(stream, at, None, &call("manifest", "{}")).await;
                assert_eq!(status, 200, "{at}: {body}");
                assert!(body.contains(r#""adapterType":"tiny""#), "{at}: {body}");
            }
            std::fs::remove_file(&path).ok();
        })
        .await;
}
