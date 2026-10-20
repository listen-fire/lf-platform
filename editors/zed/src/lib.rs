use zed_extension_api::{self as zed, LanguageServerId, Result};

/// Starts `lf lsp`, the language server built into the `lf` binary.
///
/// Zed calls this only when settings name no `lsp.lf.binary.path` (with a
/// path, Zed runs it itself, with the settings' `arguments`). Zed adds the
/// login shell's environment and the settings' `env` and `arguments` on top.
struct ListenFire;

impl zed::Extension for ListenFire {
    fn new() -> Self {
        ListenFire
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let command = worktree.which("lf").ok_or_else(|| {
            "listen-fire: no `lf` on this project's PATH. Put it on PATH, or set \
             \"lsp\": { \"lf\": { \"binary\": { \"path\": \"/path/to/lf\", \"arguments\": [\"lsp\"] } } } \
             in Zed's settings."
                .to_string()
        })?;
        Ok(zed::Command { command, args: vec!["lsp".to_string()], env: Vec::new() })
    }
}

zed::register_extension!(ListenFire);
