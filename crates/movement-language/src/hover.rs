//! Hover: the name under the cursor, what it is (in its adapter's or author's
//! own words first, where they wrote some, then what the structure says), and
//! its page in the versioned docs.
//!
//! The wording is hover's own: `describe_position` and `SymbolKind::describe`
//! word error messages, so they stay as they are and are used here only where
//! nothing plainer exists.

use movement_checker::query::Analysis;
use movement_checker::scope::{Symbol, SymbolKind};
use movement_checker::types::field::{Ty, describe_field_type, is_maybe_absent};
use movement_checker::types::position::{Position, describe_position, display_name_of, position_schema_of_ref};
use movement_parser::ast::Loc;
use movement_parser::catalog::types::{AdapterSnapshot, InstanceSchema, PluginOutput, PluginSpec, PositionSchema};

use crate::docs::{FIELD, WALK, builtin_page, page_of};
use crate::text::{Pos, Range, Text, in_comment, inside_backticks, is_word_char, loc_of, trailing_word, utf16_len, written_name};
use crate::{Service, builtins, docs_url, walk};

#[derive(Debug, Clone)]
pub struct Hover {
    /// Markdown.
    pub contents: String,
    pub range: Range,
}

/// The name under a position, and what is written just before it.
pub struct Word {
    pub name: String,
    pub range: Range,
    /// Read off a receiver: `x.name`, ``x.`name` ``.
    pub after_dot: bool,
    /// The document's text before the `.`, or before the hop's `-[`.
    pub receiver: String,
    /// The edge of a hop: `-[name`, `-[a:name`.
    pub in_hop: bool,
}

pub fn word_at(text: &Text<'_>, pos: Pos) -> Option<Word> {
    let line = text.line(pos.line);
    let before = text.line_before(pos);
    let after = text.line_after(pos);
    let (name, outer_start, end) = if inside_backticks(before) {
        let open = before.rfind('`')?;
        let close = after.find('`')?;
        (format!("{}{}", &before[open + 1..], &after[..close]), open, before.len() + close + 1)
    } else {
        let left = trailing_word(before);
        let right: &str = &after[..after.find(|c: char| !is_word_char(c)).unwrap_or(after.len())];
        if left.is_empty() && right.is_empty() {
            // On a backticked name's opening backtick.
            let rest = after.strip_prefix('`')?;
            let close = rest.find('`')?;
            (rest[..close].to_string(), before.len(), before.len() + close + 2)
        } else {
            (format!("{left}{right}"), before.len() - left.len(), before.len() + right.len())
        }
    };
    let prefix = &line[..outer_start];
    let above = text.before(Pos { line: pos.line, character: 0 });
    let after_dot = prefix.ends_with('.');
    let hop_head = prefix.strip_suffix(':').map(|p| p.strip_suffix(trailing_word(p)).unwrap_or(p)).unwrap_or(prefix);
    let in_hop = !after_dot && hop_head.ends_with("-[") && (prefix.ends_with(':') || prefix.ends_with("-["));
    let receiver = if after_dot {
        format!("{above}{}", &prefix[..prefix.len() - 1])
    } else if in_hop {
        format!("{above}{}", &hop_head[..hop_head.len() - 2])
    } else {
        String::new()
    };
    let start = Pos { line: pos.line, character: utf16_len(&line[..outer_start]) as u32 };
    let end = Pos { line: pos.line, character: utf16_len(&line[..end.min(line.len())]) as u32 };
    Some(Word { name, range: Range { start, end }, after_dot, receiver, in_hop })
}

/// A header in a code block, a paragraph per line, and the docs link.
fn card(header: &str, lines: &[String], (page, anchor): (&str, &str)) -> String {
    let body: String = lines.iter().filter(|l| !l.is_empty()).map(|l| format!("{l}\n\n")).collect();
    format!("```movement\n{header}\n```\n{body}[Docs]({})", docs_url(page, anchor))
}

pub fn builtin_card(name: &str) -> Option<String> {
    let builtin = builtins::by_name(name)?;
    let (page, anchor) = builtin_page(builtin.name);
    Some(card(&builtin.signature(), &builtin.doc().into_iter().collect::<Vec<_>>(), (page, &anchor)))
}

/// Long lists stop here, then say how many more there are.
const LISTED: usize = 8;

fn listed(names: impl IntoIterator<Item = String>) -> Option<String> {
    let names: Vec<String> = names.into_iter().collect();
    if names.is_empty() {
        return None;
    }
    let shown = names[..names.len().min(LISTED)].join(", ");
    Some(match names.len().saturating_sub(LISTED) {
        0 => shown,
        more => format!("{shown} and {more} more"),
    })
}

/// "Fields: Name, Description (all text)", or each with its type when they differ.
fn fields_line(position: &Position) -> Option<String> {
    let fields = walk::fields(position);
    let first = fields.first()?.1.clone();
    if fields.iter().all(|(_, ty)| *ty == first) {
        let names = listed(fields.iter().map(|(name, _)| written_name(name)))?;
        return Some(match (&first, fields.len()) {
            (Some(ty), 1) => format!("Fields: {names} ({ty})"),
            (Some(ty), _) => format!("Fields: {names} (all {ty})"),
            (None, _) => format!("Fields: {names}"),
        });
    }
    let typed = fields.iter().map(|(name, ty)| match ty {
        Some(ty) => format!("{}: {ty}", written_name(name)),
        None => written_name(name),
    });
    Some(format!("Fields: {}", listed(typed)?))
}

/// What a landing is called in a hover: its record type's name, or the checker's words for it.
fn landing_name(position: &Position) -> String {
    match walk::strip(position) {
        Position::Position(p) => display_name_of(&p.instance, &p.position),
        Position::Handle(h) => h.position.as_ref().map_or_else(|| describe_position(position), |name| display_name_of(&h.instance, name)),
        other => describe_position(other),
    }
}

/// "Walk on: Comments → Comment".
fn walk_on_line(position: &Position, version: u32) -> Option<String> {
    let edges = walk::edge_schemas(position, version).into_iter().map(|edge| match &edge.landing {
        Some(landing) => format!("{} → {}", written_name(&edge.name), landing_name(landing)),
        None => written_name(&edge.name),
    });
    Some(format!("Walk on: {}", listed(edges)?))
}

/// The adapter's description of the record type a position holds.
fn record_description(position: &Position) -> Option<String> {
    position_schema_of_ref(walk::strip(position))?.description.clone()
}

fn article(noun: &str) -> &'static str {
    if noun.starts_with(['A', 'E', 'I', 'O', 'U', 'a', 'e', 'i', 'o', 'u']) { "an" } else { "a" }
}

/// The record type and the connection a position is a record of: (`Company`, `crm`).
fn record_of(position: &Position) -> Option<(String, String)> {
    match walk::strip(position) {
        Position::Position(p) => Some((display_name_of(&p.instance, &p.position), p.instance.name.clone())),
        Position::Handle(h) => Some((display_name_of(&h.instance, h.position.as_ref()?), h.instance.name.clone())),
        _ => None,
    }
}

/// A type as a hover header writes it: `Company (from crm)` for a record.
fn type_words(position: Option<&Position>, ty: Option<String>) -> Option<String> {
    if let Some((record, connection)) = position.and_then(record_of) {
        let maybe = if matches!(position, Some(Position::MaybeEmpty(_))) { ", which may be empty" } else { "" };
        return Some(format!("{record} (from {connection}{maybe})"));
    }
    ty
}

fn contains(outer: &movement_parser::ast::Span, at: Loc) -> bool {
    (outer.start.line, outer.start.col) <= (at.line, at.col) && (at.line, at.col) <= (outer.end.line, outer.end.col)
}

/// "Holds: Company, Comment": the record types an instance schema names.
fn holds_line(schema: &InstanceSchema) -> Option<String> {
    let names = schema.positions.iter().map(|(key, p)| written_name(p.display_name.as_deref().unwrap_or(key)));
    Some(format!("Holds: {}", listed(names)?))
}

/// "Fires: company.created, company.updated": the events a listen may choose.
fn fires_line(adapter: &AdapterSnapshot) -> Option<String> {
    let events = adapter.spec.trigger_config_options.as_ref()?.get("events")?;
    Some(format!("Fires: {}", listed(events.iter().cloned())?))
}

/// "Listen settings: schedule (required), timezone".
fn listen_settings_line(adapter: &AdapterSnapshot) -> Option<String> {
    let required = adapter.spec.trigger_config_required.clone().unwrap_or_default();
    let keys = adapter.spec.trigger_config.as_ref()?.iter().filter(|k| *k != "pollIntervalSeconds").map(|k| {
        if required.contains(k) { format!("{k} (required)") } else { k.clone() }
    });
    Some(format!("Listen settings: {}", listed(keys)?))
}

/// "Gives: Tick (Fired at, Schedule)": what a listen on it hands the function it fires.
fn gives_line(schema: &InstanceSchema) -> Option<String> {
    let mut names: Vec<&str> = schema.event_positions.iter().flatten().map(|e| e.position.as_str()).collect();
    if names.is_empty() {
        names.extend(schema.event_position.as_deref());
    }
    let given = names.into_iter().map(|name| {
        let fields = schema.positions.get(name).and_then(|p| listed(p.properties.keys().map(|f| written_name(f))));
        let shown = written_name(schema.positions.get(name).and_then(|p| p.display_name.as_deref()).unwrap_or(name));
        match fields {
            Some(fields) => format!("{shown} ({fields})"),
            None => shown,
        }
    });
    Some(format!("Gives: {}", listed(given)?))
}

/// Any one schema an adapter's catalog entry holds (they share their record types).
fn any_schema(adapter: &AdapterSnapshot) -> Option<&InstanceSchema> {
    adapter.schemas.values().next()
}

/// A plugin's call as a signature: `reverse(text: text) → text`.
fn plugin_signature(written: &str, spec: &PluginSpec) -> String {
    let required = spec.required_args.clone().unwrap_or_default();
    let params: Vec<String> = spec
        .args
        .iter()
        .map(|arg| {
            let optional = if required.contains(arg) || spec.required_args.is_none() { "" } else { "?" };
            match spec.arg_types.as_ref().and_then(|t| t.get(arg)) {
                Some(ty) => format!("{arg}{optional}: {}", describe_field_type(&Ty::from_schema(ty))),
                None => format!("{arg}{optional}"),
            }
        })
        .collect();
    let gives = match &spec.output {
        Some(PluginOutput::Value { type_ }) => format!(" → {}", describe_field_type(&Ty::from_schema(type_))),
        Some(PluginOutput::Record { .. }) => " → a record".to_string(),
        Some(PluginOutput::Records { .. }) => " → records".to_string(),
        None => String::new(),
    };
    format!("{written}({}){gives}", params.join(", "))
}

fn plugin_card(written: &str, spec: &PluginSpec) -> String {
    let mut lines: Vec<String> = spec.description.iter().cloned().collect();
    if let Some(package) = &spec.package {
        lines.push(format!("From plugin package {package}."));
    }
    if spec.priced() {
        lines.push("May cost money.".into());
    }
    if spec.effects.as_ref().and_then(|e| e.ai) == Some(true) {
        lines.push("Calls an AI model.".into());
    }
    card(&plugin_signature(written, spec), &lines, page_of(SymbolKind::Plugin))
}

/// The catalog's plugin a symbol imports: by its key, or by the name it is spelled.
fn plugin_of<'s>(service: &'s Service, symbol: &Symbol) -> Option<&'s PluginSpec> {
    let imported = symbol.imported_name.as_deref().unwrap_or(&symbol.name);
    service.catalog.plugins.get(imported).or_else(|| service.catalog.plugins.values().find(|spec| spec.name.as_deref() == Some(imported)))
}

/// A package imported from plugins binds only its members (`inbox.pending`):
/// its own name's card lists them.
fn package_card(service: &Service, analysis: &Analysis, at: Loc, local: &str) -> Option<String> {
    let prefix = format!("{local}.");
    let members: Vec<(&Symbol, &PluginSpec)> = analysis
        .visible(at)
        .into_iter()
        .filter(|v| v.symbol.kind == SymbolKind::Plugin && v.symbol.name.starts_with(&prefix))
        .filter_map(|v| Some((v.symbol, plugin_of(service, v.symbol)?)))
        .collect();
    let package = members.iter().find_map(|(_, spec)| spec.package.clone())?;
    let mut lines = vec![format!("Plugin package {package}.")];
    lines.extend(members.iter().map(|(symbol, spec)| format!("`{}`", plugin_signature(&symbol.name[prefix.len()..], spec))));
    Some(card(local, &lines, page_of(SymbolKind::Plugin)))
}

/// `listen to manual`, for each listen in the file that fires `name`.
fn listens_firing(text: &Text<'_>, name: &str) -> Vec<String> {
    (0..text.line_count() as u32)
        .map(|n| text.line(n).trim())
        .filter(|line| line.starts_with("listen to "))
        .filter_map(|line| {
            let (head, fired) = line.rsplit_once(" fire ")?;
            (fired.trim() == name).then(|| head.trim().to_string())
        })
        .collect()
}

/// The function a parameter belongs to, and whether it is that function's own
/// (written in its first line) rather than an inline function's inside it.
fn parameter_of<'a>(analysis: &'a Analysis, symbol: &Symbol) -> Option<(&'a Symbol, bool)> {
    let at = symbol.span.start;
    let owner = analysis
        .visible(at)
        .into_iter()
        .filter(|v| v.symbol.kind == SymbolKind::Movement && !v.symbol.unit && contains(&v.symbol.span, at))
        .min_by_key(|v| (v.symbol.span.end.line - v.symbol.span.start.line, v.symbol.span.end.col))?
        .symbol;
    Some((owner, at.line == owner.span.start.line))
}

fn symbol_card(service: &Service, analysis: &Analysis, text: &Text<'_>, id: movement_checker::scope::SymbolId) -> String {
    let version = service.language_version;
    let symbol = analysis.symbol(id);
    let position = analysis.position_of(id);
    let ty = analysis.type_text(id);
    let name = &symbol.name;
    let named_type = |ty: Option<String>| match ty {
        Some(ty) => format!("{name}: {ty}"),
        None => name.clone(),
    };
    let record_lines = |position: Option<&Position>| -> Vec<String> {
        let Some(position) = position else { return Vec::new() };
        [fields_line(position), walk_on_line(position, version)].into_iter().flatten().collect()
    };
    let docs = page_of(symbol.kind);
    match symbol.kind {
        SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type if !symbol.unit => {
            let imported = analysis.imported(name);
            let header = match imported {
                Some(_) => ty.clone().unwrap_or_else(|| name.clone()),
                None => {
                    let declared = text.slice(&symbol.span);
                    let first = declared.lines().next().unwrap_or(name);
                    first.split('{').next().unwrap_or(first).trim().to_string()
                }
            };
            let mut lines = Vec::new();
            if let Some(imported) = imported {
                lines.push(format!("Imported from {}.", imported.file));
            } else if symbol.kind == SymbolKind::Movement {
                let listens = listens_firing(text, name);
                lines.push(match listens.as_slice() {
                    [] => "No listen fires it; it runs when it is called.".to_string(),
                    _ => format!("Runs when: {}.", listens.iter().map(|l| format!("`{l}`")).collect::<Vec<_>>().join(" or ")),
                });
            } else {
                lines.push(format!("Declared on line {}.", symbol.span.start.line));
                lines.extend(record_lines(position));
            }
            card(&header, &lines, docs)
        }
        SymbolKind::Instance if symbol.unit => {
            let adapter = service.catalog.adapters.get(name);
            let mut lines = vec!["Built into lf; no import needed.".to_string()];
            lines.extend(adapter.and_then(listen_settings_line));
            lines.extend(adapter.and_then(any_schema).and_then(gives_line));
            card(name, &lines, docs)
        }
        SymbolKind::Instance => {
            let instance = symbol.instance.as_deref();
            let adapter_name = instance.and_then(|i| i.adapter.clone()).or_else(|| symbol.adapter.clone());
            let adapter = adapter_name.as_deref().and_then(|a| service.catalog.adapters.get(a));
            let header = match &adapter_name {
                Some(adapter) => format!("{name} = connect {adapter}"),
                None => name.clone(),
            };
            let mut lines: Vec<String> = adapter.and_then(|a| a.spec.description.clone()).into_iter().collect();
            if let Some(adapter_name) = &adapter_name {
                lines.push(match instance.and_then(|i| i.credential.as_deref()) {
                    Some(credential) => format!("Your {adapter_name} account, signed in with the credential {credential}."),
                    None => format!("A connection to {adapter_name}."),
                });
            }
            lines.extend(instance.and_then(|i| i.schema.as_ref()).or_else(|| adapter.and_then(any_schema)).and_then(holds_line));
            lines.extend(adapter.and_then(fires_line));
            card(&header, &lines, docs)
        }
        SymbolKind::Adapter => {
            let key = symbol.imported_name.as_deref().unwrap_or(name);
            let adapter = service.catalog.adapters.get(key);
            let mut lines: Vec<String> = adapter.and_then(|a| a.spec.description.clone()).into_iter().collect();
            let credentialed = adapter.is_some_and(|a| a.spec.construction_args.iter().any(|arg| arg.kind == movement_parser::catalog::types::ArgKind::Credential));
            let using = if credentialed || adapter.is_none() { " using <credential>" } else { "" };
            lines.push(format!("An adapter. Use it with `connect {name}{using}`."));
            lines.extend(adapter.and_then(any_schema).and_then(holds_line));
            lines.extend(adapter.and_then(fires_line));
            card(name, &lines, docs)
        }
        SymbolKind::Credential => {
            let key = symbol.imported_name.as_deref().unwrap_or(name);
            let adapters = service.catalog.credentials.get(key).map(|c| match c {
                movement_parser::catalog::types::SnapshotCredential::Adapters(spec) => spec.adapters.clone(),
                movement_parser::catalog::types::SnapshotCredential::Adapter(legacy) => vec![legacy.adapter.clone()],
            });
            let what = match adapters.as_deref() {
                Some([]) | None => "A sign-in".to_string(),
                Some(adapters) => format!("Sign-in for {}", adapters.join(" or ")),
            };
            let line = format!("{what}. lf reads it from secrets.yaml or the environment when the movement runs; it never appears in the file.");
            card(name, &[line], docs)
        }
        SymbolKind::Plugin => match plugin_of(service, symbol) {
            Some(spec) => plugin_card(name, spec),
            None => card(name, &["A plugin the catalog does not describe.".to_string()], docs),
        },
        SymbolKind::Param => {
            let mut lines: Vec<String> = position.and_then(record_description).into_iter().collect();
            lines.push(match parameter_of(analysis, symbol) {
                Some((owner, true)) => format!("Parameter of {}.", owner.name),
                Some((owner, false)) => format!("Parameter of a function written inside {}.", owner.name),
                None => "A parameter.".to_string(),
            });
            lines.extend(record_lines(position));
            card(&named_type(type_words(position, ty)), &lines, docs)
        }
        SymbolKind::Binding => {
            let may_be_empty = matches!(position, Some(Position::MaybeEmpty(_))) || is_maybe_absent(symbol.types.field.as_ref());
            let set = format!("Set on line {}.", symbol.span.start.line);
            let mut lines = vec![if may_be_empty { format!("{set} It may be empty, so check it before use.") } else { set }];
            lines.extend(record_lines(position));
            card(&named_type(type_words(position, ty)), &lines, docs)
        }
        SymbolKind::Alias => {
            let declared = text.line(symbol.span.start.line.saturating_sub(1) as u32);
            let edge = declared.find(&format!("-[{name}:")).and_then(|at| walk::hop_edge(&declared[at + 2..]));
            let reached = match edge {
                Some(edge) => format!("Each {} record the walk on line {} reaches.", written_name(&edge), symbol.span.start.line),
                None => format!("Each record the walk on line {} reaches.", symbol.span.start.line),
            };
            let mut lines = vec![reached];
            lines.extend(record_lines(position));
            card(&named_type(type_words(position, ty)), &lines, docs)
        }
        SymbolKind::FileImport => {
            let line = match analysis.imported(name) {
                Some(imported) => format!("Imported from {}.", imported.file),
                None => "Imported from another file.".to_string(),
            };
            card(&named_type(ty), &[line], docs)
        }
        // A file's own node or type that is also a host unit's name: the unit's words.
        SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type => card(&named_type(ty), &[format!("Declared on line {}.", symbol.span.start.line)], docs),
    }
}

pub fn hover(service: &Service, source: &str, pos: Pos) -> Option<Hover> {
    let text = Text::new(source);
    if in_comment(text.line_before(pos)) {
        return None;
    }
    let word = word_at(&text, pos)?;
    let at = loc_of(pos);
    let version = service.language_version;
    let finish = |contents: String| Some(Hover { contents, range: word.range });
    if word.after_dot {
        let receiver_name = walk::trailing_name(word.receiver.trim_end()).unwrap_or_default();
        let analyzed = service.analyze(source, Some(pos.line));
        let resolves = analyzed.as_ref().is_some_and(|a| a.analysis.resolve(at, &receiver_name).is_some());
        if !resolves && builtins::namespaces().contains(&receiver_name.as_str()) {
            return finish(builtin_card(&format!("{receiver_name}.{}", word.name))?);
        }
        let analysis = &analyzed?.analysis;
        if let Some(position) = walk::receiver(analysis, &word.receiver, at, version) {
            return finish(field_card(&position, &word.name, &receiver_name));
        }
        // A package's member, bound as `web.fetchUrl`.
        let id = analysis.resolve(at, &format!("{receiver_name}.{}", word.name))?;
        return finish(symbol_card(service, analysis, &text, id));
    }
    let analyzed = service.analyze(source, Some(pos.line));
    if word.in_hop {
        let analysis = &analyzed?.analysis;
        let position = walk::receiver(analysis, &word.receiver, at, version)?;
        let receiver_name = walk::trailing_name(word.receiver.trim_end()).unwrap_or_default();
        return finish(edge_card(&position, &word.name, &receiver_name, version)?);
    }
    if let Some(analyzed) = &analyzed {
        let analysis = &analyzed.analysis;
        if let Some(id) = analysis.resolve(at, &word.name) {
            return finish(symbol_card(service, analysis, &text, id));
        }
        if let Some(package) = package_card(service, analysis, at, &word.name) {
            return finish(package);
        }
    }
    finish(builtin_card(&word.name)?)
}

/// `company.Name`: the field's type, the adapter's words for it, and the record it is read off.
fn field_card(position: &Position, field: &str, receiver_name: &str) -> String {
    let ty = walk::field_type(position, field).unwrap_or_else(|| "not a field it has".into());
    let schema: Option<std::borrow::Cow<'_, PositionSchema>> = position_schema_of_ref(walk::strip(position));
    let mut lines: Vec<String> = schema.as_ref().and_then(|s| s.field_docs.as_ref()?.get(field).cloned()).into_iter().collect();
    lines.push(match record_of(position) {
        Some((record, connection)) => format!("On {} {record} record from {connection}.", article(&record)),
        None => format!("On {}.", describe_position(walk::strip(position))),
    });
    if matches!(position, Position::MaybeEmpty(_)) && !receiver_name.is_empty() {
        lines.push(format!("Absent when `{receiver_name}` holds nothing."));
    }
    card(&format!("{}: {ty}", written_name(field)), &lines, FIELD)
}

/// `crm-[:Company]->`: where the edge lands, the adapter's words for it, and what is there.
fn edge_card(position: &Position, edge: &str, receiver_name: &str, version: u32) -> Option<String> {
    let found = walk::edge_schemas(position, version).into_iter().find(|e| e.name == edge)?;
    let hop = format!("{receiver_name}-[:{}]->", written_name(edge));
    let Some(landing) = &found.landing else {
        return Some(card(&hop, &["Where it lands is not described, so what is read there is not checked.".to_string()], WALK));
    };
    let mut lines: Vec<String> = found.schema.description.clone().or_else(|| record_description(landing)).into_iter().collect();
    let writable = if found.schema.writable == Some(true) { " You can write new ones here." } else { "" };
    lines.push(match record_of(landing) {
        Some((record, connection)) => format!("{record} records in {connection}.{writable}"),
        None => format!("Lands on {}.{writable}", describe_position(landing)),
    });
    lines.extend(fields_line(landing));
    lines.extend(walk_on_line(landing, version));
    Some(card(&format!("{hop} {}", landing_name(landing)), &lines, WALK))
}
