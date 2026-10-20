use zed_extension_api::{self as zed, LanguageServerId, Result, settings::LspSettings};

/// Starts `lf lsp`, the language server built into the `lf` binary.
struct ListenFire;

impl zed::Extension for ListenFire {
    fn new() -> Self {
        ListenFire
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);
        let configured_path = binary.as_ref().and_then(|b| b.path.clone());
        let command = configured_path.or_else(|| worktree.which("lf")).ok_or_else(|| {
            "listen-fire: no `lf` on this project's PATH. Put it on PATH, or set \
             \"lsp\": { \"lf\": { \"binary\": { \"path\": \"/path/to/lf\" } } } in Zed's settings."
                .to_string()
        })?;
        let args = binary
            .as_ref()
            .and_then(|b| b.arguments.clone())
            .unwrap_or_else(|| vec!["lsp".to_string()]);

        // The login shell's environment, so `lf` finds the same `node` a
        // terminal in this project would; settings' `env` entries win.
        let mut env = worktree.shell_env();
        if let Some(overrides) = binary.and_then(|b| b.env) {
            env.retain(|(key, _)| !overrides.contains_key(key));
            env.extend(overrides);
        }

        Ok(zed::Command { command, args, env })
    }
}

zed::register_extension!(ListenFire);
