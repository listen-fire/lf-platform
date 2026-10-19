//! The models, judge and files slots filled by a module lf does not build
//! in: a network client for each (crate::slot_client), over the slot's
//! methods (docs/contracts/models-slot.md, judge-slot.md, files-slot.md).
//! lf's built-ins stay in process; a project naming another module for one of
//! these slots has it reached here, once per process, before any run.
//!
//! The browser slot is lf's to fill only for the modules it starts: lf
//! itself opens no page, so a browser module's address is handed to them
//! (`LF_BROWSER_URL`, `LF_BROWSER_TOKEN`) for their `ctx.browser`.

use std::sync::{Arc, RwLock};

use crate::json::{Js, Obj};
use crate::obj;
use crate::slot_client::SlotClient;

static MODELS: RwLock<Option<Arc<SlotClient>>> = RwLock::new(None);
static JUDGE: RwLock<Option<Arc<SlotClient>>> = RwLock::new(None);
static BROWSER: RwLock<Option<Arc<SlotClient>>> = RwLock::new(None);

pub fn models() -> Option<Arc<SlotClient>> {
    MODELS.read().unwrap_or_else(|p| p.into_inner()).clone()
}

pub fn judge() -> Option<Arc<SlotClient>> {
    JUDGE.read().unwrap_or_else(|p| p.into_inner()).clone()
}

pub fn browser() -> Option<Arc<SlotClient>> {
    BROWSER.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Reach the project's models, judge and browser modules that are not
/// built in (the files slot's lives with the run's documents).
pub fn install(project: &crate::project::Project, credentials: &crate::secrets::Credentials) -> Result<(), String> {
    let core = &project.core;
    let reach = |kind: &str, module: &crate::core::CoreModule| -> Result<Option<Arc<SlotClient>>, String> {
        let Some(process) = &module.process else { return Ok(None) };
        let fields = crate::core::settings_of(credentials, module);
        SlotClient::start(kind, &module.name, process, &fields).map(|c| Some(Arc::new(c)))
    };
    *MODELS.write().unwrap_or_else(|p| p.into_inner()) = reach("models", &core.models)?;
    *JUDGE.write().unwrap_or_else(|p| p.into_inner()) = reach("judge", &core.judge)?;
    *BROWSER.write().unwrap_or_else(|p| p.into_inner()) = match &core.browser {
        Some(module) => reach("browser", module)?,
        None => None,
    };
    Ok(())
}

/// The files slot's module, when it is not lf's own folder.
pub fn files(project: &crate::project::Project, credentials: &crate::secrets::Credentials) -> Result<Option<SlotClient>, String> {
    let module = &project.core.files;
    let Some(process) = &module.process else { return Ok(None) };
    SlotClient::start("files", &module.name, process, &crate::core::settings_of(credentials, module)).map(Some)
}

/// The environment a module lf starts reads the browser slot from.
pub fn browser_env() -> Vec<(String, String)> {
    let Some(browser) = browser() else { return Vec::new() };
    let mut env = vec![("LF_BROWSER_URL".to_string(), browser.base_url.clone())];
    if let Some(token) = browser.bearer() {
        env.push(("LF_BROWSER_TOKEN".to_string(), token.to_string()));
    }
    env
}

// ── The models slot ─────────────────────────────────────────────────────────

/// One model call as `models.call` asks it (engine-contracts
/// `slots/models.ts` `ModelsCallRequest`).
pub struct ModelCall<'a> {
    pub label: &'a str,
    pub system: &'a str,
    pub user_message: String,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub max_tokens: Option<u64>,
}

/// What a models module answered: the text, and what it cost, line by line.
pub struct ModelAnswer {
    pub text: String,
    pub cost: Vec<(String, i64)>,
}

/// One `models.call`.
pub async fn call_model(client: &SlotClient, call: &ModelCall<'_>) -> Result<ModelAnswer, String> {
    let mut params = obj! {
        "label" => Js::str(call.label),
        "system" => Js::str(call.system),
        "userMessage" => Js::str(&call.user_message),
        "model" => Js::str(call.model),
    };
    if let Some(effort) = call.effort {
        params.insert("effort".into(), Js::str(effort));
    }
    if let Some(max_tokens) = call.max_tokens {
        params.insert("maxTokens".into(), Js::Num(max_tokens.into()));
    }
    let answer = client.call_async("models.call", params).await?;
    let text = answer.get("text").and_then(Js::as_str).ok_or_else(|| format!("{}: models.call answered {}, not {{ text, cost }}", client.label, answer.to_json()))?;
    Ok(ModelAnswer { text: text.to_string(), cost: cost_lines(answer.get("cost")) })
}

/// `[{ microdollars, label }]`, the lines that read.
pub fn cost_lines(cost: Option<&Js>) -> Vec<(String, i64)> {
    cost.and_then(Js::as_array)
        .into_iter()
        .flatten()
        .filter_map(|line| {
            let label = line.get("label")?.as_str()?.to_string();
            let micro = match line.get("microdollars")? {
                Js::Num(n) => n.as_f64()?,
                _ => return None,
            };
            (micro.is_finite() && micro >= 0.0).then_some((label, micro.round() as i64))
        })
        .collect()
}

// ── The judge slot ──────────────────────────────────────────────────────────

/// One `judge.arbitrate`: the engine's question as it asked it (its
/// `asserted`, `candidates`, `recordType`, `constraints`, `languageVersion`),
/// answered `{ index, judgeUnavailable?, cost }`.
pub async fn arbitrate(client: &SlotClient, question: &Js) -> Js {
    let mut params = Obj::new();
    for key in ["asserted", "candidates", "recordType", "constraints", "languageVersion"] {
        if let Some(value) = question.get(key) {
            params.insert(key.into(), value.clone());
        }
    }
    let declined = |why: String| Js::from(obj! { "index" => Js::Null, "judgeUnavailable" => Js::str(why), "cost" => Js::Arr(Vec::new()) });
    match client.call_async("judge.arbitrate", params).await {
        Ok(answer) => {
            let index = match answer.get("index") {
                Some(Js::Num(n)) => n.as_u64().map(|i| Js::Num(i.into())),
                Some(Js::Null) | None => Some(Js::Null),
                _ => None,
            };
            let Some(index) = index else { return declined(format!("{}: judge.arbitrate answered {}, not {{ index }}", client.label, answer.to_json())) };
            let mut out = obj! { "index" => index };
            if let Some(why) = answer.get("judgeUnavailable").and_then(Js::as_str) {
                out.insert("judgeUnavailable".into(), Js::str(why));
            }
            let cost = cost_lines(answer.get("cost"))
                .into_iter()
                .map(|(label, micro)| Js::from(obj! { "source" => Js::str(label), "microdollars" => Js::Num(micro.into()) }))
                .collect();
            out.insert("cost".into(), Js::Arr(cost));
            Js::from(out)
        }
        Err(message) => declined(message),
    }
}
