use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tree_sitter_tags::{TagsConfiguration, TagsContext};

use crate::db::SymbolRow;

pub fn language(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("");
    match extension {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        _ => "other",
    }
}

fn grammar(lang: &str) -> Option<(tree_sitter::Language, &'static str)> {
    Some(match lang {
        "rust" => (
            tree_sitter_rust::LANGUAGE.into(),
            tree_sitter_rust::TAGS_QUERY,
        ),
        "typescript" => (
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            tree_sitter_typescript::TAGS_QUERY,
        ),
        "tsx" => (
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            tree_sitter_typescript::TAGS_QUERY,
        ),
        "javascript" => (
            tree_sitter_javascript::LANGUAGE.into(),
            tree_sitter_javascript::TAGS_QUERY,
        ),
        "python" => (
            tree_sitter_python::LANGUAGE.into(),
            tree_sitter_python::TAGS_QUERY,
        ),
        "go" => (tree_sitter_go::LANGUAGE.into(), tree_sitter_go::TAGS_QUERY),
        "java" => (
            tree_sitter_java::LANGUAGE.into(),
            tree_sitter_java::TAGS_QUERY,
        ),
        "c" => (tree_sitter_c::LANGUAGE.into(), tree_sitter_c::TAGS_QUERY),
        "cpp" => (
            tree_sitter_cpp::LANGUAGE.into(),
            tree_sitter_cpp::TAGS_QUERY,
        ),
        "csharp" => (
            tree_sitter_c_sharp::LANGUAGE.into(),
            include_str!("../queries/csharp.scm"),
        ),
        "ruby" => (
            tree_sitter_ruby::LANGUAGE.into(),
            tree_sitter_ruby::TAGS_QUERY,
        ),
        "php" => (
            tree_sitter_php::LANGUAGE_PHP.into(),
            tree_sitter_php::TAGS_QUERY,
        ),
        "swift" => (
            tree_sitter_swift::LANGUAGE.into(),
            include_str!("../queries/swift.scm"),
        ),
        "kotlin" => (
            tree_sitter_kotlin_ng::LANGUAGE.into(),
            include_str!("../queries/kotlin.scm"),
        ),
        _ => return None,
    })
}

pub struct Parser {
    context: TagsContext,
    configs: HashMap<&'static str, Option<TagsConfiguration>>,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            context: TagsContext::new(),
            configs: HashMap::new(),
        }
    }

    pub fn parse(&mut self, lang: &'static str, source: &[u8]) -> Option<Vec<SymbolRow>> {
        let Some((grammar, query)) = grammar(lang) else {
            return Some(Vec::new());
        };
        let config = self.configs.entry(lang).or_insert_with(|| {
            match TagsConfiguration::new(grammar, query, "") {
                Ok(config) => Some(config),
                Err(error) => {
                    log_once(lang, &error);
                    None
                }
            }
        });
        let Some(config) = config else { return None };
        let (tags, _) = match self.context.generate_tags(config, source, None) {
            Ok(result) => result,
            Err(error) => {
                log_once(lang, &error);
                return None;
            }
        };
        Some(
            tags.filter_map(|tag| {
                let tag = tag.ok()?;
                let name = std::str::from_utf8(source.get(tag.name_range.clone())?)
                    .ok()?
                    .to_owned();
                if name.is_empty() {
                    return None;
                }
                let context = String::from_utf8_lossy(source.get(tag.line_range.clone())?)
                    .trim()
                    .chars()
                    .take(200)
                    .collect::<String>();
                Some(SymbolRow {
                    name,
                    kind: config.syntax_type_name(tag.syntax_type_id).to_owned(),
                    line: (tag.span.start.row + 1) as u32,
                    end_line: (tag.span.end.row + 1) as u32,
                    is_def: tag.is_definition,
                    signature: context,
                    doc: tag.docs.map(|doc| doc.chars().take(300).collect()),
                })
            })
            .collect(),
        )
    }
}

fn log_once(lang: &str, error: &tree_sitter_tags::Error) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    if let Ok(mut logged) = LOGGED.get_or_init(|| Mutex::new(HashSet::new())).lock()
        && logged.insert(lang.to_owned())
    {
        tracing::warn!(language = lang, %error, "tags query unavailable");
    }
}
