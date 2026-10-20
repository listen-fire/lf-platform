//! `lf --contract-ocr-slot`: the project's ocr slot served as an OCR module,
//! its methods (docs/contracts/ocr-slot.md) as adapter protocol 2 calls over
//! HTTP (crate::slot_server), each passed on through lf's own client of the
//! module (crate::ocr). The conformance cases (module-runtime
//! `module_wire/conformance.ts` `ocrSlotCases`) then hold lf's side of the
//! wire, its reading of an answer and its cost rule included, to the meaning
//! they hold the module to. lf builds no OCR in, so there is no `--contract-ocr`.

use std::sync::Arc;

use crate::core::CoreModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::ocr::{OCR_METHODS, OcrModule, PRICES_METHOD, Read, Refused, answer_js, request_of};
use crate::secrets::Credentials;
use crate::slot_client::SlotClient;
use crate::slot_server::{Listen, Refusal};

pub async fn serve(module: &CoreModule, credentials: &Credentials, listen: Listen) -> Result<(), String> {
    let process = module.process.as_ref().ok_or_else(|| format!("{} is not a module lf starts or reaches", module.name))?;
    let client = SlotClient::start("ocr", &module.name, process, &crate::core::settings_of(credentials, module))?;
    let ocr = Arc::new(OcrModule::new(Arc::new(client)));
    let listed = ocr.client.call_async("manifest", Obj::new()).await?;
    let publishes = listed.get("methods").and_then(Js::as_array).is_some_and(|methods| methods.iter().any(|m| m.as_str() == Some(PRICES_METHOD)));
    let mut methods = OCR_METHODS.to_vec();
    if publishes {
        methods.push(PRICES_METHOD);
    }
    let manifest = crate::slot_server::manifest(&module.name, "ocr", &methods);
    crate::slot_server::serve_async(listen, manifest, move |method: String, params: Js, _settings: Js| {
        let ocr = ocr.clone();
        async move { answer(&ocr, &method, &params).await }
    })
    .await
}

async fn answer(ocr: &OcrModule, method: &str, params: &Js) -> Result<Js, Refusal> {
    match method {
        "ocr.read" => {
            let (bytes, content_type, name, label) = request_of(params).map_err(Refusal::bad_request)?;
            let read = Read { bytes: &bytes, content_type: &content_type, name: name.as_deref(), label: &label };
            match ocr.read(&read).await {
                Ok(answer) => Ok(answer_js(answer)),
                Err(Refused::Module(error)) => Err(Refusal::new(&error.code, error.message)),
                Err(refused @ Refused::Unpriced(_)) => Err(Refusal::failed(refused.message())),
            }
        }
        PRICES_METHOD => match ocr.per_page().await.map_err(Refusal::failed)? {
            Some(per_page) => Ok(Js::Obj(obj! { "perPage" => Js::Num(serde_json::Number::from_f64(per_page).ok_or_else(|| Refusal::failed("the price is not a number"))?) })),
            None => Err(Refusal::unknown(method)),
        },
        other => Err(Refusal::unknown(other)),
    }
}
