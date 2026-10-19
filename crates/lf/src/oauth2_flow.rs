//! The token calls and the authorize URL of an OAuth 2 credential (the `oauth`
//! cargo feature); the declarations and the app they name are src/oauth2.rs.

use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::http_out::{base64, base64url, encode_uri_component, form, post, random_bytes};
use crate::json::Js;
use crate::oauth2::{ClientApp, ClientAuth, OAuth2Declaration, client_from_fields};
use crate::secrets_family::{Fields, Record, iso_instant, now_ms, redact_secrets};

fn token_headers() -> Vec<(String, String)> {
    vec![("content-type".into(), "application/x-www-form-urlencoded".into()), ("accept".into(), "application/json".into())]
}

/// Put the app on a token call where the declaration says (`authenticateClient`).
fn authenticate(client: &ClientApp, client_auth: Option<ClientAuth>, form: &mut Vec<(String, String)>, headers: &mut Vec<(String, String)>) {
    if client_auth.unwrap_or(ClientAuth::Basic) == ClientAuth::Basic {
        let pair = format!("{}:{}", encode_uri_component(&client.client_id), encode_uri_component(client.client_secret.as_deref().unwrap_or_default()));
        headers.push(("authorization".into(), format!("Basic {}", base64(pair.as_bytes()))));
        return;
    }
    form.retain(|(k, _)| k != "client_id" && k != "client_secret");
    form.push(("client_id".into(), client.client_id.clone()));
    if let Some(secret) = &client.client_secret {
        form.push(("client_secret".into(), secret.clone()));
    }
}

fn form_text(pairs: &[(String, String)]) -> String {
    form(&pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>())
}

const ERROR_BODY_CHARS: usize = 200;

fn head(text: &str) -> String {
    text.chars().take(ERROR_BODY_CHARS).collect()
}

/// The token fields of a token endpoint's answer; `None` when it has no access token.
fn token_fields(body: &Js) -> Option<Fields> {
    let access_token = body.get("access_token")?.as_str().filter(|t| !t.is_empty())?;
    let mut changed = Fields::from([("access_token".to_string(), access_token.to_string())]);
    // `z.coerce.number()`: a number, or text that reads as one.
    let expires_in = match body.get("expires_in") {
        None => None,
        Some(Js::Num(n)) => n.as_f64(),
        Some(Js::Str(s)) => Some(if s.trim().is_empty() { 0.0 } else { s.trim().parse::<f64>().ok()? }),
        Some(Js::Null) => Some(0.0),
        Some(Js::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(_) => return None,
    };
    if let Some(seconds) = expires_in {
        changed.insert("expires_at".into(), iso_instant(now_ms() + (seconds * 1000.0) as i64));
    }
    match body.get("refresh_token") {
        None => {}
        Some(Js::Str(r)) if !r.is_empty() => {
            changed.insert("refresh_token".into(), r.clone());
        }
        Some(_) => return None,
    }
    Some(changed)
}

/// The standard refresh-token grant (`oauth2Refresher`). `client` absent: the
/// credential's own client fields, if it has them.
pub async fn refresh_grant(current: &Record, token_url: &str, client_auth: Option<ClientAuth>, client: Option<&ClientApp>) -> Result<Fields, String> {
    let refresh_token = current.fields.get("refresh_token").filter(|t| !t.is_empty()).ok_or("the credential holds no refresh_token")?;
    let own = client_from_fields(&current.fields);
    let client = client.or(own.as_ref());
    let mut form = vec![("grant_type".to_string(), "refresh_token".to_string()), ("refresh_token".to_string(), refresh_token.clone())];
    let mut headers = token_headers();
    if let Some(client) = client {
        authenticate(client, client_auth, &mut form, &mut headers);
    }
    let answer = post(token_url, &headers, form_text(&form)).await?;
    if !(200..300).contains(&answer.status) {
        return Err(format!("HTTP {} from {token_url}: {}", answer.status, head(&answer.body)));
    }
    let body = Js::parse(answer.body.as_bytes()).map_err(|_| format!("the answer from {token_url} has no access_token"))?;
    token_fields(&body).ok_or_else(|| format!("the answer from {token_url} has no access_token"))
}

// ── Connecting: the authorize URL and the code exchange ─────────────────────

/// What the redirect must bring back to be completed.
pub struct Attempt {
    pub redirect_uri: String,
    pub code_verifier: Option<String>,
}

const VERIFIER_BYTES: usize = 96;

pub fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// The provider's authorize URL for one attempt (`beginOAuth2Connect`).
pub fn begin(oauth2: &OAuth2Declaration, client_id: &str, redirect_uri: &str, state: &str) -> Result<(String, Attempt), String> {
    let code_verifier = if oauth2.pkce { Some(base64url(&random_bytes(VERIFIER_BYTES)?)) } else { None };
    let mut url = url::Url::parse(&oauth2.authorize_url).map_err(|e| format!("{}: {e}", oauth2.authorize_url))?;
    let mut pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let mut set = |key: &str, value: &str| match pairs.iter().position(|(k, _)| k == key) {
        // `URLSearchParams.set`: the first keeps its place, the others go.
        Some(at) => {
            pairs[at].1 = value.to_string();
            let mut seen = 0;
            pairs.retain(|(k, _)| {
                if k != key {
                    return true;
                }
                seen += 1;
                seen == 1
            });
        }
        None => pairs.push((key.to_string(), value.to_string())),
    };
    set("response_type", "code");
    set("client_id", client_id);
    set("redirect_uri", redirect_uri);
    if !oauth2.scopes.is_empty() {
        set("scope", &oauth2.scopes.join(" "));
    }
    set("state", state);
    if let Some(verifier) = &code_verifier {
        set("code_challenge", &pkce_challenge(verifier));
        set("code_challenge_method", "S256");
    }
    for (key, value) in &oauth2.authorize_params {
        set(key, value);
    }
    url.set_query(Some(&form_text(&pairs)));
    Ok((url.to_string(), Attempt { redirect_uri: redirect_uri.to_string(), code_verifier }))
}

const EXCHANGE_TRIES: u32 = 3;
const EXCHANGE_RETRY_DELAY_MS: u64 = 250;

/// Exchange the code the redirect brought back (`exchangeOAuth2Code`): the
/// token fields. A 5xx or a network error is retried twice.
pub async fn exchange_code(oauth2: &OAuth2Declaration, client: &ClientApp, attempt: &Attempt, code: &str) -> Result<Fields, String> {
    let token_url = &oauth2.token_url;
    let failed = |detail: String| format!("exchanging the authorization code at {token_url} failed: {detail}");
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), attempt.redirect_uri.clone()),
    ];
    if let Some(verifier) = &attempt.code_verifier {
        form.push(("code_verifier".into(), verifier.clone()));
    }
    let mut headers = token_headers();
    authenticate(client, oauth2.client_auth, &mut form, &mut headers);
    let hidden: Vec<String> = [Some(code.to_string()), client.client_secret.clone(), attempt.code_verifier.clone()].into_iter().flatten().collect();
    let mut tried = 1;
    let answer = loop {
        match post(token_url, &headers, form_text(&form)).await {
            Ok(answer) if answer.status < 500 || tried >= EXCHANGE_TRIES => break answer,
            Ok(_) => {}
            Err(why) if tried >= EXCHANGE_TRIES => return Err(failed(redact_secrets(&why, hidden.iter()))),
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(EXCHANGE_RETRY_DELAY_MS * 2u64.pow(tried - 1))).await;
        tried += 1;
    };
    if !(200..300).contains(&answer.status) {
        return Err(failed(format!("HTTP {}: {}", answer.status, redact_secrets(&head(&answer.body), hidden.iter()))));
    }
    let body = Js::parse(answer.body.as_bytes()).map_err(|_| failed("the answer is not JSON".into()))?;
    token_fields(&body).ok_or_else(|| failed("the answer has no access_token".into()))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_authorize_url_carries_what_the_declaration_asks() {
        let o = OAuth2Declaration {
            authorize_url: "http://127.0.0.1:9/authorize?keep=1".into(),
            token_url: "http://127.0.0.1:9/token".into(),
            scopes: vec!["a".into(), "b".into()],
            client_auth: None,
            pkce: true,
            authorize_params: vec![("access_type".into(), "offline".into())],
        };
        let (url, attempt) = begin(&o, "lf app", "http://127.0.0.1:8765/callback", "st").unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        let q: Vec<(String, String)> = parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let get = |k: &str| q.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("keep"), Some("1"));
        assert_eq!(get("client_id"), Some("lf app"));
        assert_eq!(get("scope"), Some("a b"));
        assert_eq!(get("code_challenge"), Some(pkce_challenge(attempt.code_verifier.as_deref().unwrap()).as_str()));
        assert_eq!(get("access_type"), Some("offline"));
        assert!(url.contains("client_id=lf+app"));
    }
}
