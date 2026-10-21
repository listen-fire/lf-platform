//! `check.compatible` (the JavaScript host's answer to the engine's request
//! of that name): does a system's record type carry everything a file's node
//! declaration declares, by the checker's own comparator (`surface_misfit`)?
//! The declaration is folded with every `extends` of its file, each link's
//! field types resolved by that file's `type` declarations, so it is compared
//! against the structure the checker held the program to.

use indexmap::IndexMap;
use movement_parser::ast::{ShapeDeclaration, Statement};
use movement_parser::catalog::types::{InstanceSchema, SchemaFieldType};
use movement_parser::util::form::{form_of_text, read_json_text};
use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::types::declared::{MisfitOptions, inherit_declaration, inherit_schema, schema_surface, shape_to_schema, surface_misfit_from};

/// The request, as the host forwards the engine's.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    /// The file that declares `declaration` (the run's source, or a library's).
    source: String,
    language_version: u32,
    declaration: String,
    schema: InstanceSchema,
    record_type: String,
    /// The declared edges from the declaration's root to the node compared.
    #[serde(default)]
    path: Vec<String>,
}

/// `{fits}`, `{undescribed: true}` when the schema enumerates nothing at the
/// record type, or `{error: {message}}` for a request that names no
/// declaration, a path the declaration does not have, or a source that does
/// not parse.
pub fn compatible_json(request_json: &str) -> Json {
    let request: Request = match serde_json::from_str(&read_json_text(request_json)) {
        Ok(request) => request,
        Err(e) => return refusal(format!("check.compatible: the request does not read: {e}")),
    };
    match compatible(&request) {
        Ok(answer) => answer,
        Err(message) => refusal(message),
    }
}

fn refusal(message: String) -> Json {
    json!({ "error": { "message": message } })
}

fn compatible(request: &Request) -> Result<Json, String> {
    let program = movement_parser::stmt::parse_program(&form_of_text(&request.source), request.language_version, false)
        .map_err(|e| format!("{} (line {}, col {})", e.message, e.loc.line, e.loc.col))?;
    // Asked in the order the TypeScript shim asked it: what the record offers
    // first, then the declaration.
    let Some(supplied) = schema_surface(&request.schema, &request.record_type) else {
        return Ok(json!({ "undescribed": true }));
    };
    let declarations: IndexMap<&str, &ShapeDeclaration> = program
        .statements
        .iter()
        .filter_map(|s| match s {
            Statement::Shape(shape) => Some((shape.name.as_str(), shape)),
            _ => None,
        })
        .collect();
    let mut chain: Vec<&ShapeDeclaration> = Vec::new();
    let mut at = declarations.get(request.declaration.as_str()).copied();
    while let Some(declaration) = at {
        if chain.iter().any(|seen| std::ptr::eq(*seen, declaration)) {
            return Err(format!("'{}' extends itself", request.declaration));
        }
        chain.push(declaration);
        at = declaration.extends.as_ref().and_then(|base| declarations.get(base.name.as_str()).copied());
    }
    if chain.is_empty() {
        return Err(format!("check.compatible: '{}' is not a node declaration of the file", request.declaration));
    }
    let program_json = serde_json::to_value(&program).map_err(|e| e.to_string())?;
    let types = movement_parser::catalog::helpers::declared_types_in(&program_json)?;
    let (declaration, schema) = folded(&chain, &types);
    let Some((position, seen)) = declared_position_at(&schema, &declaration.name, &request.path)? else {
        return Ok(json!({ "fits": true }));
    };
    let options = MisfitOptions { absent_may_be_missing: false, version: request.language_version };
    Ok(json!({ "fits": surface_misfit_from(Some(&supplied), &schema, &position, options, seen).is_none() }))
}

/// The fold of a chain written declaration first, its bases after it.
fn folded(chain: &[&ShapeDeclaration], types: &IndexMap<String, SchemaFieldType>) -> (ShapeDeclaration, InstanceSchema) {
    let resolve = |name: &str| types.get(name).cloned();
    let mut resolved: Option<(ShapeDeclaration, InstanceSchema)> = None;
    for link in chain.iter().rev() {
        let own = shape_to_schema(link, &resolve);
        resolved = Some(match resolved {
            None => ((*link).clone(), own),
            Some((base, base_schema)) => (inherit_declaration(link, &base), inherit_schema(&own, &link.name, &base.name, &base_schema)),
        });
    }
    resolved.unwrap_or_else(|| unreachable!("an extends chain holds at least its own declaration"))
}

/// The declared position `path`'s edges reach from `root`, and the positions
/// the comparator has seen on its way there (each edge's target); `None`
/// where it would not have compared that far (an edge to a position it has
/// seen), which fits.
fn declared_position_at(schema: &InstanceSchema, root: &str, path: &[String]) -> Result<Option<(String, Vec<String>)>, String> {
    let mut position = root.to_string();
    let mut seen: Vec<String> = Vec::new();
    for name in path {
        let Some(edge) = schema.positions.get(&position).and_then(|p| p.edges.get(name)) else {
            return Err(format!("check.compatible: '{position}' declares no node '{name}'"));
        };
        if seen.contains(&edge.target) {
            return Ok(None);
        }
        seen.push(edge.target.clone());
        position = edge.target.clone();
    }
    Ok(Some((position, seen)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::compatible_json;

    const SOURCE: &str = "type Stage = <\"A\" | \"B\">\nnode Base { name: <text> }\nnode Lead extends Base { stage: <Stage> }";

    fn ask(schema: serde_json::Value, declaration: &str) -> serde_json::Value {
        let request = json!({ "source": SOURCE, "languageVersion": 5, "declaration": declaration, "schema": schema, "recordType": "Person" });
        compatible_json(&request.to_string())
    }

    fn person(properties: serde_json::Value) -> serde_json::Value {
        json!({ "positions": { "Person": { "properties": properties, "edges": {} } }, "collections": {} })
    }

    #[test]
    fn a_record_carrying_the_folded_declaration_fits() {
        let stage = json!({ "kind": "enum", "options": ["A", "B"] });
        assert_eq!(ask(person(json!({ "name": "text", "stage": stage })), "Lead"), json!({ "fits": true }));
    }

    #[test]
    fn a_record_lacking_a_base_field_does_not() {
        assert_eq!(ask(person(json!({ "stage": "text" })), "Lead"), json!({ "fits": false }));
    }

    #[test]
    fn a_record_type_the_schema_does_not_enumerate_is_undescribed() {
        assert_eq!(ask(json!({ "positions": {}, "collections": {} }), "Lead"), json!({ "undescribed": true }));
    }

    #[test]
    fn a_name_the_file_does_not_declare_is_refused() {
        assert_eq!(
            ask(person(json!({})), "Ghost"),
            json!({ "error": { "message": "check.compatible: 'Ghost' is not a node declaration of the file" } })
        );
    }
}
