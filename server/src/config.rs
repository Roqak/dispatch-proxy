//! Environment-driven configuration, read once at boot.

use std::env;

use crate::auth::random_hex;

pub struct Config {
    /// The one shared Postman API key, sent upstream as `X-Api-Key`.
    /// None disables proxying (server keeps booting so auth/admin work).
    pub postman_api_key: Option<String>,
    /// Postman API base URL (no trailing slash): region-derived or the
    /// POSTMAN_API_BASE override.
    pub postman_base: String,
    pub listen_addr: String,
    pub db_path: String,
    /// true = register/login with Bearer tokens; false = open proxy plus
    /// POST /auth/admin-login against ADMIN_PASSWORD.
    pub require_auth: bool,
    /// Only meaningful when `require_auth` is false: the env-provided admin
    /// password, or a fresh random one that was printed at boot.
    pub admin_password: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let postman_api_key = env::var("POSTMAN_API_KEY").ok().filter(|v| !v.is_empty());

        let postman_base = match env::var("POSTMAN_API_BASE").ok().filter(|v| !v.trim().is_empty()) {
            Some(base) => base.trim().trim_end_matches('/').to_string(),
            None => match env::var("POSTMAN_REGION").ok().filter(|v| !v.is_empty()).as_deref() {
                None | Some("us") => "https://api.postman.com".to_string(),
                Some("eu") => "https://api.eu.postman.com".to_string(),
                Some(other) => {
                    return Err(format!("POSTMAN_REGION must be \"us\" or \"eu\" (got \"{other}\")"))
                }
            },
        };

        let listen_addr = match env::var("LISTEN_ADDR").ok().filter(|v| !v.trim().is_empty()) {
            Some(addr) => addr,
            None => match env::var("PORT").ok().filter(|v| !v.trim().is_empty()) {
                // Render/Railway-style PaaS: bind all interfaces on the
                // platform-assigned port. Local runs keep the loopback default.
                Some(p) => format!("0.0.0.0:{p}"),
                None => "127.0.0.1:8383".into(),
            },
        };

        let db_path = env::var("DB_PATH")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "./dispatch-server.db".into());

        let require_auth = match env::var("REQUIRE_AUTH").ok().filter(|v| !v.is_empty()).as_deref() {
            None | Some("true") => true,
            Some("false") => false,
            Some(other) => {
                return Err(format!("REQUIRE_AUTH must be \"true\" or \"false\" (got \"{other}\")"))
            }
        };

        let admin_password = if require_auth {
            None
        } else {
            match env::var("ADMIN_PASSWORD").ok().filter(|v| !v.is_empty()) {
                Some(set) => Some(set),
                None => {
                    let generated = random_hex(16);
                    println!(
                        "dispatch-server: REQUIRE_AUTH is off and ADMIN_PASSWORD is unset — \
                         generated admin password (this is its only appearance): {generated}"
                    );
                    Some(generated)
                }
            }
        };

        Ok(Config {
            postman_api_key,
            postman_base,
            listen_addr,
            db_path,
            require_auth,
            admin_password,
        })
    }
}