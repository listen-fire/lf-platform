//! OAuth 2 from what a module's manifest declares (`credentials[].oauth2`),
//! as movement-engine services/secrets/{oauth2,connect}.ts do it: the host's
//! generic refresh (the standard refresh-token grant at the declared token
//! URL), the authorize URL a person opens (state, PKCE), and the exchange of
//! the code the redirect brings back.

use crate::json::Js;
use crate::secrets_family::Fields;

/// `WireCredentialField`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredField {
    pub name: String,
    pub label: Option<String>,
    /// Absent means secret.
    pub secret: Option<bool>,
    pub optional: Option<bool>,
}

/// `WireOAuth2Declaration`.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuth2Declaration {
    pub authorize_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// Where the client id and secret go on the token call: `basic` (absent) or `body`.
    pub client_auth: Option<ClientAuth>,
    pub pkce: bool,
    pub authorize_params: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAuth {
    Basic,
    Body,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeclarationKind {
    Static,
    OAuth2(OAuth2Declaration),
}

/// `WireCredentialDeclaration`: a credential the module needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Declaration {
    pub name: String,
    pub kind: DeclarationKind,
    pub fields: Vec<DeclaredField>,
}

impl Declaration {
    pub fn oauth2(&self) -> Option<&OAuth2Declaration> {
        match &self.kind {
            DeclarationKind::OAuth2(o) => Some(o),
            DeclarationKind::Static => None,
        }
    }
}

/// The token fields every OAuth 2 credential holds (`OAUTH2_TOKEN_FIELDS`).
pub const OAUTH2_TOKEN_FIELDS: [&str; 3] = ["access_token", "refresh_token", "expires_at"];

/// The `credentials` of a manifest answer, held to the protocol's schema.
pub fn declarations_of(manifest: &Js) -> Result<Vec<Declaration>, String> {
    let Some(raw) = manifest.get("credentials") else { return Ok(Vec::new()) };
    let items = raw.as_array().ok_or("credentials: expected an array")?;
    items.iter().map(declaration_of).collect()
}

fn string_at(value: &Js, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(v) => v.as_str().map(|s| Some(s.to_string())).ok_or_else(|| format!("{key}: expected string")),
    }
}

fn bool_at(value: &Js, key: &str) -> Result<Option<bool>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(Js::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("{key}: expected boolean")),
    }
}

fn declaration_of(raw: &Js) -> Result<Declaration, String> {
    let name = string_at(raw, "name")?.filter(|n| !n.is_empty()).ok_or("credentials.name: expected a credential name")?;
    let fields = raw
        .get("fields")
        .and_then(Js::as_array)
        .ok_or("credentials.fields: expected an array")?
        .iter()
        .map(|f| {
            Ok(DeclaredField {
                name: string_at(f, "name")?.filter(|n| !n.is_empty()).ok_or("credentials.fields.name: expected a non-empty string")?,
                label: string_at(f, "label")?,
                secret: bool_at(f, "secret")?,
                optional: bool_at(f, "optional")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let kind = match raw.get("kind").and_then(Js::as_str) {
        Some("static") => DeclarationKind::Static,
        Some("oauth2") => {
            let o = raw.get("oauth2").ok_or("credentials.oauth2: expected an object")?;
            let url_at = |key: &str| -> Result<String, String> {
                let text = string_at(o, key)?.ok_or_else(|| format!("credentials.oauth2.{key}: expected a URL"))?;
                url::Url::parse(&text).map_err(|_| format!("credentials.oauth2.{key}: expected a URL"))?;
                Ok(text)
            };
            let scopes = match o.get("scopes") {
                None => Vec::new(),
                Some(s) => s
                    .as_array()
                    .and_then(|items| items.iter().map(|i| i.as_str().filter(|s| !s.is_empty()).map(str::to_string)).collect::<Option<Vec<_>>>())
                    .ok_or("credentials.oauth2.scopes: expected an array of non-empty strings")?,
            };
            let client_auth = match string_at(o, "clientAuth")?.as_deref() {
                None => None,
                Some("basic") => Some(ClientAuth::Basic),
                Some("body") => Some(ClientAuth::Body),
                Some(_) => return Err("credentials.oauth2.clientAuth: expected basic or body".into()),
            };
            let authorize_params = match o.get("authorizeParams") {
                None => Vec::new(),
                Some(Js::Obj(map)) => map
                    .iter()
                    .map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())).ok_or("credentials.oauth2.authorizeParams: expected strings"))
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => return Err("credentials.oauth2.authorizeParams: expected an object".into()),
            };
            DeclarationKind::OAuth2(OAuth2Declaration {
                authorize_url: url_at("authorizeUrl")?,
                token_url: url_at("tokenUrl")?,
                scopes,
                client_auth,
                pkce: bool_at(o, "pkce")?.unwrap_or(false),
                authorize_params,
            })
        }
        _ => return Err("credentials.kind: expected static or oauth2".into()),
    };
    Ok(Declaration { name, kind, fields })
}

/// The fields of a stored credential a module that declares it is sent: the
/// ones it names, and the token fields of an `oauth2` one (`declaredFields`).
pub fn declared_fields(declaration: &Declaration, fields: &Fields) -> Fields {
    let mut names: Vec<&str> = declaration.fields.iter().map(|f| f.name.as_str()).collect();
    if declaration.oauth2().is_some() {
        names.extend(OAUTH2_TOKEN_FIELDS);
    }
    names.into_iter().filter_map(|n| fields.get(n).map(|v| (n.to_string(), v.clone()))).collect()
}

/// The fields of an update the host stores: the declaration's own. Any other
/// is refused, naming the fields and never their values (`acceptedFields`).
pub fn accepted_fields(adapter_type: &str, declaration: &Declaration, fields: Fields) -> Result<Fields, String> {
    let declared = |name: &str| declaration.fields.iter().any(|f| f.name == name) || (declaration.oauth2().is_some() && OAUTH2_TOKEN_FIELDS.contains(&name));
    let foreign: Vec<&str> = fields.keys().map(String::as_str).filter(|n| !declared(n)).collect();
    if !foreign.is_empty() {
        return Err(format!("Remote adapter \"{adapter_type}\" answered credential fields it does not declare: {}", foreign.join(", ")));
    }
    Ok(fields)
}

/// The host's own registered app at the provider.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientApp {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// A credential's own `client_id` / `client_secret`, if it has them (`clientFromFields`).
pub fn client_from_fields(fields: &Fields) -> Option<ClientApp> {
    let client_id = fields.get("client_id")?.clone();
    Some(ClientApp { client_id, client_secret: fields.get("client_secret").cloned() })
}

#[cfg(feature = "oauth")]
pub use crate::oauth2_flow::refresh_grant;

/// Without the `oauth` feature this lf refreshes no token: a credential that
/// needs one fails by name.
#[cfg(not(feature = "oauth"))]
pub async fn refresh_grant(_: &crate::secrets_family::Record, _: &str, _: Option<ClientAuth>, _: Option<&ClientApp>) -> Result<Fields, String> {
    Err(crate::core::NO_OAUTH.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(json: &str) -> Result<Vec<Declaration>, String> {
        declarations_of(&Js::parse(format!("{{\"credentials\": {json}}}").as_bytes()).unwrap())
    }

    #[test]
    fn declarations_are_read_and_held_to_the_schema() {
        let read = declared(r#"[{ "name": "acme", "kind": "oauth2", "fields": [{ "name": "workspace", "secret": false }], "oauth2": { "authorizeUrl": "https://a.test/authorize", "tokenUrl": "https://a.test/token", "scopes": ["crm.read"], "pkce": true } }]"#).unwrap();
        assert_eq!(read[0].name, "acme");
        assert_eq!(read[0].oauth2().unwrap().scopes, vec!["crm.read".to_string()]);
        assert!(declared(r#"[{ "name": "x", "kind": "magic", "fields": [] }]"#).is_err());
        assert!(declared(r#"[{ "name": "x", "kind": "oauth2", "fields": [], "oauth2": { "authorizeUrl": "nope", "tokenUrl": "https://a.test/t" } }]"#).is_err());
    }

    #[test]
    fn only_declared_fields_travel_and_only_declared_updates_land() {
        let d = &declared(r#"[{ "name": "acme", "kind": "oauth2", "fields": [{ "name": "webhook_secret" }], "oauth2": { "authorizeUrl": "https://a.test/a", "tokenUrl": "https://a.test/t" } }]"#).unwrap()[0];
        let stored: Fields = [("access_token", "a"), ("client_secret", "s"), ("webhook_secret", "w"), ("token", "t")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(declared_fields(d, &stored).keys().collect::<Vec<_>>(), vec!["access_token", "webhook_secret"]);
        let foreign = accepted_fields("acme_crm", d, Fields::from([("client_secret".to_string(), "x".to_string())])).unwrap_err();
        assert_eq!(foreign, "Remote adapter \"acme_crm\" answered credential fields it does not declare: client_secret");
    }
}
