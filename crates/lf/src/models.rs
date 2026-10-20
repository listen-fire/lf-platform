//! Which models a run may name, what a model call costs, and the provider
//! key: the hosted engine's registry (engine-contracts `model_names.ts`)
//! and @lf/anthropic's price table (`modules/anthropic/pricing.ts`). The price
//! table is the very file the TypeScript client bills from, and
//! a test keeps the model names equal to the registry's.

use std::collections::{BTreeMap, HashSet};
use std::cell::RefCell;
use std::sync::OnceLock;

use serde_json::Value as Json;

use crate::json::Js;
use crate::secrets::Credentials;

/// The chat models, in the registry's order (every one is served by
/// Anthropic: `home: 'anthropic'`).
pub const CHAT_MODELS: &[&str] = &[
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
];

/// The models a run's programs may name (`runChatModels`): the catalog's own
/// list where it has one, else every chat model; names that are no chat
/// model are dropped.
pub fn run_chat_models(catalog: &Js) -> Vec<String> {
    match catalog.get("models") {
        Some(Js::Arr(names)) => names.iter().filter_map(Js::as_str).filter(|n| CHAT_MODELS.contains(n)).map(str::to_string).collect(),
        _ => CHAT_MODELS.iter().map(|n| n.to_string()).collect(),
    }
}

/// What a call's `model` names on the provider's wire (`claudeModelId`): the
/// built-in tier aliases, or a chat model by its own name. `None` for a name
/// no call can make.
pub fn wire_model(model: &str) -> Option<&'static str> {
    match model {
        "opus" => Some("claude-opus-4-7"),
        "opus5" => Some("claude-opus-5"),
        "haiku" => Some("claude-haiku-4-5-20251001"),
        "sonnet" => Some("claude-sonnet-5"),
        other => CHAT_MODELS.iter().find(|name| **name == other).copied(),
    }
}

// ── Prices ──────────────────────────────────────────────────────────────────

/// Dollars per million tokens. A missing cache rate bills at the input rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_creation: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

/// The one price table, @lf/anthropic's (modules/anthropic/prices.json): the
/// TypeScript client bills from the same file. This is a copy inside the crate
/// so `cargo publish` packages it; a test holds it equal to the module's.
static PRICES_TEXT: &str = include_str!("../data/prices.json");

fn prices() -> &'static BTreeMap<String, Price> {
    static PRICES: OnceLock<BTreeMap<String, Price>> = OnceLock::new();
    PRICES.get_or_init(|| {
        let parsed: Json = serde_json::from_str(PRICES_TEXT).expect("prices.json is JSON");
        let table = parsed.get("prices").and_then(Json::as_object).expect("prices.json has a `prices` object");
        table
            .iter()
            .map(|(key, row)| {
                let rate = |field: &str| row.get(field).and_then(Json::as_f64);
                let price = Price {
                    input: rate("input").expect("every price has an input rate"),
                    output: rate("output").expect("every price has an output rate"),
                    cache_read: rate("cacheRead"),
                    cache_creation: rate("cacheCreation"),
                };
                (key.clone(), price)
            })
            .collect()
    })
}

/// What a call cost in microdollars (`costMicrodollars`): `None` when the
/// `provider/wire-model` key has no price. The sum is taken in the order the
/// TypeScript takes it, so the rounding agrees to the microdollar.
pub fn cost_microdollars(key: &str, tokens: TokenCounts) -> Option<i64> {
    let price = prices().get(key)?;
    let input = tokens.input as f64 * price.input;
    let output = tokens.output as f64 * price.output;
    let cache_read = tokens.cache_read as f64 * price.cache_read.unwrap_or(price.input);
    let cache_creation = tokens.cache_creation as f64 * price.cache_creation.unwrap_or(price.input);
    Some((input + output + cache_read + cache_creation).round() as i64)
}

impl Price {
    /// Free for every kind of token: an answer at this price may cost nothing.
    pub fn is_free(&self) -> bool {
        self.input == 0.0 && self.output == 0.0 && self.cache_read.unwrap_or(0.0) == 0.0 && self.cache_creation.unwrap_or(0.0) == 0.0
    }

    /// `{ input, output, cacheRead?, cacheCreation? }` (engine-contracts `ModelPrice`).
    pub fn to_js(self) -> Js {
        let rate = |n: f64| Js::Num(serde_json::Number::from_f64(n).unwrap_or_else(|| 0.into()));
        let mut out = crate::json::Obj::new();
        out.insert("input".into(), rate(self.input));
        out.insert("output".into(), rate(self.output));
        if let Some(n) = self.cache_read {
            out.insert("cacheRead".into(), rate(n));
        }
        if let Some(n) = self.cache_creation {
            out.insert("cacheCreation".into(), rate(n));
        }
        Js::Obj(out)
    }

    /// A row of a published table, as `to_js` writes it; `None` for one that
    /// is not a price (a missing or negative rate).
    pub fn of_js(row: &Js) -> Option<Price> {
        let rate = |field: &str| match row.get(field) {
            Some(Js::Num(n)) => n.as_f64().filter(|n| n.is_finite() && *n >= 0.0),
            _ => None,
        };
        let optional = |field: &str| match row.get(field) {
            None | Some(Js::Null) => Some(None),
            Some(_) => rate(field).map(Some),
        };
        Some(Price { input: rate("input")?, output: rate("output")?, cache_read: optional("cacheRead")?, cache_creation: optional("cacheCreation")? })
    }
}

/// What a models module publishes (`models.prices`): the price of each model
/// name a call writes.
pub type PriceTable = BTreeMap<String, Price>;

/// A `models.prices` answer read: `{ prices: { <name>: <price> } }`, rows that
/// are no price left out.
pub fn price_table_of(answer: &Js) -> PriceTable {
    match answer.get("prices") {
        Some(Js::Obj(rows)) => rows.iter().filter_map(|(name, row)| Some((name.clone(), Price::of_js(row)?))).collect(),
        _ => PriceTable::new(),
    }
}

/// @lf/anthropic's published prices: every name a call writes (the tier
/// names and the chat models) at the price of the Anthropic model it calls.
pub fn builtin_prices() -> &'static PriceTable {
    static TABLE: OnceLock<PriceTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        ["opus", "opus5", "sonnet", "haiku"]
            .iter()
            .chain(CHAT_MODELS)
            .filter_map(|name| Some((name.to_string(), *prices().get(&format!("anthropic/{}", wire_model(name)?))?)))
            .collect()
    })
}

/// A table as `models.prices` answers it.
pub fn price_table_js(table: &PriceTable) -> Js {
    let rows = table.iter().map(|(name, price)| (name.clone(), price.to_js())).collect();
    Js::Obj(crate::obj! { "prices" => Js::Obj(rows) })
}

thread_local! {
    static UNPRICED_WARNED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// Say once per key that its usage counts as free (`unpricedKeysWarned`).
pub fn warn_unpriced_once(key: &str) {
    let first = UNPRICED_WARNED.with(|warned| warned.borrow_mut().insert(key.to_string()));
    if first {
        eprintln!("lf: no price for \"{key}\": its usage counts as free. Add it to modules/anthropic/prices.json.");
    }
}

// ── The provider key ────────────────────────────────────────────────────────

/// The Anthropic key and endpoint: the settings of the models slot's
/// module, @lf/anthropic (`lf connect @lf/anthropic`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderKey {
    pub api_key: String,
    /// Another endpoint speaking the same Messages API.
    pub base_url: Option<String>,
}

pub fn provider_key(credentials: &Credentials) -> Result<ProviderKey, String> {
    let module = crate::core::builtin(crate::core::ANTHROPIC).expect("@lf/anthropic is built in");
    let settings = crate::core::settings_of(credentials, module);
    match settings.get("api_key") {
        Some(api_key) => Ok(ProviderKey { api_key: api_key.clone(), base_url: settings.get("base_url").cloned() }),
        None => Err(format!(
            "a model call needs a provider key: run `lf connect {}`",
            module.name
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_packaged_price_table_is_the_modules() {
        let module = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../modules/anthropic/prices.json")).unwrap();
        assert_eq!(PRICES_TEXT, module, "crates/lf/data/prices.json is a copy of modules/anthropic/prices.json: cp it over");
    }

    /// The names the TypeScript registry holds as chat models, in its order.
    fn registry_chat_models() -> Vec<String> {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/engine-contracts/model_names.ts")).unwrap();
        text.lines()
            .filter_map(|line| {
                let line = line.trim();
                let name = line.strip_prefix('\'')?.split('\'').next()?;
                (line.contains("capability: 'chat'") && line.contains("home: 'anthropic'")).then(|| name.to_string())
            })
            .collect()
    }

    #[test]
    fn the_chat_models_are_the_registrys() {
        assert_eq!(registry_chat_models(), CHAT_MODELS);
    }

    #[test]
    fn every_chat_model_is_priced_under_anthropic() {
        for name in CHAT_MODELS {
            assert!(prices().contains_key(&format!("anthropic/{name}")), "{name}");
        }
    }

    #[test]
    fn a_price_is_the_tables_rounded_to_the_microdollar() {
        // claude-sonnet-5 is $2 in / $10 out per million: 1000 * 2 + 500 * 10.
        let counts = TokenCounts { input: 1000, output: 500, ..TokenCounts::default() };
        assert_eq!(cost_microdollars("anthropic/claude-sonnet-5", counts), Some(7000));
        assert_eq!(cost_microdollars("anthropic/not-a-model", counts), None);
    }

    /// @lf/anthropic's cost cases (modules/anthropic/fixtures/cost_cases.json),
    /// which its TypeScript pricing test reads too: both bill a call to the
    /// same microdollar.
    #[test]
    fn prices_agree_with_the_typescript_to_the_microdollar() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../modules/anthropic/fixtures/cost_cases.json")).unwrap();
        let fixture: Json = serde_json::from_str(&text).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let key = case["key"].as_str().unwrap();
            let tokens: Vec<u64> = case["tokens"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap()).collect();
            let counts = TokenCounts { input: tokens[0], output: tokens[1], cache_read: tokens[2], cache_creation: tokens[3] };
            assert_eq!(cost_microdollars(key, counts), case["microdollars"].as_i64(), "{key}");
        }
    }

    #[test]
    fn the_builtin_publishes_every_name_a_call_writes_at_its_anthropic_price() {
        let table = builtin_prices();
        assert_eq!(table.get("sonnet"), prices().get("anthropic/claude-sonnet-5"));
        assert_eq!(table.get("claude-haiku-4-5"), prices().get("anthropic/claude-haiku-4-5"));
        assert_eq!(table.len(), 4 + CHAT_MODELS.len());
    }

    #[test]
    fn a_published_table_reads_back_as_it_was_written_and_drops_what_is_no_price() {
        let table = builtin_prices();
        assert_eq!(&price_table_of(&price_table_js(table)), table);
        let odd = Js::parse(br#"{"prices":{"free":{"input":0,"output":0},"bad":{"input":-1,"output":2},"half":{"input":1}}}"#).unwrap();
        let read = price_table_of(&odd);
        assert_eq!(read.keys().collect::<Vec<_>>(), vec!["free"]);
        assert!(read["free"].is_free());
    }

    #[test]
    fn aliases_name_the_models_the_typescript_names() {
        assert_eq!(wire_model("sonnet"), Some("claude-sonnet-5"));
        assert_eq!(wire_model("opus"), Some("claude-opus-4-7"));
        assert_eq!(wire_model("claude-haiku-4-5"), Some("claude-haiku-4-5"));
        assert_eq!(wire_model("gpt-4"), None);
    }

    #[test]
    fn a_catalogs_own_model_list_wins_and_loses_what_is_no_chat_model() {
        let catalog = Js::parse(br#"{"models":["claude-sonnet-5","whisper-1","nope"]}"#).unwrap();
        assert_eq!(run_chat_models(&catalog), vec!["claude-sonnet-5"]);
        assert_eq!(run_chat_models(&Js::parse(b"{}").unwrap()).len(), CHAT_MODELS.len());
    }
}
