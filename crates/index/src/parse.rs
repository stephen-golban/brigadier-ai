use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, OnceLock};
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

// The TypeScript grammar's bundled tags query only adds to the JavaScript one (its functions,
// classes and calls live there), so the two are joined, with our own patterns around them:
// earlier patterns win when two tag the same name.
static TYPESCRIPT_TAGS: LazyLock<String> = LazyLock::new(|| {
    ecmascript_tags(&[
        TYPESCRIPT,
        tree_sitter_javascript::TAGS_QUERY,
        tree_sitter_typescript::TAGS_QUERY,
    ])
});
static TSX_TAGS: LazyLock<String> = LazyLock::new(|| {
    ecmascript_tags(&[
        TYPESCRIPT,
        tree_sitter_javascript::TAGS_QUERY,
        tree_sitter_typescript::TAGS_QUERY,
        JSX,
    ])
});
static JAVASCRIPT_TAGS: LazyLock<String> = LazyLock::new(|| {
    ecmascript_tags(&[
        include_str!("../queries/javascript.scm"),
        tree_sitter_javascript::TAGS_QUERY,
        JSX,
    ])
});

const TYPESCRIPT: &str = include_str!("../queries/typescript.scm");
const JSX: &str = include_str!("../queries/jsx.scm");

fn ecmascript_tags(queries: &[&str]) -> String {
    let mut all = vec![include_str!("../queries/ecmascript-exports.scm")];
    all.extend(queries);
    all.push(include_str!("../queries/ecmascript-constants.scm"));
    all.join("\n")
}

fn grammar(lang: &str) -> Option<(tree_sitter::Language, &'static str)> {
    Some(match lang {
        "rust" => (
            tree_sitter_rust::LANGUAGE.into(),
            tree_sitter_rust::TAGS_QUERY,
        ),
        "typescript" => (
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            TYPESCRIPT_TAGS.as_str(),
        ),
        "tsx" => (
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            TSX_TAGS.as_str(),
        ),
        "javascript" => (
            tree_sitter_javascript::LANGUAGE.into(),
            JAVASCRIPT_TAGS.as_str(),
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
                    doc: tag
                        .docs
                        .map(|doc| match lang {
                            "typescript" | "tsx" | "javascript" => block_comment_text(&doc),
                            _ => doc,
                        })
                        .filter(|doc| !doc.is_empty())
                        .map(|doc| doc.chars().take(300).collect()),
                })
            })
            .collect(),
        )
    }
}

/// A `/** … */` or `//` comment's text: the queries' strip pattern runs once over the whole
/// comment, so it leaves the closing `*/` and the ` * ` starting each later line.
fn block_comment_text(doc: &str) -> String {
    let lines: Vec<&str> = doc
        .lines()
        .map(|line| {
            let line = line.trim();
            let line = line.strip_suffix("*/").unwrap_or(line);
            line.trim_start_matches(['/', '*']).trim()
        })
        .collect();
    lines.join("\n").trim().to_owned()
}

fn log_once(lang: &str, error: &tree_sitter_tags::Error) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    if let Ok(mut logged) = LOGGED.get_or_init(|| Mutex::new(HashSet::new())).lock()
        && logged.insert(lang.to_owned())
    {
        tracing::warn!(language = lang, %error, "tags query unavailable");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPESCRIPT_SOURCE: &str = r#"/** Adds two numbers. */
export function add(a: number, b: number): number { return a + b; }
export default function main() { const scratch = 1; return scratch; }
export async function load(): Promise<void> {}
function local() {}
function* numbers() {}
export const arrow = () => 1;
const expression = function () {};
export const fetchUser = async (id: string) => id;
/** Someone who signs in. */
export interface User { name: string; greet(): void }
interface Local {}
export type Id = string;
type Pair = [Id, Id];
export enum Color { Red }
const enum Flag { On }
export class Service {
  run() {}
  handle = () => {};
  static create() { return new Service(); }
}
export abstract class Base { abstract go(): void; }
export namespace Space {}
export const API_URL = "https://example.com";
const useStore = create(() => ({}));
"#;

    const TSX_SOURCE: &str = r#"export function Screen() {
  return <View><Button title="go" /></View>;
}
export const Card: React.FC<Props> = ({ title }) => <Text>{title}</Text>;
export default function App() { return <div />; }
const Row = memo(() => <span />);
export interface Props { title: string }
export type Mode = "a" | "b";
export enum Tab { Home }
export class Store { load = async () => {}; save() {} }
"#;

    const JAVASCRIPT_SOURCE: &str = r#"/** Adds two numbers. */
export function add(a, b) { return a + b; }
export default function main() {}
export async function load() {}
function local() {}
export const arrow = () => 1;
const expression = function () {};
export class Service {
  run() {}
  handle = () => {};
}
export function Screen() { return <View><Button /></View>; }
export const API_URL = "https://example.com";
module.exports.helper = function () {};
"#;

    fn definitions(lang: &'static str, source: &str) -> Vec<(String, String, u32)> {
        let symbols = Parser::new().parse(lang, source.as_bytes()).unwrap();
        symbols
            .into_iter()
            .filter(|s| s.is_def)
            .map(|s| (s.name, s.kind, s.line))
            .collect()
    }

    fn assert_defines(found: &[(String, String, u32)], expected: &[(&str, &str, u32)]) {
        for (name, kind, line) in expected {
            assert!(
                found
                    .iter()
                    .any(|(n, k, l)| n == name && k == kind && l == line),
                "{kind} {name} at line {line} missing from {found:?}"
            );
        }
    }

    #[test]
    fn typescript_definitions() {
        let found = definitions("typescript", TYPESCRIPT_SOURCE);
        assert_defines(
            &found,
            &[
                ("add", "function", 2),
                ("main", "function", 3),
                ("load", "function", 4),
                ("local", "function", 5),
                ("numbers", "function", 6),
                ("arrow", "function", 7),
                ("expression", "function", 8),
                ("fetchUser", "function", 9),
                ("User", "interface", 11),
                ("greet", "method", 11),
                ("Local", "interface", 12),
                ("Id", "type", 13),
                ("Pair", "type", 14),
                ("Color", "enum", 15),
                ("Flag", "enum", 16),
                ("Service", "class", 17),
                ("run", "method", 18),
                ("handle", "method", 19),
                ("create", "method", 20),
                ("Base", "class", 22),
                ("go", "method", 22),
                ("Space", "module", 23),
                ("API_URL", "constant", 24),
                ("useStore", "constant", 25),
            ],
        );
        // One tag per name, and a function's locals are not definitions.
        assert_eq!(found.iter().filter(|s| s.0 == "add").count(), 1);
        assert!(!found.iter().any(|s| s.0 == "scratch"));
    }

    #[test]
    fn typescript_doc_comments_reach_exported_definitions() {
        let symbols = Parser::new()
            .parse("typescript", TYPESCRIPT_SOURCE.as_bytes())
            .unwrap();
        let doc = |name: &str| {
            symbols
                .iter()
                .find(|s| s.is_def && s.name == name)
                .and_then(|s| s.doc.clone())
        };
        assert_eq!(doc("add").as_deref(), Some("Adds two numbers."));
        assert_eq!(doc("User").as_deref(), Some("Someone who signs in."));
        assert_eq!(doc("main"), None);
        let source = "/**\n * Loads a user.\n *\n * Cached.\n */\nexport const loadUser = () => 1;\n// The base URL.\nexport const BASE = '/';\n// Not adjacent.\n\nconst far = 1;\n";
        let symbols = Parser::new()
            .parse("typescript", source.as_bytes())
            .unwrap();
        let docs: Vec<_> = symbols
            .iter()
            .map(|s| (s.name.as_str(), s.doc.as_deref()))
            .collect();
        assert_eq!(
            docs,
            [
                ("loadUser", Some("Loads a user.\n\nCached.")),
                ("BASE", Some("The base URL.")),
                ("far", None),
            ]
        );
    }

    #[test]
    fn tsx_definitions_and_component_uses() {
        let found = definitions("tsx", TSX_SOURCE);
        assert_defines(
            &found,
            &[
                ("Screen", "function", 1),
                ("Card", "function", 4),
                ("App", "function", 5),
                ("Row", "constant", 6),
                ("Props", "interface", 7),
                ("Mode", "type", 8),
                ("Tab", "enum", 9),
                ("Store", "class", 10),
                ("load", "method", 10),
                ("save", "method", 10),
            ],
        );
        let symbols = Parser::new().parse("tsx", TSX_SOURCE.as_bytes()).unwrap();
        let used: Vec<&str> = symbols
            .iter()
            .filter(|s| !s.is_def && s.kind == "call")
            .map(|s| s.name.as_str())
            .collect();
        for component in ["View", "Button", "Text"] {
            assert!(used.contains(&component), "{component} not in {used:?}");
        }
        assert!(!used.contains(&"div") && !used.contains(&"span"));
    }

    #[test]
    fn javascript_definitions() {
        let found = definitions("javascript", JAVASCRIPT_SOURCE);
        assert_defines(
            &found,
            &[
                ("add", "function", 2),
                ("main", "function", 3),
                ("load", "function", 4),
                ("local", "function", 5),
                ("arrow", "function", 6),
                ("expression", "function", 7),
                ("Service", "class", 8),
                ("run", "method", 9),
                ("handle", "method", 10),
                ("Screen", "function", 12),
                ("API_URL", "constant", 13),
                ("helper", "function", 14),
            ],
        );
        let symbols = Parser::new()
            .parse("javascript", JAVASCRIPT_SOURCE.as_bytes())
            .unwrap();
        assert_eq!(
            symbols
                .iter()
                .find(|s| s.name == "add")
                .unwrap()
                .doc
                .as_deref(),
            Some("Adds two numbers.")
        );
        assert!(symbols.iter().any(|s| !s.is_def && s.name == "Button"));
    }

    #[test]
    fn every_extension_maps_to_a_grammar_whose_query_compiles() {
        for path in [
            "a.ts", "a.mts", "a.cts", "a.d.ts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.jsx",
        ] {
            let lang = language(path);
            assert_ne!(lang, "other", "{path}");
            assert!(
                Parser::new()
                    .parse(lang, b"export function f() {}")
                    .is_some()
            );
        }
    }
}
