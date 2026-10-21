//! The standard library's signatures (checker/standard_library.ts and the
//! function families of expression/stdlib.ts): each built-in's parameters,
//! what it returns and its one-line summary. Generated from
//! `standardLibrary()` on 2026-10-15; a function added there is added here.
//! The summaries are the language's own: the handbook's language search
//! reads this table (`standard_library_json`, through the engine's wasm),
//! not the TypeScript registry.

use super::field::{Ty, maybe_absent};

/// `BuiltinParamType`: what a parameter takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamType {
    Scalar,
    Text,
    Number,
    Temporal,
    File,
    TextOrList,
    List,
    Any,
    Record,
    Options,
    Function,
    Type,
    Shape,
}

impl ParamType {
    /// `BuiltinParamType`'s spelling (`textOrList`).
    pub fn spelling(self) -> &'static str {
        match self {
            ParamType::Scalar => "scalar",
            ParamType::Text => "text",
            ParamType::Number => "number",
            ParamType::Temporal => "temporal",
            ParamType::File => "file",
            ParamType::TextOrList => "textOrList",
            ParamType::List => "list",
            ParamType::Any => "any",
            ParamType::Record => "record",
            ParamType::Options => "options",
            ParamType::Function => "function",
            ParamType::Type => "type",
            ParamType::Shape => "shape",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arity {
    One,
    Optional,
    Rest,
}

#[derive(Debug, Clone, Copy)]
pub struct Param {
    /// As the signature names it (`describeBuiltin`).
    pub name: &'static str,
    pub ty: ParamType,
    pub arity: Arity,
}

/// What a built-in returns: a fixed type, or one derived from its arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Returns {
    Text,
    Number,
    Boolean,
    Date,
    Datetime,
    File,
    ListOfText,
    MaybeAbsentText,
    MaybeAbsentDate,
    /// Never returns: the run fails there (`fail("…")`).
    Never,
    Derived,
}

impl Returns {
    /// `describeFieldType` of the type, or `derived`.
    pub fn describe(self) -> &'static str {
        match self {
            Returns::Text => "text",
            Returns::Number => "number",
            Returns::Boolean => "boolean",
            Returns::Date => "date",
            Returns::Datetime => "datetime",
            Returns::File => "file",
            Returns::ListOfText => "list of text",
            Returns::MaybeAbsentText => "text (or absent)",
            Returns::MaybeAbsentDate => "date (or absent)",
            Returns::Never => "never",
            Returns::Derived => "derived",
        }
    }

    pub fn ty(self) -> Option<Ty> {
        Some(match self {
            Returns::Text => Ty::Text,
            Returns::Number => Ty::Number,
            Returns::Boolean => Ty::Boolean,
            Returns::Date => Ty::Date,
            Returns::Datetime => Ty::Datetime,
            Returns::File => Ty::File,
            Returns::ListOfText => Ty::list(Ty::Text),
            Returns::MaybeAbsentText => maybe_absent(Ty::Text),
            Returns::MaybeAbsentDate => maybe_absent(Ty::Date),
            Returns::Never => Ty::Never,
            Returns::Derived => return None,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Builtin {
    /// As the author writes it (`DATE.PARSE`).
    pub name: &'static str,
    pub params: &'static [Param],
    pub returns: Returns,
    /// One line for listings: what calling it gives back. `RETIRED — …` for a
    /// built-in kept only so old automations still read.
    pub summary: &'static str,
    /// A function of a namespaced family (`stdlibFunctionById` finds it).
    pub family: bool,
}

impl Builtin {
    /// `builtinParamAt`: the parameter an argument at `index` binds to.
    pub fn param_at(&self, index: usize) -> Option<&Param> {
        self.params.get(index).or_else(|| self.params.last().filter(|p| p.arity == Arity::Rest))
    }

    /// `describeBuiltin`: the signature as the author reads it (`ROUND(number, places?)`).
    pub fn describe(&self) -> String {
        let params: Vec<String> = self
            .params
            .iter()
            .map(|param| match param.arity {
                Arity::One => param.name.to_string(),
                Arity::Optional => format!("{}?", param.name),
                Arity::Rest => format!("…{}", param.name),
            })
            .collect();
        format!("{}({})", self.name, params.join(", "))
    }
}

const fn p(name: &'static str, ty: ParamType) -> Param {
    Param { name, ty, arity: Arity::One }
}
const fn opt(name: &'static str, ty: ParamType) -> Param {
    Param { name, ty, arity: Arity::Optional }
}
const fn rest(name: &'static str, ty: ParamType) -> Param {
    Param { name, ty, arity: Arity::Rest }
}

use ParamType as T;
use Returns as R;

macro_rules! b {
    ($name:literal, [$($param:expr),*], $returns:expr, $summary:literal) => {
        Builtin { name: $name, params: &[$($param),*], returns: $returns, summary: $summary, family: false }
    };
    ($name:literal, [$($param:expr),*], $returns:expr, $summary:literal, family) => {
        Builtin { name: $name, params: &[$($param),*], returns: $returns, summary: $summary, family: true }
    };
}

pub static STANDARD_LIBRARY: &[Builtin] = &[
    b!("ISNULL", [p("value", T::Any)], R::Boolean, "whether a value is absent"),
    b!("COALESCE", [rest("values", T::Any)], R::Derived, "the first argument that is present"),
    b!("TRIM", [p("text", T::Text)], R::Text, "text without its leading and trailing whitespace"),
    b!("LOWER", [p("text", T::Text)], R::Text, "text in lower case"),
    b!("UPPER", [p("text", T::Text)], R::Text, "text in upper case"),
    b!("LENGTH", [p("value", T::TextOrList)], R::Number, "a text's characters, or a list's members, counted"),
    b!("ABS", [p("number", T::Number)], R::Number, "a number without its sign"),
    b!("ROUND", [p("number", T::Number), opt("places", T::Number)], R::Number, "a number rounded to a whole one"),
    b!("FLOOR", [p("number", T::Number)], R::Number, "a number rounded down"),
    b!("CEIL", [p("number", T::Number)], R::Number, "a number rounded up"),
    b!("TOSTRING", [p("value", T::Scalar)], R::Text, "a value written as text"),
    b!("TONUMBER", [p("value", T::Scalar)], R::Number, "a value read as a number"),
    b!("MULTI", [rest("values", T::Any)], R::Derived, "the present arguments as one list, lists flattened one level"),
    b!("SPLIT", [p("text", T::Text), opt("separator", T::Text)], R::ListOfText, "text cut into its trimmed, non-empty parts"),
    b!("DATE", [p("value", T::Scalar)], R::Date, "any readable date or timestamp, as a date"),
    b!("DATETIME", [p("value", T::Scalar)], R::Datetime, "any readable date or timestamp, as an instant"),
    b!("NUMBER", [p("value", T::Scalar)], R::Number, "a value read as a number"),
    b!("FIRST", [p("collection", T::Any)], R::Derived, "the first member, absent when there is none"),
    b!("LAST", [p("collection", T::Any)], R::Derived, "the last member, absent when there is none"),
    b!("ONLY", [p("collection", T::Any)], R::Derived, "the one member, absent when there is none; more than one fails the run"),
    b!("COUNT", [p("collection", T::Any)], R::Number, "how many members"),
    b!("SUM", [p("collection", T::Any)], R::Number, "the members added up"),
    b!("AVG", [p("collection", T::Any)], R::Number, "the members averaged"),
    b!("MIN", [p("collection", T::Any)], R::Derived, "the smallest member"),
    b!("MAX", [p("collection", T::Any)], R::Derived, "the largest member"),
    b!("JOIN", [p("collection", T::Any), opt("separator", T::Text)], R::Text, "the members joined into text"),
    b!("COLLECT", [p("collection", T::Any)], R::Derived, "the members as a list"),
    b!("LLM_AGG", [p("collection", T::Any), opt("instruction", T::Text)], R::Derived, "the members summarised by a model"),
    b!("AI", [p("prompt", T::Text), opt("tier", T::Text)], R::Derived, "a model's answer to a prompt"),
    b!("CONCAT", [rest("parts", T::Scalar)], R::Text, "the arguments joined into one text"),
    b!("KG_EXISTS", [p("query", T::Text), rest("params", T::Any)], R::Boolean, "RETIRED — whether a knowledge-graph query finds anything"),
    b!("KG_VALUE", [p("query", T::Text), rest("params", T::Any)], R::Derived, "RETIRED — a value a knowledge-graph query reads"),
    b!("EXTRACT_VALUE", [rest("values", T::Any)], R::Derived, "RETIRED — a scalar extracted by a model"),
    b!("AT", [p("collection", T::Any), p("index", T::Any)], R::Derived, "a list's member by position, or a dict's by key"),
    b!("SORT", [p("collection", T::Any), opt("key", T::Any), opt("direction", T::Any)], R::Derived, "the members in order"),
    b!("FILE", [p("content", T::Any), p("type", T::Text)], R::File, "content rendered as a file — FILE(content, \"pdf\" | \"text\")"),
    b!("READ", [p("file", T::File)], R::Text, "a file's text"),
    b!("CHUNKS", [p("text", T::Text), p("options", T::Options)], R::Derived, "text cut into pieces — CHUNKS(text, { size | entities, overlap })"),
    b!("EXISTS", [p("walk", T::Any)], R::Boolean, "whether a walk lands anywhere"),
    b!("MAP", [p("collection", T::List), opt("settings", T::Options), p("function", T::Function)], R::Derived, "each member through a function"),
    b!("FILTER", [p("collection", T::List), opt("settings", T::Options), p("function", T::Function)], R::Derived, "the members a function keeps"),
    b!("REDUCE", [p("collection", T::List), p("start", T::Any), p("function", T::Function)], R::Derived, "the members folded into one value"),
    b!("GROUPBY", [p("collection", T::List), p("key", T::Function)], R::Derived, "the members grouped by a key"),
    b!("KEYBY", [p("collection", T::List), p("key", T::Function)], R::Derived, "the members by a unique key"),
    b!("MEMBERS", [p("type", T::Type)], R::Derived, "a closed type's values, in declaration order"),
    b!("EXTRACT", [p("content", T::Any), p("shape", T::Shape), opt("settings", T::Options)], R::Derived, "the records a model finds in content, of a declared shape"),
    b!("EXTRACTONE", [p("content", T::Any), p("shape", T::Shape), opt("settings", T::Options)], R::Derived, "the single record content describes, of a declared shape, or absent"),
    b!("CURRENCY.GET_NUMBER_FROM_FIGURE", [p("figure", T::Text)], R::Number, "the numeric amount in a money figure — CURRENCY.GET_NUMBER_FROM_FIGURE(\"£1.2m\") is 1200000", family),
    b!("CURRENCY.GET_CODE_FROM_FIGURE", [p("figure", T::Text)], R::Text, "the ISO currency code in a money figure — CURRENCY.GET_CODE_FROM_FIGURE(\"£1.2m\") is \"GBP\"", family),
    b!("CURRENCY.FORMAT_FIGURE", [p("number", T::Number), p("code", T::Text)], R::MaybeAbsentText, "a number as a money figure — the inverse of GET_NUMBER_FROM_FIGURE — CURRENCY.FORMAT_FIGURE(1200000, \"EUR\") is \"€1.2M\"; a code with no symbol prints after the amount (\"1.2M CHF\"); an empty or unknown code prints the bare number", family),
    b!("DATE.PARSE", [p("text", T::Text)], R::MaybeAbsentDate, "a written date as an ISO date — DATE.PARSE(\"12 March 2026\") is \"2026-03-12\"; unreadable text is absent", family),
    b!("DATE.ADD_DAYS", [p("date", T::Temporal), p("days", T::Number)], R::Date, "a date shifted by whole days — DATE.ADD_DAYS(\"2026-03-12\", 7) is \"2026-03-19\"", family),
    b!("DATE.FORMAT", [p("value", T::Temporal), p("pattern", T::Text)], R::Text, "a date written out — DATE.FORMAT(\"2026-08-31\", \"MMMM D, YYYY\") is \"August 31, 2026\". Tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s; anything else is printed as written", family),
    b!("DATE.FORMAT_ISO", [p("value", T::Temporal)], R::Date, "any readable date or timestamp normalised to a full ISO 8601 UTC timestamp", family),
    b!("DATE.TODAY", [p("zone", T::Text)], R::Date, "the calendar date it is right now in a place — DATE.TODAY(\"Europe/Berlin\") is \"2026-03-12\" from 00:00 to 23:59 there. The zone is written down (an IANA name like \"Europe/Berlin\", \"America/New_York\", \"UTC\")", family),
    b!("DATETIME.AT", [p("date", T::Temporal), p("time", T::Text), p("zone", T::Text)], R::Datetime, "the instant a wall-clock time on a date names in a place — DATETIME.AT(\"2026-06-15\", \"07:00\", \"Europe/Berlin\") is 05:00 UTC. Move days with DATE.ADD_DAYS on the date and anchor each end separately, and a daylight-saving change takes care of itself", family),
    b!("TEXT.REGEX_EXTRACT", [p("text", T::Text), p("pattern", T::Text), opt("group", T::Number)], R::Text, "the first regex match (the first capture group when the pattern has one) — null when nothing matches", family),
    b!("TEXT.SLUG", [p("text", T::Text)], R::Text, "a lowercase-hyphen slug — TEXT.SLUG(\"Acme Corp Ltd.\") is \"acme-corp-ltd\"", family),
    b!("TEXT.PAIRS", [p("record", T::Record), opt("separator", T::Text)], R::Text, "a record or dict rendered as key=value pairs, keys in written order, joined by `separator` (default \" | \") — TEXT.PAIRS({ name: \"Acme\", url: \"acme.com\" }) is \"name=Acme | url=acme.com\"; a nested node/edge field is skipped, not stringified", family),
    b!("TEXT.SERIALISE", [p("value", T::Any), p("format", T::Text)], R::Text, "any value written out as text for a prompt, the same bytes every time it is the same value — TEXT.SERIALISE(deal, \"JSON\") is the record's fields as indented JSON with keys sorted, its nested nodes under their edge names as lists; an absent value is null, a file is its name/type/size and never its contents. The format is written down; \"JSON\" is the only one so far", family),
    b!("URL.HOST", [p("text", T::Text)], R::MaybeAbsentText, "the host of a URL or a scheme-less address, lowercased and otherwise verbatim (`www.` kept, no port, no path) — URL.HOST(\"https://WWW.Acme.com:8080/x\") is \"www.acme.com\", URL.HOST(\"acme.com:8080\") is \"acme.com\"; an email (`joe@acme.com`) is not a host, and text that names no address at all is absent", family),
    b!("NUMBER.FORMAT", [p("number", T::Number), p("style", T::Text)], R::MaybeAbsentText, "a number written out — \"compact\" abbreviates with K/M/B/T (NUMBER.FORMAT(1200000, \"compact\") is \"1.2M\"); \"grouped\" adds thousands separators (NUMBER.FORMAT(1200000, \"grouped\") is \"1,200,000\")", family),
];

/// `fail("…")` inside an expression: its canonical call is `ERROR(…)`, the
/// statement's word — no member of the library (`builtin_under`).
pub static FAIL: Builtin = b!("ERROR", [p("message", T::Scalar)], R::Never, "fails the run with the message; never returns");

/// `sort(xs, f, settings)` by a function key: the tree calls it
/// `SORTBY(xs, settings, f)` (movement_parser::surface::table::SORT_BY), a
/// collection op like `GROUPBY`.
pub static SORT_BY: Builtin = b!("SORTBY", [p("collection", T::List), opt("settings", T::Options), p("key", T::Function)], R::Derived, "the members in the order of what a function answers for each");

/// The built-in `name` calls: the library's, the `fail` of an expression and
/// `sort` by a function key.
pub fn builtin_under(name: &str) -> Option<&'static Builtin> {
    if name == FAIL.name {
        return Some(&FAIL);
    }
    if name == SORT_BY.name {
        return Some(&SORT_BY);
    }
    lookup_builtin(name)
}

/// The library as JSON, in table order: `[{name, params: [{name, type,
/// optional?, rest?}], returns, summary}]`, `returns` a type as
/// `describeFieldType` writes it or `derived`. What the engine's wasm
/// `standard_library` export answers.
pub fn standard_library_json() -> serde_json::Value {
    let entry = |b: &Builtin| {
        let params: Vec<serde_json::Value> = b
            .params
            .iter()
            .map(|param| {
                let mut out = serde_json::json!({ "name": param.name, "type": param.ty.spelling() });
                match param.arity {
                    Arity::One => {}
                    Arity::Optional => out["optional"] = true.into(),
                    Arity::Rest => out["rest"] = true.into(),
                }
                out
            })
            .collect();
        serde_json::json!({ "name": b.name, "params": params, "returns": b.returns.describe(), "summary": b.summary })
    };
    STANDARD_LIBRARY.iter().map(entry).collect()
}

/// `lookupBuiltin`: by name, in any letter case.
pub fn lookup_builtin(name: &str) -> Option<&'static Builtin> {
    STANDARD_LIBRARY.iter().find(|b| b.name.eq_ignore_ascii_case(name))
}

/// `stdlibFunctionById`: a namespaced family's function, by its lowercased id.
pub fn stdlib_function_by_id(id: &str) -> Option<&'static Builtin> {
    lookup_builtin(id).filter(|b| b.family)
}

/// `readsAsValue`: whether a parameter reads its argument as a value.
pub fn reads_as_value(param: ParamType) -> bool {
    matches!(param, T::Scalar | T::Text | T::Number | T::Temporal | T::File | T::TextOrList | T::List)
}

/// `paramAccepts`: whether a value of `ty` is one `param` takes.
pub fn param_accepts(param: ParamType, ty: &Ty) -> bool {
    match ty {
        Ty::MaybeAbsent(of) => param_accepts(param, of),
        Ty::Absent | Ty::Never => true,
        Ty::Union(members) => members.iter().all(|m| param_accepts(param, m)),
        Ty::Text | Ty::Enum { .. } => matches!(param, T::Scalar | T::Text | T::Temporal | T::TextOrList),
        Ty::Number => matches!(param, T::Scalar | T::Number),
        Ty::Boolean => param == T::Scalar,
        Ty::Date | Ty::Datetime => matches!(param, T::Scalar | T::Temporal),
        Ty::File => param == T::File,
        Ty::List { .. } | Ty::Tuple { .. } => matches!(param, T::List | T::TextOrList),
        Ty::Json | Ty::Record(_) | Ty::Dict { .. } => false,
    }
}

/// `describeParamType`.
pub fn describe_param_type(param: ParamType) -> &'static str {
    match param {
        T::Scalar => "one plain value (text, a number, a boolean or a date)",
        T::Text => "text",
        T::Number => "a number",
        T::Temporal => "a date, a datetime, or text that reads as one",
        T::File => "a file",
        T::TextOrList => "text or a list",
        T::List => "a list",
        T::Any => "any value",
        T::Record => "a record or a dict",
        T::Options => "a map of settings",
        T::Function => "a function",
        T::Type => "a type",
        T::Shape => "a node declaration",
    }
}

/// `BARE_COERCER_RETURNS`: the bare coercers and the type they retype to.
pub fn bare_coercer_returns(function: &str) -> Option<Ty> {
    match function {
        "date" => Some(Ty::Date),
        "datetime" => Some(Ty::Datetime),
        "number" => Some(Ty::Number),
        _ => None,
    }
}

/// `movementMetaKeyType` (checker/meta.ts): what an `@key` read is.
pub fn movement_meta_key_type(key: &str) -> Option<Ty> {
    match key {
        "current_date" => Some(Ty::Date),
        "current_timestamp" => Some(Ty::Datetime),
        "user_email" | "user_name" | "user_id" | "actor_email" | "actor_name" | "actor_id" => Some(Ty::Text),
        _ => None,
    }
}
