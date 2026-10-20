//! The ocr slot (docs/contracts/ocr-slot.md): a scanned PDF's or an image's
//! bytes in, their text out. lf builds no OCR in, so the slot is empty unless
//! lf.yaml's `core: { ocr: … }` names a module (a process or a remote url),
//! reached over the slot's methods (crate::slot_client).
//!
//! Two callers ask it:
//! - the host's file-to-text (`files.resolveFileText`, which `extract()` and
//!   a file's text use): an image always, a PDF only when it has no usable
//!   text layer of its own (crate::pdf_text). The read's cost is charged to
//!   the run, as a model call's is, under `ocr:<the module's label>`.
//! - a module lf started, through the OCR door (`ctx.ocr`): the door bills
//!   nothing itself; the module charges the read to the call that asked, so
//!   the cost reaches the run on that call's answer, as the models door's does.
//!
//! An empty slot refuses by name: a scanned file is unreadable, saying so.

use std::sync::{Arc, Mutex, RwLock};

use base64::Engine;

use crate::json::{Js, Obj};
use crate::obj;
use crate::slot_client::{SlotClient, SlotError};

pub const OCR_METHODS: &[&str] = &["ocr.read"];
pub const PRICES_METHOD: &str = "ocr.prices";
/// The code a module refuses bytes of a type it does not read with.
pub const UNSUPPORTED_TYPE: &str = "unsupported_type";

pub const EMPTY: &str = "the ocr slot is empty: name an OCR module in lf.yaml's `core: { ocr: … }` (docs/core-slots.md), such as @listen-fire/document-ai";

const BUDGET_SPENT: &str = "this run's cost budget is spent: the OCR read was refused before it started";

static OCR: RwLock<Option<Arc<OcrModule>>> = RwLock::new(None);

/// The module filling the slot for this process; None when it is empty.
pub fn module() -> Option<Arc<OcrModule>> {
    OCR.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Fill the slot (crate::remote_slots `install`).
pub fn install(client: Option<Arc<SlotClient>>) {
    *OCR.write().unwrap_or_else(|p| p.into_inner()) = client.map(|client| Arc::new(OcrModule::new(client)));
}

/// The ocr slot's module, and the price per page it publishes (`ocr.prices`),
/// asked when first needed and kept for the process.
pub struct OcrModule {
    pub client: Arc<SlotClient>,
    /// `Some(None)` once asked of a module that publishes none.
    per_page: Mutex<Option<Option<f64>>>,
}

/// One file to read.
pub struct Read<'a> {
    pub bytes: &'a [u8],
    pub content_type: &'a str,
    pub name: Option<&'a str>,
    pub label: &'a str,
}

/// What the module read: the text, the pages, and what they cost, line by line.
#[derive(Debug, PartialEq)]
pub struct Answer {
    pub text: String,
    pub pages: u64,
    pub cost: Vec<(String, i64)>,
}

#[derive(Debug, PartialEq)]
pub enum Refused {
    /// The module's own refusal or failure, its code kept.
    Module(SlotError),
    /// It read pages and reported no cost, publishing no free price: a read
    /// the run's cost cap cannot count is refused, as an unpriced model call is.
    Unpriced(String),
}

impl Refused {
    pub fn message(&self) -> &str {
        match self {
            Refused::Module(error) => &error.message,
            Refused::Unpriced(message) => message,
        }
    }
}

impl OcrModule {
    pub fn new(client: Arc<SlotClient>) -> OcrModule {
        OcrModule { client, per_page: Mutex::new(None) }
    }

    /// The module's price of a page in dollars; None for a module that
    /// publishes none. A failed ask is not kept: the next read asks again.
    pub async fn per_page(&self) -> Result<Option<f64>, String> {
        if let Some(known) = *self.per_page.lock().unwrap_or_else(|p| p.into_inner()) {
            return Ok(known);
        }
        // Asked only of a module whose manifest lists it: the method is optional.
        let manifest = self.client.call_async("manifest", Obj::new()).await?;
        let lists = manifest.get("methods").and_then(Js::as_array).is_some_and(|methods| methods.iter().any(|m| m.as_str() == Some(PRICES_METHOD)));
        let published = match lists {
            true => {
                let answer = self.client.call_async(PRICES_METHOD, Obj::new()).await?;
                let price = match answer.get("perPage") {
                    Some(Js::Num(n)) => n.as_f64().filter(|p| p.is_finite() && *p >= 0.0),
                    _ => None,
                };
                Some(price.ok_or_else(|| format!("{}: ocr.prices answered {}, not {{ perPage }}", self.client.label, answer.to_json()))?)
            }
            false => None,
        };
        *self.per_page.lock().unwrap_or_else(|p| p.into_inner()) = Some(published);
        Ok(published)
    }

    /// One `ocr.read`.
    pub async fn read(&self, read: &Read<'_>) -> Result<Answer, Refused> {
        let mut params = obj! {
            "bytes" => Js::Str(crate::http_out::base64(read.bytes)),
            "contentType" => Js::str(read.content_type),
            "label" => Js::str(read.label),
        };
        if let Some(name) = read.name {
            params.insert("name".into(), Js::str(name));
        }
        let answer = self.client.call_async_coded("ocr.read", params).await.map_err(Refused::Module)?;
        let shape = || {
            Refused::Module(SlotError {
                code: "module_error".into(),
                message: format!("{}: ocr.read answered {}, not {{ text, pages, cost }}", self.client.label, answer.to_json()),
                data: None,
            })
        };
        let text = answer.get("text").and_then(Js::as_str).ok_or_else(shape)?.to_string();
        let pages = match answer.get("pages") {
            Some(Js::Num(n)) => n.as_u64().ok_or_else(shape)?,
            _ => return Err(shape()),
        };
        let cost = crate::remote_slots::cost_lines(answer.get("cost"));
        let charged: i64 = cost.iter().map(|(_, micro)| micro).sum();
        if pages > 0 && charged == 0 {
            let free = self.per_page().await.map_err(|message| Refused::Module(SlotError { code: "module_error".into(), message, data: None }))? == Some(0.0);
            if !free {
                return Err(Refused::Unpriced(format!(
                    "{}: ocr.read answered {pages} pages read and no cost: a read reports what it cost (docs/contracts/ocr-slot.md), and an answer the run's cost cap cannot count is refused",
                    self.client.label
                )));
            }
        }
        Ok(Answer { text, pages, cost })
    }
}

/// A file the host's file-to-text hands to OCR.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scanned {
    /// A PDF with no usable text layer, and its pages where lf could count them.
    /// A build without the `pdf` feature reads no PDF, so hands none on.
    #[cfg_attr(not(feature = "pdf"), allow(dead_code))]
    Pdf { pages: Option<u32> },
    Image,
}

/// The image types an OCR module is asked to read, by content type or extension.
const IMAGE_TYPES: &[(&str, &[&str])] = &[
    ("image/png", &["png"]),
    ("image/jpeg", &["jpg", "jpeg"]),
    ("image/gif", &["gif"]),
    ("image/tiff", &["tif", "tiff"]),
    ("image/bmp", &["bmp"]),
    ("image/webp", &["webp"]),
];

/// The image type a file is, by its content type or else its extension.
pub fn image_type(content_type: &str, extension: &str) -> Option<&'static str> {
    let base = content_type.split(';').next().unwrap_or_default().trim().to_lowercase();
    IMAGE_TYPES.iter().find(|(t, extensions)| if base.is_empty() { extensions.contains(&extension) } else { *t == base }).map(|(t, _)| *t)
}

/// `files.resolveFileText`'s answer for a scanned file: its text read by
/// the slot's module, or why there is none; a budget refusal when the run
/// cannot afford the read. Err fails the run (an unpriced answer).
pub async fn file_text(module: Option<&OcrModule>, scanned: Scanned, bytes: &[u8], content_type: &str, name: Option<&str>, remaining: Option<f64>) -> Result<Js, String> {
    let unreadable = |why: &str, detail: String, cost: Js| Js::Obj(obj! { "unreadable" => Js::str(why), "detail" => Js::Str(detail), "cost" => cost });
    // A PDF's failure says both halves, as the platform's does: either one
    // alone sends the reader after the wrong thing.
    let said = |message: &str| match scanned {
        Scanned::Pdf { .. } => format!("no text layer; {message}"),
        Scanned::Image => format!("an image is read by OCR; {message}"),
    };
    let Some(module) = module else { return Ok(unreadable("extraction_failed", said(EMPTY), Js::Arr(Vec::new()))) };
    if let Some(remaining) = remaining {
        let pages = match scanned {
            Scanned::Pdf { pages } => pages.unwrap_or(1),
            Scanned::Image => 1,
        };
        let per_page = match module.per_page().await {
            Ok(price) => price.unwrap_or(0.0),
            Err(message) => return Ok(unreadable("extraction_failed", said(&message), Js::Arr(Vec::new()))),
        };
        // The least the read can cost, refused up front as a prompt that
        // alone costs more than the run has left is.
        if remaining <= 0.0 || f64::from(pages) * per_page * 1_000_000.0 > remaining {
            return Ok(Js::Obj(obj! {
                "error" => Js::Obj(obj! { "kind" => Js::str("budget"), "message" => Js::str(BUDGET_SPENT) }),
                "cost" => Js::Arr(Vec::new()),
            }));
        }
    }
    let read = Read { bytes, content_type, name, label: "file_text" };
    match module.read(&read).await {
        Ok(answer) => {
            let cost = Js::Arr(
                answer.cost.iter().map(|(label, micro)| Js::Obj(obj! { "source" => Js::Str(format!("ocr:{label}")), "microdollars" => Js::Num((*micro).into()) })).collect(),
            );
            let text = answer.text.replace('\u{0}', " ");
            if text.trim().is_empty() {
                return Ok(Js::Obj(obj! { "unreadable" => Js::str("no_text"), "cost" => cost }));
            }
            Ok(Js::Obj(obj! { "text" => Js::Str(text), "cost" => cost }))
        }
        Err(Refused::Module(error)) if error.code == UNSUPPORTED_TYPE => Ok(unreadable("unsupported_type", error.message, Js::Arr(Vec::new()))),
        Err(Refused::Module(error)) => Ok(unreadable("extraction_failed", said(&error.message), Js::Arr(Vec::new()))),
        Err(Refused::Unpriced(message)) => Err(message),
    }
}

/// A read asked over the wire (the OCR door, `lf --contract-ocr-slot`):
/// `{ bytes, contentType, name?, label }`, its bytes decoded.
pub fn request_of(params: &Js) -> Result<(Vec<u8>, String, Option<String>, String), String> {
    let text = |key: &str| params.get(key).and_then(Js::as_str).filter(|v| !v.is_empty());
    let bytes = text("bytes").ok_or("ocr.read: bytes: expected the file's bytes, base64")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(bytes).map_err(|e| format!("ocr.read: bytes: not base64 ({e})"))?;
    let content_type = text("contentType").ok_or("ocr.read: contentType: expected a string")?;
    let label = text("label").ok_or("ocr.read: label: expected a string")?;
    Ok((bytes, content_type.to_string(), text("name").map(str::to_string), label.to_string()))
}

/// An answer as the wire carries it: `{ text, pages, cost: [{ label, microdollars }] }`.
pub fn answer_js(answer: Answer) -> Js {
    Js::Obj(obj! {
        "text" => Js::Str(answer.text),
        "pages" => Js::Num(answer.pages.into()),
        "cost" => Js::Arr(answer.cost.into_iter().map(|(label, micro)| Js::Obj(obj! { "label" => Js::Str(label), "microdollars" => Js::Num(micro.into()) })).collect()),
    })
}

/// The OCR door: a read by a module this process started, for a module call
/// that asked (`ctx.ocr`). Its status and body.
pub async fn door(module: Option<&OcrModule>, body: &Js) -> (u16, Js) {
    let refused = |status: u16, code: &str, message: String| (status, Js::Obj(obj! { "error" => Js::str(code), "message" => Js::Str(message) }));
    let (bytes, content_type, name, label) = match request_of(body) {
        Ok(read) => read,
        Err(message) => return refused(400, "bad_request", message),
    };
    let Some(module) = module else { return refused(503, "ocr_slot_empty", EMPTY.to_string()) };
    match module.read(&Read { bytes: &bytes, content_type: &content_type, name: name.as_deref(), label: &label }).await {
        Ok(answer) => (200, answer_js(answer)),
        Err(Refused::Module(error)) => {
            let status = match error.code.as_str() {
                "bad_request" => 400,
                UNSUPPORTED_TYPE => 415,
                _ => 502,
            };
            refused(status, &error.code, error.message)
        }
        Err(Refused::Unpriced(message)) => refused(502, "unpriced", message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_is_known_by_its_content_type_or_else_its_extension() {
        assert_eq!(image_type("image/png", "bin"), Some("image/png"));
        assert_eq!(image_type("image/jpeg; charset=binary", ""), Some("image/jpeg"));
        assert_eq!(image_type("", "jpg"), Some("image/jpeg"));
        assert_eq!(image_type("application/pdf", "png"), None);
        assert_eq!(image_type("image/svg+xml", "svg"), None);
    }

    #[test]
    fn a_wire_read_needs_its_bytes_type_and_label() {
        let read = Js::Obj(obj! { "bytes" => Js::str("aGk="), "contentType" => Js::str("image/png"), "label" => Js::str("web") });
        assert_eq!(request_of(&read).unwrap(), (b"hi".to_vec(), "image/png".to_string(), None, "web".to_string()));
        assert!(request_of(&Js::Obj(obj! { "contentType" => Js::str("image/png"), "label" => Js::str("web") })).unwrap_err().contains("bytes"));
        assert!(request_of(&Js::Obj(obj! { "bytes" => Js::str("!!"), "contentType" => Js::str("image/png"), "label" => Js::str("web") })).unwrap_err().contains("not base64"));
    }

    #[tokio::test]
    async fn an_empty_slot_leaves_a_scanned_file_unreadable_saying_so() {
        let answer = file_text(None, Scanned::Pdf { pages: Some(2) }, b"%PDF-", "application/pdf", None, None).await.unwrap();
        assert_eq!(answer.get("unreadable"), Some(&Js::str("extraction_failed")));
        let detail = answer.get("detail").and_then(Js::as_str).unwrap();
        assert!(detail.starts_with("no text layer; the ocr slot is empty"), "{detail}");
        let (status, body) = door(None, &Js::Obj(obj! { "bytes" => Js::str("aGk="), "contentType" => Js::str("image/png"), "label" => Js::str("web") })).await;
        assert_eq!((status, body.get("error")), (503, Some(&Js::str("ocr_slot_empty"))));
    }

    /// An OCR module on a socket of its own, answering every `ocr.read` with
    /// `answer` (or refusing with `refusal`) and `ocr.prices` with `per_page`
    /// (none: not listed), counting the reads. Run inside a `LocalSet`.
    async fn ocr_module(answer: Result<Js, (&'static str, &'static str)>, per_page: Option<f64>) -> (OcrModule, Arc<std::sync::atomic::AtomicUsize>) {
        use crate::slot_server::{Listen, Refusal};
        let socket = std::env::temp_dir().join(format!("lf-ocr-{}.sock", uuid::Uuid::new_v4()));
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = reads.clone();
        let methods: &[&str] = if per_page.is_some() { &["ocr.read", "ocr.prices"] } else { &["ocr.read"] };
        let manifest = crate::slot_server::manifest("acme_ocr", "ocr", methods);
        tokio::task::spawn_local(crate::slot_server::serve_async(Listen::Unix(socket.clone()), manifest, move |method: String, _params: Js, _settings: Js| {
            let answered = match (method.as_str(), per_page) {
                ("ocr.read", _) => {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    answer.clone().map_err(|(code, message)| Refusal::new(code, message))
                }
                ("ocr.prices", Some(price)) => Ok(Js::Obj(obj! { "perPage" => Js::Num(serde_json::Number::from_f64(price).unwrap()) })),
                (other, _) => Err(Refusal::unknown(other)),
            };
            async move { answered }
        }));
        while !socket.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let process = crate::core::ProcessModule { dir: std::env::temp_dir(), command: Vec::new(), env: Default::default(), url: Some(format!("unix:{}", socket.display())), auth_field: None };
        let client = SlotClient::start("ocr", "acme_ocr", &process, &Default::default()).unwrap();
        (OcrModule::new(Arc::new(client)), reads)
    }

    fn read_answer(text: &str, pages: u64, microdollars: i64) -> Js {
        Js::parse(format!(r#"{{"text":{},"pages":{pages},"cost":[{{"label":"acme/ocr","microdollars":{microdollars}}}]}}"#, Js::str(text).to_json()).as_bytes()).unwrap()
    }

    #[tokio::test]
    async fn a_scanned_pdf_is_read_by_the_module_and_its_cost_charged_to_the_run() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (module, _) = ocr_module(Ok(read_answer("ACME ROBOTICS", 2, 3_000)), Some(0.0015)).await;
                let answer = file_text(Some(&module), Scanned::Pdf { pages: Some(2) }, b"%PDF-", "application/pdf", Some("deck.pdf"), Some(1_000_000.0)).await.unwrap();
                assert_eq!(answer.get("text"), Some(&Js::str("ACME ROBOTICS")));
                assert_eq!(answer.get("cost").unwrap().to_json(), r#"[{"source":"ocr:acme/ocr","microdollars":3000}]"#);
            })
            .await;
    }

    #[tokio::test]
    async fn a_read_the_run_cannot_afford_at_the_published_price_is_refused_before_it_is_made() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (module, reads) = ocr_module(Ok(read_answer("x", 4, 6_000)), Some(0.0015)).await;
                // Four pages at $0.0015 is 6,000 microdollars.
                let refused = file_text(Some(&module), Scanned::Pdf { pages: Some(4) }, b"%PDF-", "application/pdf", None, Some(5_999.0)).await.unwrap();
                assert_eq!(refused.get("error").and_then(|e| e.get("kind")), Some(&Js::str("budget")));
                assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 0);
                let read = file_text(Some(&module), Scanned::Pdf { pages: Some(4) }, b"%PDF-", "application/pdf", None, Some(6_000.0)).await.unwrap();
                assert_eq!(read.get("text"), Some(&Js::str("x")));
            })
            .await;
    }

    #[tokio::test]
    async fn pages_read_at_no_cost_fail_the_run_unless_the_module_is_published_free() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (unpriced, _) = ocr_module(Ok(read_answer("x", 1, 0)), None).await;
                let message = file_text(Some(&unpriced), Scanned::Image, b"png", "image/png", None, None).await.unwrap_err();
                assert!(message.contains("answered 1 pages read and no cost"), "{message}");
                let (free, _) = ocr_module(Ok(read_answer("x", 1, 0)), Some(0.0)).await;
                assert!(file_text(Some(&free), Scanned::Image, b"png", "image/png", None, None).await.is_ok());
            })
            .await;
    }

    #[tokio::test]
    async fn a_modules_refusal_reads_as_why_the_file_is_unreadable() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (picky, _) = ocr_module(Err((UNSUPPORTED_TYPE, "acme reads no GIFs")), None).await;
                let answer = file_text(Some(&picky), Scanned::Image, b"gif", "image/gif", None, None).await.unwrap();
                assert_eq!(answer.get("unreadable"), Some(&Js::str("unsupported_type")));
                let (down, _) = ocr_module(Err(("module_error", "the backend is down")), None).await;
                let answer = file_text(Some(&down), Scanned::Pdf { pages: None }, b"%PDF-", "application/pdf", None, None).await.unwrap();
                assert_eq!(answer.get("detail").and_then(Js::as_str), Some("no text layer; the backend is down"));
                let (status, body) = door(Some(&picky), &Js::Obj(obj! { "bytes" => Js::str("aGk="), "contentType" => Js::str("image/gif"), "label" => Js::str("web") })).await;
                assert_eq!((status, body.get("error")), (415, Some(&Js::str(UNSUPPORTED_TYPE))));
            })
            .await;
    }

    #[tokio::test]
    async fn a_blank_scan_is_no_text_and_still_costs_what_it_cost() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (module, _) = ocr_module(Ok(read_answer("  \n ", 1, 1_500)), None).await;
                let answer = file_text(Some(&module), Scanned::Image, b"png", "image/png", None, None).await.unwrap();
                assert_eq!(answer.get("unreadable"), Some(&Js::str("no_text")));
                assert_eq!(answer.get("cost").and_then(Js::as_array).map(<[Js]>::len), Some(1));
            })
            .await;
    }
}
