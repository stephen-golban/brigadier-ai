//! Deriving a task's areas from the paths its spec names, when the orchestrator names none.

use crate::Area;

const FRONTEND: [&str; 10] = [
    "tsx", "jsx", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte",
];
const DOCS: [&str; 4] = ["md", "mdx", "rst", "adoc"];
const INFRA: [&str; 3] = ["tf", "tfvars", "hcl"];
const SOURCE: [&str; 31] = [
    "rs", "go", "py", "java", "kt", "kts", "rb", "php", "cs", "c", "cc", "cpp", "cxx", "h", "hpp",
    "swift", "m", "mm", "ts", "mts", "cts", "js", "mjs", "cjs", "sql", "scala", "ex", "exs", "erl",
    "zig", "dart",
];

/// The areas a task spec touches, from the paths and file names it mentions (in [`Area::ALL`]
/// order):
/// - tsx/jsx/css/scss/html/vue/svelte → frontend;
/// - Dockerfiles, compose files, `.github/workflows`, Terraform, Kubernetes/Helm YAML → infra;
/// - md/mdx/rst → docs;
/// - test and spec paths (`tests/`, `__tests__/`, `*.test.*`, `*_test.*`, `test_*.py`) → tests;
/// - any other source file → backend.
///
/// A test file counts only as tests. URLs are ignored.
pub fn infer_areas(spec: &str) -> Vec<Area> {
    let mut found = [false; 5];
    for token in spec.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '`' | '"' | '\'' | '(' | ')' | '[' | ']' | '<' | '>' | ',' | ';' | '|'
            )
    }) {
        let token = token.trim_end_matches([':', '.', '!', '?']);
        if token.is_empty() || token.contains("://") {
            continue;
        }
        if let Some(area) = classify(token) {
            found[Area::ALL.iter().position(|a| *a == area).unwrap_or(0)] = true;
        }
    }
    Area::ALL
        .into_iter()
        .zip(found)
        .filter_map(|(area, hit)| hit.then_some(area))
        .collect()
}

fn classify(path: &str) -> Option<Area> {
    let lower = path.to_ascii_lowercase().replace('\\', "/");
    let file = lower.rsplit('/').next().unwrap_or(&lower);
    let (stem, extension) = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, Some(ext)),
        _ => (file, None),
    };
    let dirs: Vec<&str> = lower.split('/').collect();
    let dirs = &dirs[..dirs.len().saturating_sub(1)];

    let yaml = matches!(extension, Some("yml" | "yaml"));
    if file == "dockerfile"
        || file == "containerfile"
        || file.starts_with("dockerfile.")
        || extension == Some("dockerfile")
        || (yaml && (stem.starts_with("docker-compose") || stem == "compose"))
        || (yaml && lower.contains(".github/workflows/"))
        || extension.is_some_and(|ext| INFRA.contains(&ext))
        || (yaml
            && dirs
                .iter()
                .any(|dir| matches!(*dir, "k8s" | "kubernetes" | "helm" | "charts" | "manifests")))
    {
        return Some(Area::Infra);
    }
    let extension = extension?;
    let source = SOURCE.contains(&extension) || FRONTEND.contains(&extension);
    if source
        && (dirs.iter().any(|dir| {
            matches!(
                *dir,
                "test" | "tests" | "__tests__" | "spec" | "specs" | "e2e"
            )
        }) || stem.ends_with(".test")
            || stem.ends_with(".spec")
            || stem.ends_with("_test")
            || stem.ends_with("_spec")
            || (extension == "py" && stem.starts_with("test_")))
    {
        return Some(Area::Tests);
    }
    if FRONTEND.contains(&extension) {
        return Some(Area::Frontend);
    }
    if DOCS.contains(&extension) {
        return Some(Area::Docs);
    }
    // Library names are not paths ("Node.js", "Next.js").
    if extension == "js"
        && dirs.is_empty()
        && matches!(
            stem,
            "node" | "next" | "nuxt" | "vue" | "react" | "express" | "three" | "d3"
        )
    {
        return None;
    }
    // A bare word with a dot ("e.g", "v1.2") is not a path: source files need a real stem.
    if SOURCE.contains(&extension) && stem.chars().any(|c| c.is_ascii_alphabetic()) {
        return Some(Area::Backend);
    }
    None
}
