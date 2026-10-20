//! The host's OCR slot (docs/contracts/ocr-slot.md), asked by a module lf
//! started: a scanned PDF's or an image's text, through the host's OCR door
//! (`LF_HOST_URL`, `LF_HOST_TOKEN`). The read's cost is charged to the call
//! that asked ([`Ctx::spent`]), so it reaches the run on that call's answer.
//!
//! ```no_run
//! # use module_kit::*;
//! # async fn read(ctx: &Ctx, pdf: &[u8]) -> Answer<String> {
//! let read = ctx.ocr(OcrFile { bytes: pdf, content_type: "application/pdf", name: Some("deck.pdf"), label: "acme.deck" }).await?;
//! Ok(read.text)
//! # }
//! ```
//!
//! A host whose ocr slot nothing fills refuses the read, saying so; a module
//! served by no host that names a door (`LF_HOST_URL` unset) is refused too.

use base64::Engine;
use module_wire::json::Js;
use module_wire::obj;
use serde::{Deserialize, Deserializer};

use crate::context::{Answer, Ctx, ModuleError};

/// The host's doors, as the host that started this module named them.
#[derive(Debug, Clone, PartialEq)]
pub struct HostDoors {
    /// `{LF_HOST_URL}/api/public/adapter/{module}`.
    pub base: String,
    pub token: String,
}

impl HostDoors {
    /// From `LF_HOST_URL` and `LF_HOST_TOKEN`, for the module served at `name`.
    pub fn of_env(name: &str) -> Option<HostDoors> {
        let url = std::env::var("LF_HOST_URL").ok().filter(|u| !u.is_empty())?;
        let token = std::env::var("LF_HOST_TOKEN").unwrap_or_default();
        Some(HostDoors { base: format!("{}/api/public/adapter/{name}", url.trim_end_matches('/')), token })
    }
}

/// One file for the OCR slot to read.
pub struct OcrFile<'a> {
    pub bytes: &'a [u8],
    /// `application/pdf`, or an image type (`image/png`, …).
    pub content_type: &'a str,
    pub name: Option<&'a str>,
    /// Names the read in cost lines and logs.
    pub label: &'a str,
}

/// What the slot read.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrText {
    pub text: String,
    pub pages: u64,
}

impl Ctx {
    /// The text of a file with no text layer, read by the host's ocr slot.
    pub async fn ocr(&self, file: OcrFile<'_>) -> Answer<OcrText> {
        let door = self.host_doors().ok_or_else(|| ModuleError::adapter("the ocr slot is empty: no host named its doors to this module (LF_HOST_URL)"))?;
        let mut request = obj! {
            "bytes" => Js::Str(base64::engine::general_purpose::STANDARD.encode(file.bytes)),
            "contentType" => Js::str(file.content_type),
            "label" => Js::str(file.label),
        };
        if let Some(name) = file.name {
            request.insert("name".into(), Js::str(name));
        }
        let url = format!("{}/ocr", door.base);
        let failed = |e: &dyn std::fmt::Display| ModuleError::adapter(format!("the host's OCR door at {url}: {e}"));
        let (status, body) = crate::host_limits::post_to_door(&url, &door.token, Js::Obj(request).to_json()).await.map_err(|e| failed(&e))?;
        let answer = Js::parse(&body).map_err(|e| failed(&e))?;
        if !(200..300).contains(&status) {
            // The door's own words: an empty slot says so.
            let message = answer.get("message").and_then(Js::as_str).map(str::to_string).unwrap_or_else(|| format!("answered {status}: {}", String::from_utf8_lossy(&body)));
            return Err(ModuleError::adapter(message));
        }
        let text = answer.get("text").and_then(Js::as_str).ok_or_else(|| failed(&"its answer has no text"))?.to_string();
        let pages = match answer.get("pages") {
            Some(Js::Num(n)) => n.as_u64().unwrap_or(0),
            _ => 0,
        };
        for line in answer.get("cost").and_then(Js::as_array).into_iter().flatten() {
            if let (Some(label), Some(Js::Num(micro))) = (line.get("label").and_then(Js::as_str), line.get("microdollars")) {
                self.spent(label, micro.as_f64().unwrap_or(0.0));
            }
        }
        Ok(OcrText { text, pages })
    }
}

/// A request's `bytes`, base64 on the wire, decoded (`#[serde(deserialize_with)]`).
pub fn base64_bytes<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let text = String::deserialize(deserializer)?;
    base64::engine::general_purpose::STANDARD.decode(text).map_err(|e| serde::de::Error::custom(format!("bytes: not base64 ({e})")))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper_util::rt::TokioIo;

    use super::*;

    /// A host's OCR door on loopback answering `status` and `answer`; every
    /// request it is sent, logged.
    async fn door(status: u16, answer: &'static str) -> (HostDoors, Rc<RefCell<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Rc::new(RefCell::new(Vec::new()));
        let seen = log.clone();
        tokio::task::spawn_local(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                let service = hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let seen = seen.clone();
                    async move {
                        let bearer = request.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                        let path = request.uri().path().to_string();
                        let body = String::from_utf8(request.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
                        seen.borrow_mut().push(format!("{path} {bearer} {body}"));
                        let mut response = hyper::Response::new(Full::new(Bytes::from(answer)));
                        *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                tokio::task::spawn_local(hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service));
            }
        });
        (HostDoors { base: format!("http://127.0.0.1:{port}/api/public/adapter/notes"), token: "host-token".into() }, log)
    }

    struct Shouting;
    impl crate::core::Ocr for Shouting {
        async fn read(&self, _: &Ctx, params: crate::core::OcrReadRequest) -> Answer<crate::core::OcrRead> {
            if params.content_type != "image/png" {
                return Err(ModuleError::new("unsupported_type", format!("no {}", params.content_type)));
            }
            let text = String::from_utf8_lossy(&params.bytes).to_uppercase();
            Ok(crate::core::OcrRead { text, pages: 1, cost: vec![crate::core::OcrCost { label: "shouting/ocr".into(), microdollars: 7 }] })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_ocr_module_gets_the_bytes_decoded_and_answers_the_slots_shape() {
        use crate::module::Module;
        let module = crate::core::OcrModule::new("shouting", Shouting);
        assert_eq!(module.manifest().get("slot"), Some(&Js::str("ocr")));
        let ctx = Ctx::default();
        let params = |content_type: &str| Js::Obj(obj! { "bytes" => Js::str("aGk="), "contentType" => Js::str(content_type), "label" => Js::str("t") });
        let answer = module.call(&ctx, "ocr.read", params("image/png")).await.unwrap();
        assert_eq!(answer.to_json(), r#"{"text":"HI","pages":1,"cost":[{"label":"shouting/ocr","microdollars":7}]}"#);
        assert_eq!(module.call(&ctx, "ocr.read", params("image/gif")).await.unwrap_err().code, "unsupported_type");
        let bad = Js::Obj(obj! { "bytes" => Js::str("!!"), "contentType" => Js::str("image/png"), "label" => Js::str("t") });
        assert_eq!(module.call(&ctx, "ocr.read", bad).await.unwrap_err().code, "bad_request");
    }

    fn file() -> OcrFile<'static> {
        OcrFile { bytes: b"%PDF", content_type: "application/pdf", name: Some("deck.pdf"), label: "notes.deck" }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_read_goes_through_the_door_and_its_cost_rides_the_call() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (doors, log) = door(200, r#"{"text":"ACME","pages":1,"cost":[{"label":"document-ai/ocr","microdollars":1500}]}"#).await;
                let ctx = Ctx::new(None, None, None, None).with_host_doors(Some(doors));
                assert_eq!(ctx.ocr(file()).await.unwrap(), OcrText { text: "ACME".into(), pages: 1 });
                assert_eq!(*log.borrow(), [r#"/api/public/adapter/notes/ocr Bearer host-token {"bytes":"JVBERg==","contentType":"application/pdf","label":"notes.deck","name":"deck.pdf"}"#]);
                assert_eq!(ctx.take_beside().cost, vec![("document-ai/ocr".to_string(), 1500.0)]);
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_empty_slot_is_refused_in_the_doors_words() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (doors, _) = door(503, r#"{"error":"ocr_slot_empty","message":"the ocr slot is empty: name one"}"#).await;
                let ctx = Ctx::new(None, None, None, None).with_host_doors(Some(doors));
                assert_eq!(ctx.ocr(file()).await.unwrap_err().message, "the ocr slot is empty: name one");
                let unhosted = Ctx::new(None, None, None, None);
                assert!(unhosted.ocr(file()).await.unwrap_err().message.contains("LF_HOST_URL"));
            })
            .await;
    }
}
