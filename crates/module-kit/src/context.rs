//! What every module method receives beside its params, what it may hand
//! back beside its result, and how it fails.

use std::cell::RefCell;

use module_wire::envelope::{ADAPTER_ERROR_CODE, BAD_REQUEST_CODE, CREDENTIAL_REFUSED_CODE, METHOD_NOT_IMPLEMENTED_CODE};
use module_wire::json::{Js, Obj};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// A method's answer: its result, or the error the envelope carries.
pub type Answer<T> = Result<T, ModuleError>;

/// One call's context: who calls, with which credential and settings, and
/// what the answer carries beside its result.
#[derive(Default)]
pub struct Ctx {
    /// The calling team (the `x-listen-fire-team` header).
    pub team_id: Option<String>,
    /// The caller's cache scope: one per adapter instance. Opaque.
    pub cache_scope_id: Option<String>,
    /// The one credential the connection names, under the declared
    /// alternative it fills (`credential.name`).
    pub credential: Option<Js>,
    /// The install's declared settings, by name.
    pub settings: Option<Js>,
    beside: RefCell<Beside>,
}

#[derive(Default)]
pub(crate) struct Beside {
    pub cost: Vec<(String, f64)>,
    pub credential_update: Option<Js>,
    pub retry_after_seconds: Option<f64>,
}

impl Ctx {
    pub fn new(team_id: Option<String>, cache_scope_id: Option<String>, credential: Option<Js>, settings: Option<Js>) -> Ctx {
        Ctx { team_id, cache_scope_id, credential, settings, beside: RefCell::default() }
    }

    /// A setting the install supplied, when it is text.
    pub fn setting(&self, name: &str) -> Option<&str> {
        self.settings.as_ref()?.get(name)?.as_str()
    }

    /// A field of the request's credential, when it is text.
    pub fn credential_field(&self, field: &str) -> Option<&str> {
        self.credential.as_ref()?.get("fields")?.get(field)?.as_str()
    }

    /// The call spent this on a paid service: the host adds it to the run's spend.
    pub fn spent(&self, label: impl Into<String>, microdollars: f64) {
        self.beside.borrow_mut().cost.push((label.into(), microdollars));
    }

    /// The request's credential changed (a rotated token): the host writes
    /// it back to the credential the connection named.
    pub fn update_credential(&self, update: Js) {
        self.beside.borrow_mut().credential_update = Some(update);
    }

    /// The provider asked for quiet: the host sends no call as this
    /// credential for this long.
    pub fn retry_after(&self, seconds: f64) {
        self.beside.borrow_mut().retry_after_seconds = Some(seconds);
    }

    pub(crate) fn take_beside(&self) -> Beside {
        self.beside.take()
    }
}

/// A method's failure, as the envelope's `{ ok: false, error }` carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub data: Option<Box<Js>>,
}

impl ModuleError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> ModuleError {
        ModuleError { code: code.into(), message: message.into(), retryable: false, data: None }
    }

    /// The module's own code failed (retryable, as the protocol's
    /// `adapter_error` is).
    pub fn adapter(message: impl std::fmt::Display) -> ModuleError {
        ModuleError::new(ADAPTER_ERROR_CODE, message.to_string()).retryable(true)
    }

    pub fn bad_request(message: impl Into<String>) -> ModuleError {
        ModuleError::new(BAD_REQUEST_CODE, message)
    }

    pub fn not_implemented(method: &str) -> ModuleError {
        ModuleError::new(METHOD_NOT_IMPLEMENTED_CODE, format!("method \"{method}\" is not implemented"))
    }

    /// The provider refused the request's credential: the host refreshes it
    /// and retries the call once.
    pub fn credential_refused(message: impl Into<String>) -> ModuleError {
        ModuleError::new(CREDENTIAL_REFUSED_CODE, message)
    }

    pub fn retryable(mut self, retryable: bool) -> ModuleError {
        self.retryable = retryable;
        self
    }

    pub fn with_data(mut self, data: Js) -> ModuleError {
        self.data = Some(Box::new(data));
        self
    }

    pub(crate) fn to_wire(&self) -> Js {
        let mut error = Obj::new();
        error.insert("code".into(), Js::str(&self.code));
        error.insert("message".into(), Js::str(&self.message));
        error.insert("retryable".into(), Js::Bool(self.retryable));
        if let Some(data) = &self.data {
            error.insert("data".into(), Js::clone(data));
        }
        Js::Obj(error)
    }
}

impl std::fmt::Display for ModuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ModuleError {}

/// A typed value as wire JSON, its fields in declaration order (through
/// text: serde_json's own value would sort them).
pub fn to_js<T: Serialize>(value: &T) -> Answer<Js> {
    let text = serde_json::to_vec(value).map_err(ModuleError::adapter)?;
    Js::parse(&text).map_err(ModuleError::adapter)
}

/// A method's params as its typed request; a mismatch is the protocol's
/// `bad_request`, worded `<method>: <problem>`.
pub fn from_js<T: DeserializeOwned>(method: &str, params: &Js) -> Answer<T> {
    serde_json::from_str(&params.to_json()).map_err(|e| ModuleError::bad_request(format!("{method}: {e}")))
}
