//! Two crate modules one host serves: `notes`, an adapter keeping notes in
//! memory, and `shout`, a plugin package (`@acme/shout`) with one plugin.
//!
//! One record type, `Note { Title, Body }`, and one event a listen may
//! choose, `note.created`.

use std::sync::{Arc, Mutex};

use module_kit::*;

const NOTE: &str = "Note";
const NOTE_CREATED: &str = "note.created";

/// The notes adapter. Clones share their notes, so whoever made it can see
/// what a movement wrote.
#[derive(Clone, Default)]
pub struct Notes {
    notes: Arc<Mutex<Vec<(String, Obj)>>>,
}

impl Notes {
    /// Every note, by id, in the order written.
    pub fn notes(&self) -> Vec<(String, Obj)> {
        self.notes.lock().expect("notes").clone()
    }

    fn written(id: String, fields: Obj) -> Written {
        Written { record: RecordRef { adapter_type: "notes".into(), external_id: id, record_type: NOTE.into(), data: fields, url: None }, events: None }
    }
}

impl Adapter for Notes {
    fn manifest(&self) -> AdapterManifest {
        AdapterManifest::new("notes")
            .triggers(["webhook"])
            .optional(["listEventTypes"])
            .declare("subscribableEvents", Js::strings([NOTE_CREATED]))
    }

    async fn list_entry_points(&self, _: &Ctx) -> Answer<Vec<EntryPoint>> {
        Ok(vec![EntryPoint {
            type_id: NOTE.into(),
            display_name: NOTE.into(),
            writable: true,
            readable: false,
            fires: Some(true),
            description: Some("A note. A listen is delivered each one somebody writes.".into()),
            rest: Obj::new(),
        }])
    }

    async fn describe(&self, _: &Ctx, request: Describe) -> Answer<Option<TypeDescriptor>> {
        Ok((request.type_id == NOTE).then(|| TypeDescriptor {
            type_id: NOTE.into(),
            display_name: NOTE.into(),
            fields: vec![Field::new("Title", "string", true, true), Field::new("Body", "string", true, false)],
            references: vec![],
            deletable: None,
            rest: Obj::new(),
        }))
    }

    async fn create_record(&self, _: &Ctx, request: CreateRecord) -> Answer<Written> {
        if request.record_type != NOTE {
            return Err(ModuleError::bad_request(format!("createRecord: no type {}", request.record_type)));
        }
        let mut notes = self.notes.lock().map_err(ModuleError::adapter)?;
        let id = format!("note-{}", notes.len() + 1);
        notes.push((id.clone(), request.fields.clone()));
        Ok(Notes::written(id, request.fields))
    }

    async fn update_record(&self, _: &Ctx, request: UpdateRecord) -> Answer<Option<Updated>> {
        let mut notes = self.notes.lock().map_err(ModuleError::adapter)?;
        let Some((_, fields)) = notes.iter_mut().find(|(id, _)| *id == request.external_id) else { return Ok(None) };
        fields.extend(request.fields);
        Ok(Some(Updated { written: Notes::written(request.external_id, fields.clone()), association: Some("none".into()) }))
    }

    async fn optional(&self, _: &Ctx, method: &str, _: Js) -> Answer<Js> {
        match method {
            "listEventTypes" => Ok(Js::Arr(vec![Js::Obj(obj! { "tag" => Js::str(NOTE_CREATED), "positionType" => Js::str(NOTE) })])),
            other => Err(ModuleError::not_implemented(other)),
        }
    }
}

/// `@acme/shout`: `shout.shoutOut(text)` is the text in capitals.
pub struct Shout;

impl Plugins for Shout {
    fn package(&self) -> PluginPackage {
        let spec = Js::parse(
            br#"{ "args": ["text"], "priced": false, "argTypes": { "text": "text" }, "requiredArgs": ["text"],
                  "effects": {}, "output": { "kind": "value", "type": "text" } }"#,
        )
        .expect("the spec is JSON");
        PluginPackage {
            module: "shout".into(),
            package: "@acme/shout".into(),
            plugins: vec![PluginSpec { name: "shout-out".into(), spec }],
            declarations: Obj::new(),
        }
    }

    async fn invoke(&self, _: &Ctx, call: PluginCall) -> Answer<PluginAnswer> {
        let text = call.config.get("text").and_then(Js::as_str).ok_or_else(|| ModuleError::bad_request("shout-out: text is required"))?;
        Ok(PluginAnswer { text: Some(text.to_uppercase()), ..PluginAnswer::default() })
    }
}

/// The host this example's binary runs: both modules, at `/notes` and `/shout`.
pub fn host(notes: Notes) -> Host {
    Host::new().adapter(notes).plugins(Shout)
}
