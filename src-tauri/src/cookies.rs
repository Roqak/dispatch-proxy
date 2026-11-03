//! The cookie jar shared by every request. Unlike reqwest's own jar it can be
//! listed and edited (the cookie manager), and persistent cookies are saved to
//! disk so they survive a restart, as in Postman.

use cookie::time::{Duration, OffsetDateTime};
use cookie_store::{CookieDomain, CookieExpiration, CookieStore, RawCookie};
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

#[derive(Default)]
pub struct Jar {
    store: RwLock<CookieStore>,
    file: RwLock<Option<PathBuf>>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CookieInfo {
    pub domain: String,
    /// True when the cookie came without a Domain attribute (exact host only).
    pub host_only: bool,
    pub path: String,
    pub name: String,
    pub value: String,
    /// Unix seconds; None for session cookies.
    pub expires: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CookieInput {
    pub domain: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default = "root")]
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub value: String,
    /// Unix seconds; None makes a session cookie.
    #[serde(default)]
    pub expires: Option<i64>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
}

fn root() -> String {
    "/".into()
}

impl Jar {
    fn read(&self) -> RwLockReadGuard<'_, CookieStore> {
        self.store.read().unwrap_or_else(|p| p.into_inner())
    }
    fn write(&self) -> RwLockWriteGuard<'_, CookieStore> {
        self.store.write().unwrap_or_else(|p| p.into_inner())
    }

    /// Loads cookies saved earlier and remembers where to save them.
    pub fn attach(&self, file: PathBuf) {
        if let Ok(f) = std::fs::File::open(&file) {
            if let Ok(saved) = cookie_store::serde::json::load(std::io::BufReader::new(f)) {
                *self.write() = saved;
            }
        }
        *self.file.write().unwrap_or_else(|p| p.into_inner()) = Some(file);
    }

    /// Writes persistent, unexpired cookies; session cookies stay in memory only.
    fn save(&self) {
        let Some(file) = self.file.read().unwrap_or_else(|p| p.into_inner()).clone() else { return };
        let mut buf = Vec::new();
        if cookie_store::serde::json::save(&self.read(), &mut buf).is_err() {
            return;
        }
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, buf).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }

    pub fn list(&self) -> Vec<CookieInfo> {
        let mut out: Vec<CookieInfo> = self
            .read()
            .iter_unexpired()
            .map(|c| {
                let (domain, host_only) = match &c.domain {
                    CookieDomain::HostOnly(d) => (d.clone(), true),
                    CookieDomain::Suffix(d) => (d.clone(), false),
                    _ => (String::new(), true),
                };
                CookieInfo {
                    domain,
                    host_only,
                    path: c.path.as_ref().to_string(),
                    name: c.name().to_string(),
                    value: c.value().to_string(),
                    expires: match &c.expires {
                        CookieExpiration::AtUtc(t) => Some(t.unix_timestamp()),
                        CookieExpiration::SessionEnd => None,
                    },
                    secure: c.secure().unwrap_or(false),
                    http_only: c.http_only().unwrap_or(false),
                    same_site: c.same_site().map(|s| s.to_string()),
                }
            })
            .collect();
        out.sort_by(|a, b| (&a.domain, &a.path, &a.name).cmp(&(&b.domain, &b.path, &b.name)));
        out
    }

    pub fn set(&self, c: CookieInput) -> Result<(), String> {
        let domain = c.domain.trim().trim_start_matches('.').to_ascii_lowercase();
        if domain.is_empty() || domain.contains(['/', ' ', ':']) {
            return Err("Enter a domain such as api.example.com.".into());
        }
        let name = c.name.trim();
        if name.is_empty() || name.contains(['=', ';', ' ']) {
            return Err("Cookie names can't be empty or contain =, ; or spaces.".into());
        }
        let path = if c.path.starts_with('/') { c.path.clone() } else { format!("/{}", c.path) };
        let mut b = RawCookie::build((name.to_string(), c.value.clone())).path(path.clone()).secure(c.secure).http_only(c.http_only);
        if !c.host_only {
            b = b.domain(domain.clone());
        }
        if let Some(exp) = c.expires {
            let at = OffsetDateTime::from_unix_timestamp(exp).map_err(|_| "That expiry date is out of range.".to_string())?;
            let left = (at - OffsetDateTime::now_utc()).whole_seconds();
            // A date in the past removes the cookie, as a browser would.
            if left <= 0 {
                self.delete(&domain, &path, name);
                return Ok(());
            }
            b = b.max_age(Duration::seconds(left));
        }
        let raw = b.build();
        let url = reqwest::Url::parse(&format!("{}://{domain}{path}", if c.secure { "https" } else { "http" }))
            .map_err(|e| format!("Couldn't use that domain/path: {e}"))?;
        self.write().insert_raw(&raw, &url).map_err(|e| format!("Couldn't save the cookie: {e}"))?;
        self.save();
        Ok(())
    }

    pub fn delete(&self, domain: &str, path: &str, name: &str) -> bool {
        let removed = self.write().remove(domain, path, name).is_some();
        if removed {
            self.save();
        }
        removed
    }

    pub fn clear(&self) {
        self.write().clear();
        self.save();
    }
}

impl reqwest::cookie::CookieStore for Jar {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &reqwest::Url) {
        let parsed: Vec<RawCookie<'static>> = headers
            .filter_map(|v| v.to_str().ok())
            .filter_map(|s| RawCookie::parse(s.to_owned()).ok())
            .collect();
        if parsed.is_empty() {
            return;
        }
        self.write().store_response_cookies(parsed.into_iter(), url);
        self.save();
    }

    fn cookies(&self, url: &reqwest::Url) -> Option<HeaderValue> {
        let header = self
            .read()
            .get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        if header.is_empty() {
            None
        } else {
            HeaderValue::from_str(&header).ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::cookie::CookieStore as _;

    fn input(domain: &str, name: &str, value: &str) -> CookieInput {
        CookieInput { domain: domain.into(), host_only: false, path: "/".into(), name: name.into(), value: value.into(), expires: None, secure: false, http_only: false }
    }

    #[test]
    fn stores_response_cookies_and_sends_them_back() {
        let jar = Jar::default();
        let url = reqwest::Url::parse("https://api.example.com/login").unwrap();
        let headers = [HeaderValue::from_static("sid=abc; Path=/; HttpOnly"), HeaderValue::from_static("theme=dark; Domain=example.com; Max-Age=3600")];
        jar.set_cookies(&mut headers.iter(), &url);
        let sent = jar.cookies(&reqwest::Url::parse("https://api.example.com/x").unwrap()).unwrap();
        let sent = sent.to_str().unwrap();
        assert!(sent.contains("sid=abc") && sent.contains("theme=dark"), "{sent}");
        // Host-only cookie isn't sent to a sibling host; the domain cookie is.
        let other = jar.cookies(&reqwest::Url::parse("https://www.example.com/").unwrap()).unwrap();
        assert_eq!(other.to_str().unwrap(), "theme=dark");

        let list = jar.list();
        assert_eq!(list.len(), 2);
        let sid = list.iter().find(|c| c.name == "sid").unwrap();
        assert!(sid.host_only && sid.http_only && sid.expires.is_none());
        assert_eq!(sid.domain, "api.example.com");
        let theme = list.iter().find(|c| c.name == "theme").unwrap();
        assert!(!theme.host_only && theme.expires.is_some());
    }

    #[test]
    fn manual_edits_and_validation() {
        let jar = Jar::default();
        jar.set(input(".Example.com", "token", "t1")).unwrap();
        assert_eq!(jar.cookies(&reqwest::Url::parse("http://a.example.com/").unwrap()).unwrap().to_str().unwrap(), "token=t1");
        jar.set(input("example.com", "token", "t2")).unwrap();
        assert_eq!(jar.list().len(), 1, "same domain/path/name replaces");
        assert_eq!(jar.list()[0].value, "t2");
        assert!(jar.set(input("", "x", "1")).is_err());
        assert!(jar.set(input("example.com", "bad name", "1")).is_err());
        jar.set(input("example.com", "old", "1")).unwrap();
        jar.set(CookieInput { expires: Some(1), ..input("example.com", "old", "1") }).unwrap();
        assert!(jar.list().iter().all(|c| c.name != "old"), "a past expiry deletes the cookie");
        assert!(jar.delete("example.com", "/", "token"));
        assert!(jar.list().is_empty());
    }

    #[test]
    fn persists_only_lasting_cookies() {
        let dir = std::env::temp_dir().join(format!("dispatch-cookies-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cookies.json");
        let _ = std::fs::remove_file(&file);
        let jar = Jar::default();
        jar.attach(file.clone());
        jar.set(input("example.com", "session", "s")).unwrap();
        jar.set(CookieInput { expires: Some(OffsetDateTime::now_utc().unix_timestamp() + 3600), ..input("example.com", "keep", "k") }).unwrap();
        let again = Jar::default();
        again.attach(file.clone());
        let names: Vec<String> = again.list().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["keep".to_string()]);
        again.clear();
        let third = Jar::default();
        third.attach(file);
        assert!(third.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
