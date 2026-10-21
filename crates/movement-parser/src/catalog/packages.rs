//! A plugin package (language version 5, design §2.10, §4.3): a tag a
//! plugin's spec declares as its `package`, matched exactly and never
//! parsed. ``import { `@lf/web` as web } from plugins`` binds each member
//! under the dotted local name `web.fetchUrl`, so a call of it is an
//! ordinary plugin call. The TypeScript twin is `packageMembers` in
//! packages/legacy-lang/checker/catalog.ts.

use crate::ast::{ImportSource, ImportedName, Program, Statement};
use crate::catalog::types::{JsMap, PluginSpec};
use crate::surface::table::plugin_name;

/// The catalog key of a package's plugin: module and name together, so two
/// packages can each serve a plugin of the same name. Compared, never parsed
/// (a spec carries its own `name`). The TypeScript twin is `pluginKey`.
pub fn plugin_key(package: &str, name: &str) -> String {
    format!("{package}/{name}")
}

/// A plugin as a program writes it: its key, unless the spec says otherwise.
pub fn program_name_of<'a>(key: &'a str, spec: &'a PluginSpec) -> &'a str {
    spec.name.as_deref().unwrap_or(key)
}

/// What a written plugin name stands for.
pub enum FoundPlugin<'p> {
    One { key: &'p str, spec: &'p PluginSpec },
    /// Several packages serve a plugin of that name; a bare import cannot say which.
    Ambiguous(Vec<&'p str>),
    None,
}

/// The entry keyed by exactly `name` (a package member's key), else the one
/// entry whose program name it is (a bare import, as versions 1 to 4 write
/// it). The TypeScript twin is `findPlugin`.
pub fn find_plugin<'p>(plugins: &'p JsMap<PluginSpec>, name: &str) -> FoundPlugin<'p> {
    if let Some((key, spec)) = plugins.get_key_value(name) {
        return FoundPlugin::One { key, spec };
    }
    let named: Vec<(&String, &PluginSpec)> = plugins.iter().filter(|(key, spec)| program_name_of(key, spec) == name).collect();
    match named.as_slice() {
        [] => FoundPlugin::None,
        [(key, spec)] => FoundPlugin::One { key, spec },
        _ => FoundPlugin::Ambiguous(named.iter().map(|(_, spec)| spec.package.as_deref().unwrap_or("(no package)")).collect()),
    }
}

/// The packages that serve a bare plugin name, when more than one does.
pub fn ambiguous_packages<'p>(plugins: &'p JsMap<PluginSpec>, name: &str) -> Vec<&'p str> {
    match find_plugin(plugins, name) {
        FoundPlugin::Ambiguous(packages) => packages,
        _ => Vec::new(),
    }
}

/// One plugin of a package: the name it is called by after the package's
/// local name and a dot, and the catalog's key it invokes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageMember {
    pub name: String,
    pub key: String,
}

/// The plugins whose spec declares `tag` as its package, in catalog order;
/// none when no spec does, which is how a package import is told from an
/// import of one plugin.
pub fn package_members(plugins: &JsMap<PluginSpec>, tag: &str) -> Vec<PackageMember> {
    plugins
        .iter()
        .filter(|(_, spec)| spec.package.as_deref() == Some(tag))
        .map(|(key, spec)| PackageMember { name: plugin_name(program_name_of(key, spec)), key: key.clone() })
        .collect()
}

/// The package a bare name stands for when the program imported none: the
/// tag whose default local name is `name` (`@lf/pdf` → `pdf`). The TypeScript
/// twin is `packageCalled` in packages/legacy-lang/checker/catalog.ts.
pub fn package_called(plugins: &JsMap<PluginSpec>, name: &str) -> Option<String> {
    plugins
        .iter()
        .filter_map(|(_, spec)| spec.package.as_deref())
        .find(|tag| crate::stmt::local_name_for_tag(tag) == name)
        .map(str::to_string)
}

/// The local name a package's member is bound to: `web.fetchUrl`.
pub fn member_local(package_local: &str, member: &str) -> String {
    format!("{package_local}.{member}")
}

/// The program with each package import read as the imports of its members
/// (`` `@lf/web` as web `` → `fetch_url as web.fetchUrl`, …), which is what
/// an engine binds. An import that names no package is left as written. The
/// checkers do not read this: they bind the same names themselves, keeping
/// the package to name in a diagnostic.
pub fn expand_package_imports(program: &mut Program, plugins: &JsMap<PluginSpec>) {
    for statement in &mut program.statements {
        let Statement::Import(import) = statement else { continue };
        if !matches!(&import.source, ImportSource::Builtin { namespace } if namespace == "plugins") {
            continue;
        }
        import.names = std::mem::take(&mut import.names)
            .into_iter()
            .flat_map(|imported| {
                let members = package_members(plugins, &imported.name);
                if members.is_empty() {
                    return vec![imported];
                }
                let local = imported.alias.unwrap_or(imported.name);
                members.into_iter().map(|m| ImportedName { alias: Some(member_local(&local, &m.name)), name: m.key }).collect()
            })
            .collect();
    }
}
