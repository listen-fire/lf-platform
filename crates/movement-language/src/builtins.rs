//! Built-ins as language version 5 spells them: the spelling table's v5
//! names, with each one's signature from the standard library's and what it
//! does from the built-ins reference (`builtins.md`, which the platform's
//! handbook serves as its builtins chapter, so the two cannot drift).

use movement_checker::types::stdlib::{Builtin, ParamType, lookup_builtin};
use movement_parser::surface::table::{CORE_WORDS, NAMESPACES, SPELLINGS, Shape, Spelling, by_v5};

/// One built-in a v5 program calls.
pub struct V5Builtin {
    pub name: &'static str,
    pub spelling: &'static Spelling,
}

/// Every built-in a v5 program calls by name (operators and indexing left out).
pub fn v5_builtins() -> Vec<V5Builtin> {
    let mut out: Vec<V5Builtin> = Vec::new();
    for spelling in SPELLINGS.iter().filter(|s| !s.old_only) {
        let name = spelling.v5;
        if !name.chars().all(|c| c.is_alphanumeric() || c == '.') || out.iter().any(|b| b.name == name) {
            continue;
        }
        out.push(V5Builtin { name, spelling });
    }
    out
}

/// The core words the grammar reads that are not in the table (`sleep`, `race`, …).
pub fn grammar_words() -> impl Iterator<Item = &'static str> {
    CORE_WORDS.iter().copied().filter(|w| !SPELLINGS.iter().any(|s| s.v5 == *w))
}

pub fn namespaces() -> &'static [&'static str] {
    NAMESPACES
}

/// The built-in written `name` under version 5.
pub fn by_name(name: &str) -> Option<V5Builtin> {
    by_v5(name).map(|spelling| V5Builtin { name: spelling.v5, spelling })
}

fn param_text(param: &movement_checker::types::stdlib::Param) -> String {
    use movement_checker::types::stdlib::Arity;
    match param.arity {
        Arity::One => param.name.to_string(),
        Arity::Optional => format!("{}?", param.name),
        Arity::Rest => format!("…{}", param.name),
    }
}

impl V5Builtin {
    fn library(&self) -> Option<&'static Builtin> {
        lookup_builtin(self.spelling.canonical)
    }

    /// `Text.upper(text)`, its parameters in the order v5 writes them.
    pub fn signature(&self) -> String {
        let Some(builtin) = self.library() else { return format!("{}(…)", self.name) };
        let mut params: Vec<String> = builtin.params.iter().map(param_text).collect();
        match self.spelling.shape {
            Shape::SettingsLast => {
                if let Some(at) = builtin.params.iter().position(|p| p.ty == ParamType::Options) {
                    let settings = params.remove(at);
                    params.push(settings);
                }
            }
            Shape::ReduceOrder if params.len() >= 3 => params.swap(1, 2),
            _ => {}
        }
        format!("{}({})", self.name, params.join(", "))
    }

    /// What it does: the reference's paragraph under its heading, else what it
    /// returns (nothing when that depends on its arguments).
    pub fn doc(&self) -> Option<String> {
        use movement_checker::types::stdlib::Returns;
        if let Some(line) = reference_line(self.name) {
            return Some(line.to_string());
        }
        let returns = match self.library()?.returns {
            Returns::Text => "Returns text.",
            Returns::Number => "Returns a number.",
            Returns::Boolean => "Returns true or false.",
            Returns::Date => "Returns a date.",
            Returns::Datetime => "Returns a date and time.",
            Returns::File => "Returns a file.",
            Returns::ListOfText => "Returns a list of text.",
            Returns::MaybeAbsentText => "Returns text, or null.",
            Returns::MaybeAbsentDate => "Returns a date, or null.",
            Returns::Never => "Fails the run here.",
            Returns::Derived => return None,
        };
        Some(returns.to_string())
    }
}

const REFERENCE: &str = include_str!("builtins.md");

/// The paragraph under the reference's `### name` heading: the signature, what
/// it gives back and what it does, in one line.
pub fn reference_line(name: &str) -> Option<&'static str> {
    let heading = format!("\n### {name}\n");
    let body = &REFERENCE[REFERENCE.find(&heading)? + heading.len()..];
    body.trim_start_matches('\n').split("\n\n").next().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#'))
}

#[cfg(test)]
mod tests {
    /// A heading renamed in the reference would quietly drop a built-in's
    /// card back to what it returns. `fail` and `callback` are explained in
    /// other chapters (`crate::docs::builtin_page`).
    #[test]
    fn every_built_in_has_a_line_in_the_reference() {
        let missing: Vec<&str> = super::v5_builtins().iter().map(|b| b.name).filter(|name| super::reference_line(name).is_none()).collect();
        assert_eq!(missing, vec!["fail", "callback"]);
    }
}
