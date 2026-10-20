# Movement files in Zed

[`editors/zed`](../editors/zed) is a Zed extension for `.mvt` files: highlighting from the tree-sitter grammar in [`editors/tree-sitter-movement`](../editors/tree-sitter-movement), and diagnostics, completion, hover, go-to-definition and fixes from `lf lsp`.

1. Install it: in Zed, run `zed: install dev extension` and pick `editors/zed` in your clone. Zed needs Rust installed through rustup (it adds the `wasm32-wasip2` target itself).
2. Open your project folder (the one with `lf.yaml`) and trust it when Zed asks. Zed starts no language server in an untrusted folder.
3. Point Zed at `lf` if it is not on your PATH, in Zed's `settings.json`:

```json
"lsp": {
  "lf": {
    "binary": {
      "path": "/path/to/listen-fire/target/release/lf",
      "arguments": ["lsp"],
      "env": { "PATH": "/path/to/node-22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
    }
  }
}
```

- The server runs with your login shell's PATH. Projects with custom plugins need node 22: with an older `node` first on that PATH, the plugins do not start, and every plugin call shows as an unknown import. Set `env.PATH` as above, or make node 22 your shell's default (`nvm alias default 22`).
- With a `path`, Zed runs that binary itself with exactly `arguments`, so `["lsp"]` is required there; without one, the extension finds `lf` on PATH and adds `lsp`. `env` entries replace the shell's own.
- Zed fetches the grammar at the commit `rev` names in [`extension.toml`](../editors/zed/extension.toml). After changing the grammar, run `editors/tree-sitter-movement/check.sh` (every `.mvt` in the repository must parse without an error node), commit, then move `rev` to that commit. Until that commit is pushed, set the grammar's `repository` to `file:///path/to/your/clone` to rebuild locally.
