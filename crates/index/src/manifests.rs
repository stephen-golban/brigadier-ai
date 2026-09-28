use crate::{Dependency, Manifest, Script, Service};
use std::path::Path;

pub fn extract(path: &str, text: &str) -> (Option<Manifest>, Vec<Script>, Vec<Service>) {
    let name = path.rsplit('/').next().unwrap_or(path);
    let mut scripts = Vec::new();
    let mut services = Vec::new();
    let manifest = match name {
        "Cargo.toml" => toml::from_str::<toml::Value>(text).ok().map(|v| {
            let mut m = base(path, "cargo");
            m.name = v
                .get("package")
                .and_then(|p| p.get("name"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned);
            m.version = v
                .get("package")
                .and_then(|p| p.get("version"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned);
            m.members = strings(v.get("workspace").and_then(|w| w.get("members")));
            deps_toml(&mut m, v.get("dependencies"), false);
            deps_toml(&mut m, v.get("dev-dependencies"), true);
            m
        }),
        "package.json" | "composer.json" => serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .map(|v| {
                let mut m = base(
                    path,
                    if name == "package.json" {
                        "npm"
                    } else {
                        "composer"
                    },
                );
                m.name = v.get("name").and_then(|x| x.as_str()).map(str::to_owned);
                m.version = v.get("version").and_then(|x| x.as_str()).map(str::to_owned);
                m.members = v
                    .get("workspaces")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                if m.members.is_empty() {
                    m.members = v
                        .get("workspaces")
                        .and_then(|x| x.get("packages"))
                        .and_then(|x| x.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                deps_json(
                    &mut m,
                    v.get(if name == "package.json" {
                        "dependencies"
                    } else {
                        "require"
                    }),
                    false,
                );
                deps_json(
                    &mut m,
                    v.get(if name == "package.json" {
                        "devDependencies"
                    } else {
                        "require-dev"
                    }),
                    true,
                );
                if let Some(map) = v.get("scripts").and_then(|x| x.as_object()) {
                    for (key, value) in map {
                        if let Some(command) = value.as_str() {
                            scripts.push(Script {
                                name: key.clone(),
                                command: command.into(),
                                source: path.into(),
                            });
                        }
                    }
                }
                m
            }),
        "pnpm-workspace.yaml" => yaml_rust2::YamlLoader::load_from_str(text)
            .ok()
            .and_then(|v| v.into_iter().next())
            .map(|v| {
                let mut m = base(path, "pnpmWorkspace");
                m.members = v["packages"]
                    .as_vec()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                m
            }),
        "pyproject.toml" => toml::from_str::<toml::Value>(text).ok().map(|v| {
            let mut m = base(path, "python");
            m.name = v
                .get("project")
                .and_then(|x| x.get("name"))
                .or_else(|| {
                    v.get("tool")
                        .and_then(|x| x.get("poetry"))
                        .and_then(|x| x.get("name"))
                })
                .and_then(toml::Value::as_str)
                .map(str::to_owned);
            m.version = v
                .get("project")
                .and_then(|x| x.get("version"))
                .and_then(toml::Value::as_str)
                .map(str::to_owned);
            for dep in strings(v.get("project").and_then(|x| x.get("dependencies"))) {
                let key = dep
                    .split(['<', '>', '=', '~', '[', ' '])
                    .next()
                    .unwrap_or(&dep);
                m.dependencies.push(Dependency {
                    name: key.into(),
                    requirement: Some(dep),
                    dev: false,
                });
            }
            deps_toml(
                &mut m,
                v.get("tool")
                    .and_then(|x| x.get("poetry"))
                    .and_then(|x| x.get("dependencies")),
                false,
            );
            deps_toml(
                &mut m,
                v.get("tool")
                    .and_then(|x| x.get("poetry"))
                    .and_then(|x| x.get("group"))
                    .and_then(|x| x.get("dev"))
                    .and_then(|x| x.get("dependencies")),
                true,
            );
            m
        }),
        "go.mod" => {
            let mut m = base(path, "go");
            m.name = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("module ").map(str::to_owned));
            for line in text.lines() {
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("require ").or_else(|| {
                    if l.starts_with(|c: char| c.is_ascii_alphabetic()) && l.contains(" v") {
                        Some(l)
                    } else {
                        None
                    }
                }) {
                    let mut p = rest.split_whitespace();
                    if let Some(n) = p.next() {
                        m.dependencies.push(Dependency {
                            name: n.into(),
                            requirement: p.next().map(str::to_owned),
                            dev: false,
                        });
                    }
                }
            }
            Some(m)
        }
        "Gemfile" => {
            let mut m = base(path, "ruby");
            for l in text.lines() {
                if let Some(rest) = l.trim().strip_prefix("gem ") {
                    let parts: Vec<_> = rest
                        .split(',')
                        .map(|x| x.trim().trim_matches(['\'', '"']))
                        .collect();
                    if let Some(n) = parts.first() {
                        m.dependencies.push(Dependency {
                            name: (*n).into(),
                            requirement: parts.get(1).map(|x| (*x).into()),
                            dev: false,
                        });
                    }
                }
            }
            Some(m)
        }
        "pom.xml" => {
            let mut m = base(path, "maven");
            m.name = xml_tag(text, "artifactId");
            m.version = xml_tag(text, "version");
            Some(m)
        }
        "build.gradle" | "build.gradle.kts" => {
            let mut m = base(path, "gradle");
            m.name = path.rsplit('/').nth(1).map(str::to_owned);
            for l in text.lines() {
                let l = l.trim();
                if l.starts_with("implementation")
                    || l.starts_with("api")
                    || l.starts_with("testImplementation")
                {
                    let d = l.split(['\'', '"']).nth(1).unwrap_or("");
                    if !d.is_empty() {
                        m.dependencies.push(Dependency {
                            name: d.split(':').take(2).collect::<Vec<_>>().join(":"),
                            requirement: d.split(':').nth(2).map(str::to_owned),
                            dev: l.starts_with("test"),
                        });
                    }
                }
            }
            Some(m)
        }
        _ if name.starts_with("requirements") && name.ends_with(".txt") => {
            let mut m = base(path, "python");
            for line in text.lines() {
                let l = line.trim();
                if !l.is_empty() && !l.starts_with(['#', '-']) {
                    let n = l.split(['<', '>', '=', '~', '[', ' ']).next().unwrap_or(l);
                    m.dependencies.push(Dependency {
                        name: n.into(),
                        requirement: Some(l.into()),
                        dev: false,
                    });
                }
            }
            Some(m)
        }
        _ => None,
    };
    if name == "Makefile" || name == "justfile" {
        for line in text.lines() {
            if line.starts_with([' ', '\t', '#', '.']) {
                continue;
            }
            if let Some((target, _)) = line.split_once(':')
                && !target.is_empty()
                && target
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            {
                scripts.push(Script {
                    name: target.into(),
                    command: format!(
                        "{} {}",
                        if name == "Makefile" { "make" } else { "just" },
                        target
                    ),
                    source: path.into(),
                });
            }
        }
    }
    if path.starts_with(".github/workflows/") && (name.ends_with(".yml") || name.ends_with(".yaml"))
    {
        let lines: Vec<_> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let Some(raw) = line.trim().strip_prefix("run:") else {
                continue;
            };
            let indent = line.len() - line.trim_start().len();
            let command = if matches!(raw.trim(), "|" | "|-" | ">" | ">-") {
                lines[i + 1..]
                    .iter()
                    .take_while(|next| {
                        !next.trim().is_empty() && next.len() - next.trim_start().len() > indent
                    })
                    .map(|next| next.trim())
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                raw.trim().trim_matches(['\'', '"']).to_owned()
            };
            if !command.is_empty() {
                scripts.push(Script {
                    name: format!("step:{}", i + 1),
                    command,
                    source: path.into(),
                });
            }
        }
    }
    if (name.starts_with("docker-compose") || name.starts_with("compose"))
        && (name.ends_with(".yml") || name.ends_with(".yaml"))
        && let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(text)
        && let Some(root) = docs.first()
        && let Some(map) = root["services"].as_hash()
    {
        for (key, value) in map {
            if let Some(name) = key.as_str() {
                let path_source = path;
                let path = value["build"]
                    .as_str()
                    .or_else(|| value["build"]["context"].as_str())
                    .map(str::to_owned);
                let image = value["image"].as_str().map(str::to_owned);
                let ports = value["ports"]
                    .as_vec()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| {
                                x.as_str()
                                    .map(str::to_owned)
                                    .or_else(|| x.as_i64().map(|n| n.to_string()))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let depends_on = value["depends_on"]
                    .as_vec()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .or_else(|| {
                        value["depends_on"].as_hash().map(|h| {
                            h.keys()
                                .filter_map(|x| x.as_str().map(str::to_owned))
                                .collect()
                        })
                    })
                    .unwrap_or_default();
                services.push(Service {
                    name: name.into(),
                    source: path_source.into(),
                    path,
                    image,
                    ports,
                    depends_on,
                });
            }
        }
    }
    if name == "Dockerfile" || name.starts_with("Dockerfile.") {
        services.push(Service {
            name: Path::new(path)
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|x| x.to_str())
                .unwrap_or("docker")
                .into(),
            source: path.into(),
            path: Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned()),
            image: text
                .lines()
                .find_map(|l| l.trim().strip_prefix("FROM ").map(str::to_owned)),
            ports: Vec::new(),
            depends_on: Vec::new(),
        });
    }
    if name == "Procfile" {
        for line in text.lines() {
            if let Some((name, _)) = line.split_once(':') {
                services.push(Service {
                    name: name.trim().into(),
                    source: path.into(),
                    path: Path::new(path)
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned()),
                    image: None,
                    ports: Vec::new(),
                    depends_on: Vec::new(),
                });
            }
        }
    }
    (manifest, scripts, services)
}

fn base(path: &str, kind: &str) -> Manifest {
    Manifest {
        path: path.into(),
        kind: kind.into(),
        name: None,
        version: None,
        members: Vec::new(),
        dependencies: Vec::new(),
    }
}
fn strings(v: Option<&toml::Value>) -> Vec<String> {
    v.and_then(toml::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
fn deps_toml(m: &mut Manifest, v: Option<&toml::Value>, dev: bool) {
    if let Some(table) = v.and_then(toml::Value::as_table) {
        for (name, value) in table {
            m.dependencies.push(Dependency {
                name: name.into(),
                requirement: value.as_str().map(str::to_owned).or_else(|| {
                    value
                        .get("version")
                        .and_then(toml::Value::as_str)
                        .map(str::to_owned)
                }),
                dev,
            });
        }
    }
}
fn deps_json(m: &mut Manifest, v: Option<&serde_json::Value>, dev: bool) {
    if let Some(map) = v.and_then(|v| v.as_object()) {
        for (name, value) in map {
            m.dependencies.push(Dependency {
                name: name.into(),
                requirement: value.as_str().map(str::to_owned),
                dev,
            });
        }
    }
}
fn xml_tag(text: &str, tag: &str) -> Option<String> {
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    text.split_once(&start)?
        .1
        .split_once(&end)
        .map(|x| x.0.trim().into())
}
