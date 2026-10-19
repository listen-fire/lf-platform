//! An adapter: a system a movement connects to, reads and writes
//! (docs/contracts/adapter-protocol.md, "Methods"). The nine required
//! methods are this trait's; a read-only source or a pure sink leaves the
//! defaulted ones alone. An optional method (`poll`, `preprocessInbound`,
//! `resolveAwait`, …) is declared in the manifest and answered by
//! [`Adapter::optional`].

use std::future::Future;

use module_wire::json::{Js, Obj};
use serde::{Deserialize, Serialize};

use crate::context::{Answer, Ctx, ModuleError, from_js, to_js};
use crate::module::{LocalFuture, Module, manifest_frame};

/// The methods every adapter answers (beside `manifest`).
pub const REQUIRED_METHODS: &[&str] =
    &["listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated", "createRecord", "updateRecord", "deleteRecord"];

/// What an adapter declares about itself.
#[derive(Debug, Clone)]
pub struct AdapterManifest {
    /// The slug a movement imports; it must be the install's name.
    pub adapter_type: String,
    /// `webhook` when the system announces events; `poll` when it is polled.
    pub supported_triggers: Vec<String>,
    /// The optional methods it implements, answered by [`Adapter::optional`].
    pub optional_methods: Vec<String>,
    /// Every other declaration, written into the manifest as given:
    /// `subscribableEvents`, `credentials`, `inbound`, `poll`, `settings`,
    /// `limits`, `listenConfig`, `runtimeCapabilities`, …
    pub declarations: Obj,
}

impl AdapterManifest {
    pub fn new(adapter_type: impl Into<String>) -> AdapterManifest {
        AdapterManifest { adapter_type: adapter_type.into(), supported_triggers: Vec::new(), optional_methods: Vec::new(), declarations: Obj::new() }
    }

    pub fn triggers<S: Into<String>>(mut self, triggers: impl IntoIterator<Item = S>) -> AdapterManifest {
        self.supported_triggers = triggers.into_iter().map(Into::into).collect();
        self
    }

    pub fn optional<S: Into<String>>(mut self, methods: impl IntoIterator<Item = S>) -> AdapterManifest {
        self.optional_methods = methods.into_iter().map(Into::into).collect();
        self
    }

    pub fn declare(mut self, key: impl Into<String>, value: Js) -> AdapterManifest {
        self.declarations.insert(key.into(), value);
        self
    }
}

/// How the host hands a record back: its type, the id the adapter minted
/// and the `data` it attached.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_type: Option<String>,
    pub record_type: Option<String>,
    pub identity: Identity,
    /// `originRef`, `evidence`, `resources`: an adapter may ignore them.
    #[serde(flatten)]
    pub rest: Obj,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Identity {
    Stable {
        record_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Js>,
    },
    Unstable {
        data: Js,
    },
}

impl Position {
    /// A record this adapter holds, by its id, with the data a movement reads off it.
    pub fn stable(adapter_type: &str, record_type: &str, record_id: impl Into<String>, data: Obj) -> Position {
        Position {
            adapter_type: Some(adapter_type.into()),
            record_type: Some(record_type.into()),
            identity: Identity::Stable { record_id: record_id.into(), data: Some(Js::Obj(data)) },
            rest: Obj::new(),
        }
    }

    pub fn record_id(&self) -> Option<&str> {
        match &self.identity {
            Identity::Stable { record_id, .. } => Some(record_id),
            Identity::Unstable { .. } => None,
        }
    }

    pub fn data(&self) -> Option<&Js> {
        match &self.identity {
            Identity::Stable { data, .. } => data.as_ref(),
            Identity::Unstable { data } => Some(data),
        }
    }

    /// A field of the attached data.
    pub fn field(&self, field_id: &str) -> Option<&Js> {
        self.data()?.get(field_id)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPoint {
    pub type_id: String,
    pub display_name: String,
    /// Movements may create this type.
    pub writable: bool,
    /// Movements may enumerate it from the root.
    pub readable: bool,
    /// A listen is delivered records of this type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fires: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub rest: Obj,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeDescriptor {
    pub type_id: String,
    pub display_name: String,
    pub fields: Vec<Field>,
    pub references: Vec<Reference>,
    /// `deleteRecord` removes a record of this type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletable: Option<bool>,
    #[serde(flatten)]
    pub rest: Obj,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub field_id: String,
    pub display_name: String,
    /// `string`, `number`, `boolean`, `date`, `file`, `json` or `enum`.
    pub kind: String,
    pub writable: bool,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(flatten)]
    pub rest: Obj,
}

impl Field {
    /// A field of `kind`, named the same for display.
    pub fn new(field_id: &str, kind: &str, writable: bool, required: bool) -> Field {
        Field {
            field_id: field_id.into(),
            display_name: field_id.into(),
            kind: kind.into(),
            writable,
            required,
            cardinality: None,
            enum_values: None,
            rest: Obj::new(),
        }
    }
}

/// An edge to another type. Only an explicit `writable: true` allows
/// creating along it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub field_id: String,
    pub name: String,
    pub target_type_id: String,
    pub cardinality: String,
    pub direction: String,
    pub writable: bool,
    /// `awaitable`, `watchable`, `resolvesEmpty`, `readable`.
    #[serde(flatten)]
    pub rest: Obj,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Describe {
    pub type_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveEntity {
    pub record: Obj,
    pub record_type: String,
    #[serde(default)]
    pub candidates: Vec<Js>,
    #[serde(default)]
    pub constraints: Option<Js>,
}

/// A record of this adapter's, as `resolveEntity` and the writes name it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRef {
    pub adapter_type: String,
    pub external_id: String,
    pub record_type: String,
    pub data: Obj,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Candidates {
    pub candidates: Vec<RecordRef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFieldValue {
    pub position: Position,
    pub field_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRelated {
    pub position: Position,
    pub field_id: String,
    #[serde(default)]
    pub direction: Option<String>,
    /// `where`, `orderBy`, `limit`: hints the host applies again.
    #[serde(flatten)]
    pub hints: Obj,
}

#[derive(Debug, Clone, Serialize)]
pub struct Related {
    pub position: Position,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRecord {
    pub record_type: String,
    /// Keyed by the type's field display names.
    pub fields: Obj,
    #[serde(default)]
    pub mutation_context: Option<Js>,
    #[serde(default)]
    pub parent_links: Vec<Js>,
    /// `evidence`, `resources`, `bridgeToExternal`.
    #[serde(flatten)]
    pub rest: Obj,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecord {
    pub external_id: String,
    pub record_type: String,
    pub fields: Obj,
    #[serde(default)]
    pub mutation_context: Option<Js>,
    #[serde(default)]
    pub parent_links: Vec<Js>,
    #[serde(flatten)]
    pub rest: Obj,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecord {
    pub record_type: String,
    pub external_id: String,
    #[serde(default)]
    pub mutation_context: Option<Js>,
}

/// A write's answer: the record as it now stands, which a movement reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    #[serde(flatten)]
    pub record: RecordRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<Js>>,
}

#[derive(Debug, Clone)]
pub enum Updated {
    /// `association`: what became of the `parentLinks` (`made`, `already`,
    /// `unsupported`, `none`).
    Record { written: Written, association: Option<String> },
    /// The record is gone.
    NotFound,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Deleted {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<Js>>,
}

pub trait Adapter {
    fn manifest(&self) -> AdapterManifest;

    /// The types a movement can start from.
    fn list_entry_points(&self, ctx: &Ctx) -> impl Future<Output = Answer<Vec<EntryPoint>>>;

    /// One type, or `None` when unknown.
    fn describe(&self, ctx: &Ctx, request: Describe) -> impl Future<Output = Answer<Option<TypeDescriptor>>>;

    /// Whether a record about to be written already exists: none by default,
    /// so the host creates.
    fn resolve_entity(&self, _ctx: &Ctx, _request: ResolveEntity) -> impl Future<Output = Answer<Candidates>> {
        async { Ok(Candidates::default()) }
    }

    /// A field's value: by default, read off the data the position carries.
    fn get_field_value(&self, _ctx: &Ctx, request: GetFieldValue) -> impl Future<Output = Answer<Js>> {
        async move { Ok(request.position.field(&request.field_id).cloned().unwrap_or(Js::Null)) }
    }

    fn get_related(&self, _ctx: &Ctx, _request: GetRelated) -> impl Future<Output = Answer<Vec<Related>>> {
        async { Ok(Vec::new()) }
    }

    fn create_record(&self, _ctx: &Ctx, request: CreateRecord) -> impl Future<Output = Answer<Written>> {
        async move { Err(ModuleError::adapter(format!("{} records are not written here", request.record_type)).retryable(false)) }
    }

    fn update_record(&self, _ctx: &Ctx, request: UpdateRecord) -> impl Future<Output = Answer<Updated>> {
        async move { Err(ModuleError::adapter(format!("{} records are not written here", request.record_type)).retryable(false)) }
    }

    fn delete_record(&self, _ctx: &Ctx, request: DeleteRecord) -> impl Future<Output = Answer<Deleted>> {
        async move { Err(ModuleError::adapter(format!("{} records are not deleted here", request.record_type)).retryable(false)) }
    }

    /// An optional method the manifest declares, its params and result as
    /// the protocol spells them.
    fn optional(&self, _ctx: &Ctx, method: &str, _params: Js) -> impl Future<Output = Answer<Js>> {
        let refused = ModuleError::not_implemented(method);
        async move { Err(refused) }
    }
}

/// An adapter as the host serves it.
pub struct AdapterModule<A> {
    adapter: A,
    manifest: AdapterManifest,
}

impl<A: Adapter> AdapterModule<A> {
    pub fn new(adapter: A) -> AdapterModule<A> {
        let manifest = adapter.manifest();
        AdapterModule { adapter, manifest }
    }

    async fn answer(&self, ctx: &Ctx, method: &str, params: Js) -> Answer<Js> {
        let a = &self.adapter;
        let raw = match method {
            "listEntryPoints" => to_js(&a.list_entry_points(ctx).await?)?,
            "describe" => to_js(&a.describe(ctx, from_js(method, &params)?).await?)?,
            "resolveEntity" => to_js(&a.resolve_entity(ctx, from_js(method, &params)?).await?)?,
            "getFieldValue" => a.get_field_value(ctx, from_js(method, &params)?).await?,
            "getRelated" => to_js(&a.get_related(ctx, from_js(method, &params)?).await?)?,
            "createRecord" => to_js(&a.create_record(ctx, from_js(method, &params)?).await?)?,
            "updateRecord" => match a.update_record(ctx, from_js(method, &params)?).await? {
                Updated::Record { written, association } => {
                    let mut record = to_js(&written)?;
                    if let (Js::Obj(map), Some(association)) = (&mut record, association) {
                        map.insert("association".into(), Js::str(association));
                    }
                    record
                }
                Updated::NotFound => Js::Obj(module_wire::obj! { "notFound" => Js::Bool(true) }),
            },
            "deleteRecord" => to_js(&a.delete_record(ctx, from_js(method, &params)?).await?)?,
            optional if self.manifest.optional_methods.iter().any(|m| m == optional) => a.optional(ctx, optional, params).await?,
            unknown => return Err(ModuleError::not_implemented(unknown)),
        };
        // The host checks every answer against the method's schema; a module
        // finds out here, by name, rather than as the host's shape error.
        module_wire::results::check(method, &self.manifest.adapter_type, &raw)
            .map_err(|refused| ModuleError::adapter(format!("this module's answer is not the protocol's: {refused}")).retryable(false))?;
        Ok(raw)
    }
}

impl<A: Adapter> Module for AdapterModule<A> {
    fn manifest(&self) -> Js {
        let m = &self.manifest;
        let methods: Vec<String> = REQUIRED_METHODS.iter().map(|s| s.to_string()).chain(m.optional_methods.iter().cloned()).collect();
        manifest_frame("adapter", &m.adapter_type, &m.supported_triggers, &methods, &m.declarations)
    }

    fn call<'a>(&'a self, ctx: &'a Ctx, method: &'a str, params: Js) -> LocalFuture<'a, Answer<Js>> {
        Box::pin(self.answer(ctx, method, params))
    }
}
