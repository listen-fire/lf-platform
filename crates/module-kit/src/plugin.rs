//! A plugin package: functions a movement calls, imported by the package's
//! tag (docs/contracts/adapter-protocol.md, "Plugins"). A plugin is keyed by
//! its module and its name.

use std::future::Future;

use module_wire::json::{Js, Obj};
use serde::{Deserialize, Serialize};

use crate::context::{Answer, Ctx, ModuleError, from_js, to_js};
use crate::module::{LocalFuture, Module, manifest_frame};

/// What a plugin module declares.
#[derive(Debug, Clone)]
pub struct PluginPackage {
    /// The module's name: the install's.
    pub module: String,
    /// The tag a movement imports (`` import { `@acme/text` as text } from plugins ``),
    /// matched exactly.
    pub package: String,
    pub plugins: Vec<PluginSpec>,
    /// `credentials`, `settings`, `limits`, `hostModels`, …
    pub declarations: Obj,
}

/// One plugin: its registered name (called by its camel case, `shout-out`
/// as `shoutOut`) and the spec the checker reads (`args`, `argTypes`,
/// `requiredArgs`, `effects`, `priced`, `output`, …).
#[derive(Debug, Clone)]
pub struct PluginSpec {
    pub name: String,
    pub spec: Js,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCall {
    pub name: String,
    /// The author's arguments by name.
    #[serde(default)]
    pub config: Obj,
    /// The fields extracted so far inside a `through [ … ]` stage.
    #[serde(default)]
    pub extracted_context: Obj,
}

/// What the plugin added. Every part is optional.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Obj>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records: Option<Vec<Js>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Js>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_microdollars: Option<f64>,
    /// Files it made, `{ "<field>": { name?, contentType?, base64 } }`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Obj>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

pub trait Plugins {
    fn package(&self) -> PluginPackage;

    fn invoke(&self, ctx: &Ctx, call: PluginCall) -> impl Future<Output = Answer<PluginAnswer>>;
}

/// A plugin package as the host serves it.
pub struct PluginModule<P> {
    plugins: P,
    package: PluginPackage,
}

impl<P: Plugins> PluginModule<P> {
    pub fn new(plugins: P) -> PluginModule<P> {
        let package = plugins.package();
        PluginModule { plugins, package }
    }

    async fn answer(&self, ctx: &Ctx, method: &str, params: Js) -> Answer<Js> {
        if method != "invokePlugin" {
            return Err(ModuleError::not_implemented(method));
        }
        let call: PluginCall = from_js(method, &params)?;
        if !self.package.plugins.iter().any(|p| p.name == call.name) {
            return Err(ModuleError::bad_request(format!("invokePlugin: {} has no plugin \"{}\"", self.package.package, call.name)));
        }
        let raw = to_js(&self.plugins.invoke(ctx, call).await?)?;
        module_wire::results::check(method, &self.package.module, &raw)
            .map_err(|refused| ModuleError::adapter(format!("this module's answer is not the protocol's: {refused}")).retryable(false))?;
        Ok(raw)
    }
}

impl<P: Plugins> Module for PluginModule<P> {
    fn manifest(&self) -> Js {
        let p = &self.package;
        let entries = p
            .plugins
            .iter()
            .map(|plugin| Js::Obj(module_wire::obj! { "name" => Js::str(&plugin.name), "spec" => plugin.spec.clone() }))
            .collect();
        let mut declarations = Obj::new();
        declarations.insert("plugins".into(), Js::Obj(module_wire::obj! { "package" => Js::str(&p.package), "plugins" => Js::Arr(entries) }));
        declarations.extend(p.declarations.clone());
        manifest_frame("plugin", &p.module, &[], &["invokePlugin".to_string()], &declarations)
    }

    fn call<'a>(&'a self, ctx: &'a Ctx, method: &'a str, params: Js) -> LocalFuture<'a, Answer<Js>> {
        Box::pin(self.answer(ctx, method, params))
    }
}
