use crate::util;
use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

const MAX_DISCOVERY_DEPTH: usize = 2;
const DEFAULT_RESOURCE_MAX_BYTES: u64 = 50_000;
const DEFAULT_TOTAL_RESOURCE_BYTES: u64 = 200_000;
const DEFAULT_MAX_RESOURCE_FILES: usize = 20;
const MAX_SUMMARY_DESCRIPTION_CHARS: usize = 180;
const BINARY_SNIFF_BYTES: u64 = 8192;
const IGNORE_DIRS: [&str; 6] = [".git", "node_modules", "dist", "build", ".next", "coverage"];

struct Skill {
    name: String,
    description: String,
    slug: String,
    dir: PathBuf,
    skill_file: PathBuf,
}

/// Compact skill index entry for thread bootstrap.
pub struct SkillSummary {
    pub name: String,
    pub slug: String,
    pub description: String,
}

#[derive(Debug)]
struct Resource {
    path: String,
    absolute_path: PathBuf,
    size: u64,
    is_text: bool,
}

pub fn list() -> Result<Vec<SkillSummary>> {
    Ok(discover()?
        .into_iter()
        .map(|skill| SkillSummary {
            description: skill
                .description
                .chars()
                .take(MAX_SUMMARY_DESCRIPTION_CHARS)
                .collect(),
            name: skill.name,
            slug: skill.slug,
        })
        .collect())
}

fn use_skill(args: &Value, skills: &[Skill]) -> Result<String> {
    let skill = resolve(util::arg_str(args, "skill")?, skills)?;
    let include_resources = args
        .get("include_resources")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut content = format!(
        "# Skill: {}\n{}\nSlug: {}\nSource: {}\n## Instructions\n",
        skill.name,
        skill.description,
        skill.slug,
        skill.skill_file.display()
    );
    File::open(&skill.skill_file)?.read_to_string(&mut content)?;
    if !include_resources {
        return Ok(content);
    }

    let mut selected = Vec::new();
    let mut skipped = Vec::new();
    let mut total = 0;
    for resource in collect_resources(&skill.dir, "", &mut HashSet::new())? {
        let reason = if selected.len() >= DEFAULT_MAX_RESOURCE_FILES {
            Some("max_resource_files_exceeded")
        } else if !resource.is_text {
            Some("binary_or_non_text")
        } else if resource.size > DEFAULT_RESOURCE_MAX_BYTES {
            Some("resource_max_bytes_exceeded")
        } else if total + resource.size > DEFAULT_TOTAL_RESOURCE_BYTES {
            Some("total_resource_max_bytes_exceeded")
        } else {
            None
        };
        if let Some(reason) = reason {
            skipped.push((resource.path, reason));
            continue;
        }
        total += resource.size;
        selected.push(resource);
    }

    if !selected.is_empty() {
        content.push_str("\n## Resources");
        for resource in &selected {
            content.push_str("\n### ");
            content.push_str(&resource.path);
            content.push('\n');
            File::open(&resource.absolute_path)?.read_to_string(&mut content)?;
        }
    }
    if !skipped.is_empty() {
        content.push_str("\n## Skipped Resources");
        for (path, reason) in &skipped {
            content.push_str(&format!("\n- {path}: {reason}"));
        }
    }
    Ok(content)
}

pub fn use_skills(args: Value) -> Result<Value> {
    let skills = discover()?;
    batch(&args, "skills", &["skill"], |item| use_skill(item, &skills))
}

fn read_resource(args: &Value, skills: &[Skill]) -> Result<String> {
    let skill = resolve(util::arg_str(args, "skill")?, skills)?;
    let resource_path = util::arg_str(args, "resource_path")?;
    let resource = resolve_resource(&skill.dir, resource_path)?;
    if !resource.is_text {
        bail!("Skill resource is not a text file: {resource_path}");
    }
    let mut content = format!("# {}\n\n", resource.path);
    File::open(&resource.absolute_path)?.read_to_string(&mut content)?;
    Ok(content)
}

pub fn read_resources(args: Value) -> Result<Value> {
    let skills = discover()?;
    batch(&args, "resources", &["skill", "resource_path"], |item| {
        read_resource(item, &skills)
    })
}

fn batch(
    args: &Value,
    collection: &str,
    identity_fields: &[&str],
    mut operation: impl FnMut(&Value) -> Result<String>,
) -> Result<Value> {
    let values = args
        .get(collection)
        .and_then(Value::as_array)
        .with_context(|| format!("Missing {collection}"))?;
    if values.is_empty() {
        bail!("Missing {collection}");
    }
    let mut successes = Vec::new();
    let mut errors = Vec::new();
    for item in values {
        let mut fields = identity_fields
            .iter()
            .map(|field| {
                (
                    (*field).to_string(),
                    item.get(*field).cloned().unwrap_or(Value::Null),
                )
            })
            .collect::<Map<_, _>>();
        match operation(item) {
            Ok(content) => {
                fields.insert("content".into(), Value::String(content));
                successes.push(Value::Object(fields));
            }
            Err(error) => {
                fields.insert("message".into(), error.to_string().into());
                errors.push(Value::Object(fields));
            }
        }
    }
    Ok(Value::Object(Map::from_iter([
        (collection.to_string(), Value::Array(successes)),
        ("errors".into(), Value::Array(errors)),
    ])))
}

fn discover() -> Result<Vec<Skill>> {
    let root = root()?;
    let mut files = Vec::new();
    find_skill_files(&root, 0, &mut HashSet::new(), &mut files)?;
    let mut skills = files
        .into_iter()
        .map(|skill_file| {
            let dir = skill_file
                .parent()
                .context("Missing skill parent")?
                .to_path_buf();
            let (name, description) = frontmatter(&skill_file)?;
            let slug = normalize(
                dir.strip_prefix(&root)
                    .unwrap_or(&dir)
                    .to_string_lossy()
                    .as_ref(),
            );
            Ok(Skill {
                name: if name.is_empty() {
                    dir.file_name().unwrap().to_string_lossy().into()
                } else {
                    name
                },
                description,
                slug,
                dir,
                skill_file,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    skills.sort_by(|left, right| left.slug.cmp(&right.slug));
    Ok(skills)
}

fn find_skill_files(
    dir: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    found: &mut Vec<PathBuf>,
) -> Result<()> {
    if depth > MAX_DISCOVERY_DEPTH || !dir.exists() {
        return Ok(());
    }
    let real = dir.canonicalize().unwrap_or(dir.to_path_buf());
    if !visited.insert(real) {
        return Ok(());
    }
    let skill_file = dir.join("SKILL.md");
    if skill_file.is_file() {
        found.push(skill_file);
    }
    if depth == MAX_DISCOVERY_DEPTH {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        // `file_type` does not follow symlinks, so linked directories are
        // skipped without an extra stat.
        if entry.file_type()?.is_dir()
            && !IGNORE_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
        {
            find_skill_files(&entry.path(), depth + 1, visited, found)?;
        }
    }
    Ok(())
}

fn collect_resources(
    dir: &Path,
    prefix: &str,
    visited: &mut HashSet<PathBuf>,
) -> Result<Vec<Resource>> {
    let real = dir.canonicalize().unwrap_or(dir.to_path_buf());
    if !visited.insert(real) {
        return Ok(Vec::new());
    }
    let mut resources = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORE_DIRS.contains(&name.as_str()) || kind.is_symlink() {
            continue;
        }
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        if kind.is_dir() {
            resources.extend(collect_resources(&path, &relative, visited)?);
        } else if kind.is_file() && relative != "SKILL.md" {
            resources.push(Resource {
                path: normalize(&relative),
                size: entry.metadata()?.len(),
                is_text: is_text_file(&path),
                absolute_path: path,
            });
        }
    }
    resources.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(resources)
}

fn resolve<'a>(input: &str, skills: &'a [Skill]) -> Result<&'a Skill> {
    let input = input.trim();
    let normalized = normalize(input);
    if let Some(skill) = skills.iter().find(|skill| skill.slug == normalized) {
        return Ok(skill);
    }
    let mut matches = skills.iter().filter(|skill| skill.name == input);
    match (matches.next(), matches.next()) {
        (Some(skill), None) => Ok(skill),
        (None, _) => bail!("Skill not found: {input}"),
        (Some(_), Some(_)) => bail!("Multiple skills match name: {input}"),
    }
}

fn resolve_resource(skill_dir: &Path, resource_path: &str) -> Result<Resource> {
    let normalized = normalize(resource_path.trim());
    if normalized.is_empty() {
        bail!("resource_path is required");
    }
    let root = skill_dir.canonicalize().unwrap_or(skill_dir.to_path_buf());
    let absolute = skill_dir
        .join(&normalized)
        .canonicalize()
        .unwrap_or(skill_dir.join(&normalized));
    let relative = absolute
        .strip_prefix(&root)
        .with_context(|| format!("Resource path escapes skill directory: {resource_path}"))?;
    if relative.as_os_str().is_empty() {
        bail!("Resource path escapes skill directory: {resource_path}");
    }
    let metadata = match fs::metadata(&absolute) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => bail!("Skill resource not found: {resource_path}"),
    };
    Ok(Resource {
        path: normalize(relative.to_string_lossy().as_ref()),
        size: metadata.len(),
        is_text: is_text_file(&absolute),
        absolute_path: absolute,
    })
}

/// Parse the leading YAML document, bounded independently of the skill body.
fn frontmatter(path: &Path) -> Result<(String, String)> {
    const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
    let mut lines = BufReader::new(File::open(path)?).lines();
    if !matches!(lines.next().transpose()?, Some(line) if line.trim_end_matches('\r') == "---") {
        return Ok((String::new(), String::new()));
    }
    let mut yaml = String::new();
    for line in lines {
        let line = line?;
        if line.trim_end_matches('\r') == "---" {
            #[derive(serde::Deserialize)]
            struct Metadata {
                #[serde(default)]
                name: String,
                #[serde(default)]
                description: String,
            }
            let metadata: Metadata = serde_saphyr::from_str(&yaml)
                .with_context(|| format!("Invalid skill YAML frontmatter: {}", path.display()))?;
            return Ok((metadata.name, metadata.description));
        }
        if yaml.len() + line.len() + 1 > MAX_FRONTMATTER_BYTES {
            bail!("Skill frontmatter is too large: {}", path.display());
        }
        yaml.push_str(&line);
        yaml.push('\n');
    }
    bail!("Unterminated skill frontmatter: {}", path.display())
}

/// Sniffs only the first bytes instead of reading the whole file.
fn is_text_file(path: &Path) -> bool {
    let mut head = Vec::with_capacity(BINARY_SNIFF_BYTES as usize);
    File::open(path)
        .and_then(|file| file.take(BINARY_SNIFF_BYTES).read_to_end(&mut head))
        .map(|_| !head.contains(&0))
        .unwrap_or(false)
}

fn normalize(value: &str) -> String {
    value.replace('\\', "/").trim_matches('/').to_string()
}

fn root() -> Result<PathBuf> {
    Ok(util::home_dir()?.join(".agents/skills"))
}
