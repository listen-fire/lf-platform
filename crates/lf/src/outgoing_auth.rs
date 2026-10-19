//! How lf proves itself to the platform in front of a remote module (a
//! module served on Cloud Run behind IAM, say), set per module install. This
//! is separate from the module's own secret: that one stays in the request's
//! `Authorization` header (or the manifest's header), and this one goes in
//! another header when they would collide.
//!
//! The install entry's fields pick it (`lf connect`, or
//! `LF_SECRET__<ENTRY>__<FIELD>`):
//!
//! - `outgoing_auth: google-identity`: a Google identity token for
//!   `outgoing_audience` (default: the module URL's origin), minted by the
//!   metadata server (`GCE_METADATA_HOST`, default `metadata.google.internal`)
//!   as on Cloud Run, cached until shortly before it expires.
//! - `outgoing_auth: bearer`: the static `outgoing_token`, sent as
//!   `Bearer <token>`.
//!
//! `outgoing_header` names the header. By default it is `authorization`, or
//! `x-serverless-authorization` (which Cloud Run reads as its own) when the
//! call already carries the module's secret in `authorization`.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const OUTGOING_AUTH_FIELD: &str = "outgoing_auth";
pub const OUTGOING_AUDIENCE_FIELD: &str = "outgoing_audience";
pub const OUTGOING_HEADER_FIELD: &str = "outgoing_header";
pub const OUTGOING_TOKEN_FIELD: &str = "outgoing_token";

#[derive(Debug, Clone, PartialEq)]
pub enum OutgoingAuth {
    GoogleIdentity { audience: String, header: Option<String> },
    Bearer { token: String, header: Option<String> },
}

impl OutgoingAuth {
    /// What an install's fields ask for; None when they ask for nothing.
    pub fn of_fields(fields: &BTreeMap<String, String>, base_url: &str) -> Result<Option<OutgoingAuth>, String> {
        let field = |name: &str| fields.get(name).map(String::as_str).filter(|v| !v.is_empty());
        let header = field(OUTGOING_HEADER_FIELD).map(str::to_ascii_lowercase);
        match field(OUTGOING_AUTH_FIELD) {
            None | Some("none") => Ok(None),
            Some("google-identity") => {
                let audience = match field(OUTGOING_AUDIENCE_FIELD) {
                    Some(audience) => audience.to_string(),
                    None => origin_of(base_url).ok_or_else(|| format!("{base_url}: a Google identity token needs an https:// module URL, or an `{OUTGOING_AUDIENCE_FIELD}`"))?,
                };
                Ok(Some(OutgoingAuth::GoogleIdentity { audience, header }))
            }
            Some("bearer") => {
                let token = field(OUTGOING_TOKEN_FIELD).ok_or_else(|| format!("`{OUTGOING_AUTH_FIELD}: bearer` needs an `{OUTGOING_TOKEN_FIELD}`"))?;
                Ok(Some(OutgoingAuth::Bearer { token: token.to_string(), header }))
            }
            Some(other) => Err(format!("`{OUTGOING_AUTH_FIELD}: {other}` is not one lf knows (google-identity, bearer or none)")),
        }
    }

    /// The header to add to a call that already carries `headers`.
    pub async fn header(&self, headers: &[(String, String)]) -> Result<(String, String), String> {
        let (token, named) = match self {
            OutgoingAuth::GoogleIdentity { audience, header } => (google_identity_token(audience).await?, header),
            OutgoingAuth::Bearer { token, header } => (token.clone(), header),
        };
        let carries_authorization = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization"));
        let name = named.clone().unwrap_or_else(|| if carries_authorization { "x-serverless-authorization".into() } else { "authorization".into() });
        Ok((name, format!("Bearer {token}")))
    }
}

/// `https://host[:port]` of an https URL.
fn origin_of(base_url: &str) -> Option<String> {
    let url = url::Url::parse(base_url).ok()?;
    (url.scheme() == "https").then(|| url.origin().ascii_serialization())
}

/// Minted tokens, by audience, with when to stop using them.
static TOKENS: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);

/// A token is renewed this long before it expires.
const EARLY: Duration = Duration::from_secs(300);
/// A token whose expiry cannot be read is kept this long (Google's last an hour).
const UNREAD_EXPIRY: Duration = Duration::from_secs(45 * 60);

async fn google_identity_token(audience: &str) -> Result<String, String> {
    if let Some((token, until)) = TOKENS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).get(audience)
        && Instant::now() < *until
    {
        return Ok(token.clone());
    }
    let host = std::env::var("GCE_METADATA_HOST").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| "metadata.google.internal".into());
    let url = format!(
        "http://{host}/computeMetadata/v1/instance/service-accounts/default/identity?audience={}&format=full",
        crate::http_out::encode_uri_component(audience)
    );
    let answer = crate::module_transport::get(&url, &[("metadata-flavor".into(), "Google".into())])
        .await
        .map_err(|e| format!("no Google identity token for {audience}: the metadata server ({host}) could not be reached: {e}"))?;
    if answer.status != 200 {
        return Err(format!("no Google identity token for {audience}: the metadata server answered HTTP {}", answer.status));
    }
    let token = String::from_utf8_lossy(&answer.body).trim().to_string();
    let lasts = expires_in(&token).map(|left| left.saturating_sub(EARLY)).unwrap_or(UNREAD_EXPIRY);
    TOKENS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(audience.to_string(), (token.clone(), Instant::now() + lasts));
    Ok(token)
}

/// How long a JWT has left, read off its `exp`.
fn expires_in(token: &str) -> Option<Duration> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let exp = claims.get("exp")?.as_u64()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(Duration::from_secs(exp.saturating_sub(now)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn an_install_asks_for_a_google_identity_token_or_a_static_bearer() {
        assert_eq!(OutgoingAuth::of_fields(&fields(&[]), "https://m.run.app/"), Ok(None));
        assert_eq!(
            OutgoingAuth::of_fields(&fields(&[("outgoing_auth", "google-identity")]), "https://m-abc.a.run.app/rpc"),
            Ok(Some(OutgoingAuth::GoogleIdentity { audience: "https://m-abc.a.run.app".into(), header: None }))
        );
        assert!(OutgoingAuth::of_fields(&fields(&[("outgoing_auth", "google-identity")]), "unix:/s").unwrap_err().contains("outgoing_audience"));
        assert_eq!(
            OutgoingAuth::of_fields(&fields(&[("outgoing_auth", "bearer"), ("outgoing_token", "t"), ("outgoing_header", "X-Proxy-Auth")]), "https://x/"),
            Ok(Some(OutgoingAuth::Bearer { token: "t".into(), header: Some("x-proxy-auth".into()) }))
        );
        assert!(OutgoingAuth::of_fields(&fields(&[("outgoing_auth", "bearer")]), "https://x/").is_err());
        assert!(OutgoingAuth::of_fields(&fields(&[("outgoing_auth", "kerberos")]), "https://x/").is_err());
    }

    #[tokio::test]
    async fn the_header_moves_aside_when_the_module_secret_holds_authorization() {
        let auth = OutgoingAuth::Bearer { token: "t".into(), header: None };
        assert_eq!(auth.header(&[]).await.unwrap(), ("authorization".into(), "Bearer t".into()));
        let carried = [("authorization".to_string(), "Bearer module".to_string())];
        assert_eq!(auth.header(&carried).await.unwrap(), ("x-serverless-authorization".into(), "Bearer t".into()));
    }

    #[test]
    fn a_tokens_expiry_is_read_off_its_exp() {
        use base64::Engine;
        let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 3600;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{{\"exp\":{exp}}}"));
        let left = expires_in(&format!("h.{payload}.s")).unwrap();
        assert!(left > Duration::from_secs(3500) && left <= Duration::from_secs(3600));
        assert_eq!(expires_in("not a jwt"), None);
    }
}
