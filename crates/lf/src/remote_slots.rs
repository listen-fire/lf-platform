//! The models, judge and files slots filled by a module lf does not build
//! in: a network client for each (crate::slot_client), over the slot's
//! methods (docs/contracts/models-slot.md, judge-slot.md, files-slot.md).
//! lf's built-ins stay in process; a project naming another module for one of
//! these slots has it reached here, once per process, before any run.
//!
//! The browser slot is lf's to fill only for the modules it starts: lf
//! itself opens no page, so a browser module's address is handed to them
//! (`LF_BROWSER_URL`, `LF_BROWSER_TOKEN`) for their `ctx.browser`. They call
//! it directly, so lf cannot start it on their first call: a browser module
//! lf starts is started with the session and held from an idle stop.

use std::sync::{Arc, RwLock};

use crate::json::{Js, Obj};
use crate::obj;
use crate::slot_client::SlotClient;

static MODELS: RwLock<Option<Arc<ModelsModule>>> = RwLock::new(None);
static JUDGE: RwLock<Option<Arc<SlotClient>>> = RwLock::new(None);
/// The browser module's address and secret, held for the session.
static BROWSER_HELD: std::sync::Mutex<Option<(crate::module_hosts::Lease, Option<String>)>> = std::sync::Mutex::new(None);

pub fn models() -> Option<Arc<ModelsModule>> {
    MODELS.read().unwrap_or_else(|p| p.into_inner()).clone()
}

pub fn judge() -> Option<Arc<SlotClient>> {
    JUDGE.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Reach the project's models, judge and browser modules that are not
/// built in (the files slot's lives with the run's documents).
pub async fn install(project: &crate::project::Project, credentials: &crate::secrets::Credentials) -> Result<(), String> {
    let core = &project.core;
    let reach = |kind: &str, module: &crate::core::CoreModule| -> Result<Option<Arc<SlotClient>>, String> {
        let Some(process) = &module.process else { return Ok(None) };
        let fields = crate::core::settings_of(credentials, module);
        SlotClient::start(kind, &module.name, process, &fields).map(|c| Some(Arc::new(c)))
    };
    *MODELS.write().unwrap_or_else(|p| p.into_inner()) = reach("models", &core.models)?.map(|client| Arc::new(ModelsModule::new(client)));
    *JUDGE.write().unwrap_or_else(|p| p.into_inner()) = reach("judge", &core.judge)?;
    let held = match &core.browser {
        Some(module) => match reach("browser", module)? {
            Some(client) => Some(client.hold().await?),
            None => None,
        },
        None => None,
    };
    *BROWSER_HELD.lock().unwrap_or_else(|p| p.into_inner()) = held;
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
    let held = BROWSER_HELD.lock().unwrap_or_else(|p| p.into_inner());
    let Some((lease, bearer)) = held.as_ref() else { return Vec::new() };
    let mut env = vec![("LF_BROWSER_URL".to_string(), lease.address.clone())];
    if let Some(token) = bearer {
        env.push(("LF_BROWSER_TOKEN".to_string(), token.clone()));
    }
    env
}

// ── The models slot ─────────────────────────────────────────────────────────

/// The models slot's module, and the prices it publishes (`models.prices`),
/// asked at its first call and kept for the process.
pub struct ModelsModule {
    pub client: Arc<SlotClient>,
    /// `Some(None)` once asked of a module that publishes none.
    prices: std::sync::Mutex<Option<Option<Arc<crate::models::PriceTable>>>>,
}

impl ModelsModule {
    pub fn new(client: Arc<SlotClient>) -> ModelsModule {
        ModelsModule { client, prices: std::sync::Mutex::new(None) }
    }

    /// The module's price table; `None` for a module that publishes none. A
    /// failed ask is not kept: the next call asks again.
    pub async fn prices(&self) -> Result<Option<Arc<crate::models::PriceTable>>, String> {
        if let Some(known) = self.prices.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            return Ok(known);
        }
        // Asked only of a module whose manifest lists it: the method is optional.
        let manifest = self.client.call_async("manifest", Obj::new()).await?;
        let lists = |method: &str| manifest.get("methods").and_then(Js::as_array).is_some_and(|methods| methods.iter().any(|m| m.as_str() == Some(method)));
        let published = match lists("models.prices") {
            true => Some(Arc::new(crate::models::price_table_of(&self.client.call_async("models.prices", Obj::new()).await?))),
            false => None,
        };
        *self.prices.lock().unwrap_or_else(|p| p.into_inner()) = Some(published.clone());
        Ok(published)
    }
}

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

/// What a models module answered: the text, what it cost, line by line, and
/// the tokens it spent.
pub struct ModelAnswer {
    pub text: String,
    pub cost: Vec<(String, i64)>,
    pub usage: crate::models::TokenCounts,
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
    let shape = || format!("{}: models.call answered {}, not {{ text, cost, usage: {{ inputTokens, outputTokens }} }}", client.label, answer.to_json());
    let text = answer.get("text").and_then(Js::as_str).ok_or_else(shape)?;
    // Required, so a run's usage counts a third-party model as the built-in one.
    let usage = answer.get("usage").and_then(usage_of).ok_or_else(shape)?;
    Ok(ModelAnswer { text: text.to_string(), cost: cost_lines(answer.get("cost")), usage })
}

/// `{ inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens? }`.
fn usage_of(usage: &Js) -> Option<crate::models::TokenCounts> {
    let count = |key: &str| match usage.get(key) {
        Some(Js::Num(n)) => n.as_u64(),
        _ => None,
    };
    Some(crate::models::TokenCounts {
        input: count("inputTokens")?,
        output: count("outputTokens")?,
        cache_read: count("cacheReadTokens").unwrap_or(0),
        cache_creation: count("cacheCreationTokens").unwrap_or(0),
    })
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
