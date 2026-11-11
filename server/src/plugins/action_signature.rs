use std::collections::HashSet;

/// Human-readable shape of a JSON Schema's arguments, compiled once per Action.
pub(super) struct Signature {
    pub(super) text: String,
    pub(super) truncated: bool,
}

pub(super) const SIGNATURE_MAX_LENGTH: usize = 1_200;
const SIGNATURE_MAX_DEPTH: usize = 6;

pub(super) fn action_signature(schema: &serde_json::Value) -> Signature {
    let mut formatter = SignatureFormatter {
        root: schema,
        references: Vec::new(),
        truncated: false,
    };
    let rendered = formatter.render(schema, 0);
    Signature {
        text: rendered.text,
        truncated: formatter.truncated,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    Atom,
    Object,
    Union,
    Intersection,
}

/// Objects retain their body separately from the delimiters used when nested.
/// Shape, rather than punctuation in literals, determines array precedence.
#[derive(PartialEq, Eq)]
struct Rendered {
    text: String,
    shape: Shape,
}

impl Rendered {
    fn atom(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            shape: Shape::Atom,
        }
    }

    fn join(parts: Vec<Self>, shape: Shape, separator: &str) -> Self {
        if parts.len() == 1 {
            return parts.into_iter().next().expect("one part");
        }
        Self {
            text: parts
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(separator),
            shape,
        }
    }
}

impl std::fmt::Display for Rendered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.shape {
            Shape::Object => write!(f, "{{ {} }}", self.text),
            _ => f.write_str(&self.text),
        }
    }
}

/// Field contributions collected from one intersection.
#[derive(Default)]
struct Merged {
    properties: serde_json::Map<String, serde_json::Value>,
    required: Vec<String>,
    additional: Option<serde_json::Value>,
}

impl Merged {
    /// Folds another intersection in, refusing fields defined two different ways.
    fn absorb(&mut self, other: Self) -> Option<()> {
        for (name, field) in other.properties {
            match self.properties.entry(name) {
                serde_json::map::Entry::Vacant(slot) => {
                    slot.insert(field);
                }
                serde_json::map::Entry::Occupied(slot) if *slot.get() != field => {
                    // Conflicting intersection fields cannot be represented by
                    // silently choosing the first branch.
                    return None;
                }
                _ => {}
            }
        }
        self.required.extend(other.required);
        self.additional = combine_additional(self.additional.take(), other.additional)?;
        Some(())
    }

    /// The object schema a renderer reads fields from, or `None` when flattening
    /// would drop a constraint instead of showing it.
    fn into_schema(self) -> Option<serde_json::Value> {
        let has_properties = !self.properties.is_empty();
        let mut schema = serde_json::json!({
            "properties": self.properties,
            "required": self.required,
        });
        match self.additional {
            // A typed map beside named fields has no place in the field list, so
            // the intersection stays visible rather than losing the constraint.
            Some(additional) if additional.is_object() && has_properties => None,
            Some(additional) => {
                schema["additionalProperties"] = additional;
                Some(schema)
            }
            None => Some(schema),
        }
    }
}

/// Intersection of two additionalProperties constraints: `false` closes the
/// object, `true` adds nothing, and two different schemas cannot be shown.
fn combine_additional(
    left: Option<serde_json::Value>,
    right: Option<serde_json::Value>,
) -> Option<Option<serde_json::Value>> {
    match (left, right) {
        (None, other) | (other, None) => Some(other),
        (Some(serde_json::Value::Bool(false)), _) | (_, Some(serde_json::Value::Bool(false))) => {
            Some(Some(serde_json::Value::Bool(false)))
        }
        (Some(serde_json::Value::Bool(true)), other)
        | (other, Some(serde_json::Value::Bool(true))) => Some(other),
        (Some(left), Some(right)) if left == right => Some(Some(left)),
        _ => None,
    }
}

/// Whether a node can be read as object fields rather than some other shape.
fn describes_object(node: &serde_json::Value) -> bool {
    let object_type = match node.get("type") {
        None => true,
        Some(serde_json::Value::String(kind)) => kind == "object",
        Some(serde_json::Value::Array(kinds)) => {
            kinds.iter().all(|kind| kind.as_str() == Some("object"))
        }
        Some(_) => false,
    };
    object_type
        && ["const", "enum", "items", "prefixItems", "anyOf", "oneOf"]
            .iter()
            .all(|keyword| node.get(*keyword).is_none())
}

/// Reads a node's own object keywords. Its nested intersection is expanded by
/// the caller, which is why `allOf` is ignored here.
fn merge_own_keywords(node: &serde_json::Value, merged: &mut Merged) -> Option<()> {
    for (name, field) in node
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
    {
        match merged.properties.entry(name.clone()) {
            serde_json::map::Entry::Vacant(slot) => {
                slot.insert(field.clone());
            }
            serde_json::map::Entry::Occupied(slot) if slot.get() != field => return None,
            _ => {}
        }
    }
    if let Some(names) = node.get("required").and_then(serde_json::Value::as_array) {
        merged.required.extend(
            names
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned),
        );
    }
    merged.additional = combine_additional(
        merged.additional.take(),
        node.get("additionalProperties").cloned(),
    )?;
    Some(())
}

struct SignatureFormatter<'a> {
    root: &'a serde_json::Value,
    references: Vec<String>,
    truncated: bool,
}

impl<'a> SignatureFormatter<'a> {
    /// Local JSON Pointers resolve against the Action schema, not a nested object.
    fn reference(&self, pointer: &str) -> Option<&'a serde_json::Value> {
        (pointer.starts_with("#/$defs/") || pointer.starts_with("#/definitions/"))
            .then(|| self.root.pointer(&pointer[1..]))
            .flatten()
    }

    fn literal(value: &serde_json::Value) -> String {
        if value.is_array() || value.is_object() {
            "any".into()
        } else {
            value.to_string()
        }
    }

    fn merge_objects(
        &self,
        branches: &[&serde_json::Value],
        depth: usize,
    ) -> Option<serde_json::Value> {
        self.merge_intersection(branches, depth)?.into_schema()
    }

    /// Collects the fields an intersection declares, expanding each nested
    /// `allOf` beside the keywords written on the same node. A branch that only
    /// narrows the object adds no fields, so a rule such as `not` or `if`/`then`
    /// no longer discards the fields declared next to it.
    fn merge_intersection(&self, branches: &[&serde_json::Value], depth: usize) -> Option<Merged> {
        if branches.is_empty() || depth > SIGNATURE_MAX_DEPTH {
            return None;
        }
        let mut merged = Merged::default();
        for branch in branches {
            let mut node = *branch;
            for _ in 0..SIGNATURE_MAX_DEPTH {
                let Some(pointer) = node.get("$ref").and_then(serde_json::Value::as_str) else {
                    break;
                };
                node = self.reference(pointer)?;
            }
            if !describes_object(node) {
                return None;
            }
            match node.get("allOf").and_then(serde_json::Value::as_array) {
                Some(nested) => {
                    let mut own = node.clone();
                    if let Some(object) = own.as_object_mut() {
                        object.remove("allOf");
                    }
                    let mut parts = nested.iter().collect::<Vec<_>>();
                    if own.as_object().is_some_and(|object| !object.is_empty()) {
                        parts.push(&own);
                    }
                    merged.absorb(self.merge_intersection(&parts, depth + 1)?)?;
                }
                None => merge_own_keywords(node, &mut merged)?,
            }
        }
        Some(merged)
    }

    fn render(&mut self, schema: &serde_json::Value, depth: usize) -> Rendered {
        if depth > SIGNATURE_MAX_DEPTH {
            self.truncated = true;
            return Rendered::atom("{…}");
        }
        if let Some(pointer) = schema.get("$ref").and_then(serde_json::Value::as_str) {
            if self.references.iter().any(|seen| seen == pointer) {
                self.truncated = true;
                return Rendered::atom("…");
            }
            let Some(resolved) = self.reference(pointer) else {
                return Rendered::atom("any");
            };
            self.references.push(pointer.to_owned());
            let rendered = self.render(resolved, depth + 1);
            self.references.pop();
            return rendered;
        }
        if let Some(value) = schema.get("const") {
            return Rendered::atom(Self::literal(value));
        }
        if let Some(values) = schema.get("enum").and_then(serde_json::Value::as_array) {
            if values.is_empty() {
                return Rendered::atom("any");
            }
            let mut items = values
                .iter()
                .take(8)
                .map(|value| Rendered::atom(Self::literal(value)))
                .collect::<Vec<_>>();
            if values.len() > 8 {
                self.truncated = true;
                items.push(Rendered::atom("…"));
            }
            return Rendered::join(items, Shape::Union, "|");
        }
        if let Some(branches) = schema
            .get("anyOf")
            .or_else(|| schema.get("oneOf"))
            .and_then(serde_json::Value::as_array)
        {
            let mut parts = Vec::new();
            for (index, branch) in branches.iter().enumerate() {
                let part = self.render(branch, depth + 1);
                if !parts.contains(&part) {
                    parts.push(part);
                }
                if parts.len() == 4 {
                    self.truncated |= index + 1 < branches.len();
                    break;
                }
            }
            return if parts.is_empty() {
                Rendered::atom("null")
            } else {
                Rendered::join(parts, Shape::Union, "|")
            };
        }
        if let Some(branches) = schema.get("allOf").and_then(serde_json::Value::as_array) {
            // The schema's own object keywords belong to the intersection; allOf
            // only supplies the extra branches, so both sides merge together.
            let mut parts = branches.iter().collect::<Vec<_>>();
            if schema.get("properties").is_some() || schema.get("required").is_some() {
                parts.push(schema);
            }
            if let Some(merged) = self.merge_objects(&parts, depth + 1) {
                return self.render(&merged, depth + 1);
            }
            return if branches.is_empty() {
                Rendered::atom("any")
            } else {
                Rendered::join(
                    branches
                        .iter()
                        .map(|branch| self.render(branch, depth + 1))
                        .collect(),
                    Shape::Intersection,
                    " & ",
                )
            };
        }
        if let Some(kinds) = schema.get("type").and_then(serde_json::Value::as_array) {
            let mut parts = Vec::new();
            for kind in kinds.iter().filter_map(serde_json::Value::as_str) {
                let part = self.render_kind(schema, kind, depth);
                if !parts.contains(&part) {
                    parts.push(part);
                }
            }
            return if parts.is_empty() {
                Rendered::atom("null")
            } else {
                Rendered::join(parts, Shape::Union, "|")
            };
        }
        let kind =
            if schema.get("properties").is_some() || schema.get("additionalProperties").is_some() {
                "object"
            } else if schema.get("items").is_some() || schema.get("prefixItems").is_some() {
                "array"
            } else {
                schema
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("any")
            };
        self.render_kind(schema, kind, depth)
    }

    fn render_kind(&mut self, schema: &serde_json::Value, kind: &str, depth: usize) -> Rendered {
        match kind {
            "object" => self.object(schema, depth),
            "array" => self.array(schema, depth),
            "string" | "integer" | "number" | "boolean" | "null" => Rendered::atom(kind),
            _ => Rendered::atom("any"),
        }
    }

    fn array(&mut self, schema: &serde_json::Value, depth: usize) -> Rendered {
        if let Some(items) = schema
            .get("prefixItems")
            .or_else(|| schema.get("items").filter(|items| items.is_array()))
            .and_then(serde_json::Value::as_array)
            .filter(|items| !items.is_empty())
        {
            return Rendered::atom(format!(
                "[{}]",
                items
                    .iter()
                    .map(|item| self.render(item, depth + 1).to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let item = schema
            .get("items")
            .filter(|value| value.is_object() || value.is_boolean())
            .map(|value| self.render(value, depth + 1))
            .unwrap_or_else(|| Rendered::atom("any"));
        Rendered::atom(match item.shape {
            Shape::Union | Shape::Intersection => format!("({item})[]"),
            _ => format!("{item}[]"),
        })
    }

    fn object(&mut self, schema: &serde_json::Value, depth: usize) -> Rendered {
        if schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|props| !props.is_empty())
        {
            return Rendered {
                text: self.properties(schema, depth),
                shape: Shape::Object,
            };
        }
        match schema.get("additionalProperties") {
            Some(serde_json::Value::Bool(true)) => Rendered::atom("{[key:string]:any}"),
            Some(value) if value.is_object() => Rendered::atom(format!(
                "{{[key:string]:{}}}",
                self.render(value, depth + 1)
            )),
            _ => Rendered::atom("object"),
        }
    }

    fn properties(&mut self, schema: &serde_json::Value, depth: usize) -> String {
        let Some(properties) = schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
        else {
            return String::new();
        };
        let required = schema
            .get("required")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .collect::<HashSet<_>>();
        let mut fields = properties.iter().collect::<Vec<_>>();
        fields.sort_by_key(|(name, _)| !required.contains(name.as_str()));
        // Leave room for braces and an ellipsis; never truncate inside a field.
        let mut output = String::new();
        let extra = schema.get("additionalProperties") == Some(&serde_json::Value::Bool(true));
        for (index, (name, value)) in fields.iter().enumerate() {
            let kind = self.render(value, depth + 1);
            let bang = if required.contains(name.as_str()) {
                "!"
            } else {
                ""
            };
            let member = format!("{name}:{kind}{bang}");
            let separator = if output.is_empty() { "" } else { ", " };
            let tail = if index + 1 < fields.len() || extra {
                ", …".len()
            } else {
                0
            };
            if output.len() + separator.len() + member.len() + tail > SIGNATURE_MAX_LENGTH - 4 {
                self.truncated = true;
                if !output.is_empty() {
                    output.push_str(", ");
                }
                output.push('…');
                return output;
            }
            output.push_str(separator);
            output.push_str(&member);
        }
        if extra {
            output.push_str(", …");
        }
        output
    }
}
