//! `lf --contract-models`, `--contract-judge`, `--contract-files`: lf's
//! built-in models, judge and files modules served as modules
//! (crate::slot_server), each slot's methods as adapter protocol 2 calls
//! (docs/contracts/models-slot.md, judge-slot.md, files-slot.md), so the
//! language-neutral conformance suites (engine-contracts `slots/`) hold them
//! to the meaning a third-party module filling the slot is held to.
//!
//! - models (`@lf/anthropic`): its settings ride on each request
//!   (`api_key`, `base_url`), as they would for any module; it publishes
//!   its prices (`models.prices`).
//! - judge (`@lf/judge`): declines every question, saying why.
//! - files (`@lf/local-files`): a fresh folder of its own.

use crate::documents::Documents;
use crate::json::Js;
use crate::obj;
#[cfg(feature = "anthropic")]
use crate::secrets::{Binding, Credential, Origin};
use crate::slot_server::{Listen, Refusal};

#[cfg(feature = "anthropic")]
pub const MODELS_METHODS: &[&str] = &["models.call", "models.prices"];
pub const JUDGE_METHODS: &[&str] = &["judge.arbitrate"];
pub const FILES_METHODS: &[&str] = &["files.put", "files.owns", "files.open"];

#[cfg(feature = "anthropic")]
pub async fn serve_models(listen: Listen) -> Result<(), String> {
    let manifest = crate::slot_server::manifest(crate::core::ANTHROPIC, "models", MODELS_METHODS);
    crate::slot_server::serve_async(listen, manifest, |method: String, params: Js, settings: Js| async move {
        match method.as_str() {
            "models.call" => {}
            "models.prices" => return Ok(crate::models::price_table_js(crate::models::builtin_prices())),
            other => return Err(Refusal::unknown(other)),
        }
        let fields = match &settings {
            Js::Obj(given) => given.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
            _ => Default::default(),
        };
        let credentials = vec![Credential {
            name: "anthropic".into(),
            external: crate::core::ANTHROPIC.into(),
            binding: Binding::Legacy,
            fields,
            origin: Origin::default(),
        }];
        crate::llm_calls::host_model_call(&params, &credentials).await.map_err(|message| {
            if message.starts_with("a models door request is") || message.contains("is not a model a call names") {
                Refusal::bad_request(format!("models.call: {message}"))
            } else {
                Refusal::failed(message)
            }
        })
    })
    .await
}

pub async fn serve_judge(listen: Listen) -> Result<(), String> {
    let manifest = crate::slot_server::manifest(crate::core::JUDGE, "judge", JUDGE_METHODS);
    crate::slot_server::serve(listen, manifest, |method, params, _settings| match method {
        "judge.arbitrate" => {
            if !matches!(params.get("candidates"), Some(Js::Arr(_))) {
                return Err(Refusal::bad_request("judge.arbitrate: candidates: expected a list"));
            }
            Ok(Js::from(obj! {
                "index" => Js::Null,
                "judgeUnavailable" => Js::str("lf's judge (@lf/judge) declines every question yet: an ambiguous match creates a new record"),
                "cost" => Js::Arr(Vec::new()),
            }))
        }
        other => Err(Refusal::unknown(other)),
    })
    .await
}

pub async fn serve_files(listen: Listen) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("lf-files-{}", uuid::Uuid::new_v4()));
    let documents = Documents::new(&dir);
    let manifest = crate::slot_server::manifest(crate::core::LOCAL_FILES, "files", FILES_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| {
        let text = |key: &str| params.get(key).and_then(Js::as_str).ok_or_else(|| Refusal::bad_request(format!("{method}: {key}: expected a string")));
        match method {
            "files.put" => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(text("bytes")?)
                    .map_err(|e| Refusal::bad_request(format!("files.put: bytes: not base64 ({e})")))?;
                documents.put(text("tenant")?, &bytes, text("name")?, text("contentType")?).map(Js::from).map_err(Refusal::failed)
            }
            "files.owns" => Ok(Js::Bool(documents.owns(text("objectUri")?, text("tenant")?))),
            "files.open" => {
                let bytes = documents.open(text("objectUri")?).map_err(|m| Refusal::new("not_found", m))?;
                Ok(Js::from(obj! { "bytes" => Js::str(crate::http_out::base64(&bytes)) }))
            }
            other => Err(Refusal::unknown(other)),
        }
    })
    .await
}
