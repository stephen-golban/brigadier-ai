use super::*;
use std::collections::BTreeSet;

/// Compose owned changes only; never restore the oldest whole workspace tree.
/// Complete continuous net-zero path segments are cancelled before checking manual edits.
pub fn plan_restore(epochs: &[Epoch], current: Snapshot) -> Result<RestorePlan> {
    if epochs.is_empty() {
        return Err(unavailable("This message has no workspace checkpoints"));
    }
    for epoch in epochs {
        let post = epoch
            .post
            .as_ref()
            .ok_or_else(|| unavailable("Workspace checkpoint is incomplete"))?;
        if let Some(why) = &epoch.error {
            return Err(unavailable(why));
        }
        for snap in [&epoch.pre, post] {
            if snap.root != current.root
                || snap.identity != current.identity
                || snap.coverage != current.coverage
            {
                return Err(unavailable(
                    "Workspace identity or checkpoint coverage changed",
                ));
            }
            if snap.git != current.git {
                return Err(unavailable(
                    "Git HEAD, index or ignore policy changed; file rewind is unavailable",
                ));
            }
        }
    }
    let mut target = current.files.clone();
    let names: BTreeSet<_> = epochs
        .iter()
        .flat_map(|e| {
            e.pre
                .files
                .keys()
                .chain(e.post.as_ref().unwrap().files.keys())
        })
        .cloned()
        .collect();
    let mut conflicts = BTreeSet::new();
    for path in names {
        if !valid_path(&path) {
            return Err(unavailable("Invalid checkpoint path"));
        }
        let mut segments = Vec::new();
        let mut segment: Vec<(Option<&PathState>, Option<&PathState>)> = Vec::new();
        for epoch in epochs {
            let pre = epoch.pre.files.get(&path);
            let post = epoch.post.as_ref().unwrap().files.get(&path);
            if segment.last().is_some_and(|(_, last)| *last != pre) {
                segments.push(std::mem::take(&mut segment));
            }
            segment.push((pre, post));
        }
        segments.push(segment);
        'segments: for segment in segments.iter().rev() {
            if segment.first().unwrap().0 == segment.last().unwrap().1 {
                continue;
            }
            for &(pre, post) in segment.iter().rev() {
                let value = target.get(&path);
                if pre == post || value == pre {
                    continue;
                }
                if value != post {
                    conflicts.insert(path.clone());
                    break 'segments;
                }
                match pre {
                    Some(state) => {
                        target.insert(path.clone(), state.clone());
                    }
                    None => {
                        target.remove(&path);
                    }
                }
            }
        }
    }
    // A file/link cannot simultaneously be a parent of another target entry.
    for name in target.keys() {
        let mut parent = std::path::Path::new(name).parent();
        while let Some(p) = parent {
            if target.contains_key(&p.to_string_lossy().to_string()) {
                conflicts.insert(name.clone());
            }
            parent = p.parent();
        }
    }
    let all: BTreeSet<_> = target.keys().chain(current.files.keys()).cloned().collect();
    let changes = all
        .into_iter()
        .filter_map(|path| {
            let before = current.files.get(&path).cloned();
            let after = target.get(&path).cloned();
            (before != after).then_some(Change {
                path,
                before,
                after,
            })
        })
        .collect();
    Ok(RestorePlan {
        current,
        target,
        changes,
        conflicts: conflicts.into_iter().collect(),
    })
}

/// Apply a session delta onto another workspace. Divergent paths are explicit conflicts.
/// Unrelated project edits, staged state and the source checkout are preserved.
pub fn plan_apply(base: &Manifest, changed: &Manifest, current: Snapshot) -> Result<RestorePlan> {
    let mut target = current.files.clone();
    let mut conflicts = Vec::new();
    for path in base.keys().chain(changed.keys()).collect::<BTreeSet<_>>() {
        let before = base.get(path);
        let after = changed.get(path);
        if before == after || current.files.get(path) == after {
            continue;
        }
        if current.files.get(path) != before {
            conflicts.push(path.clone());
            continue;
        }
        match after {
            Some(value) => {
                target.insert(path.clone(), value.clone());
            }
            None => {
                target.remove(path);
            }
        }
    }
    for path in target.keys() {
        let mut parent = std::path::Path::new(path).parent();
        while let Some(at) = parent {
            if target.contains_key(&at.to_string_lossy().to_string()) {
                conflicts.push(path.clone());
            }
            parent = at.parent();
        }
    }
    let changes = target
        .keys()
        .chain(current.files.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|path| {
            let before = current.files.get(path).cloned();
            let after = target.get(path).cloned();
            (before != after).then_some(Change {
                path: path.clone(),
                before,
                after,
            })
        })
        .collect();
    Ok(RestorePlan {
        current,
        target,
        changes,
        conflicts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(values: &[(&str, &str)]) -> Snapshot {
        Snapshot {
            id: "s".into(),
            root: "/workspace".into(),
            identity: "1:2".into(),
            tree: "tree".into(),
            files: values
                .iter()
                .map(|(p, v)| {
                    (
                        p.to_string(),
                        PathState {
                            oid: v.to_string(),
                            mode: "100644".into(),
                            bytes: 1,
                            metadata: None,
                        },
                    )
                })
                .collect(),
            git: GitState {
                head: "h".into(),
                index: vec![],
                policy: vec![],
            },
            coverage: Coverage::default(),
        }
    }
    fn epoch(pre: Snapshot, post: Snapshot) -> Epoch {
        Epoch {
            turn_id: "t".into(),
            pre,
            post: Some(post),
            error: None,
        }
    }
    #[test]
    fn net_zero_preserves_later_manual_work() {
        let a = snapshot(&[("a", "A")]);
        let b = snapshot(&[("a", "B")]);
        let d = snapshot(&[("a", "D")]);
        let p = plan_restore(&[epoch(a.clone(), b.clone()), epoch(b, a)], d).unwrap();
        assert!(p.conflicts.is_empty());
        assert!(p.changes.is_empty());
    }
    #[test]
    fn idle_manual_gap_cannot_be_cancelled() {
        let a = snapshot(&[("a", "A")]);
        let b = snapshot(&[("a", "B")]);
        let c = snapshot(&[("a", "C")]);
        let p = plan_restore(&[epoch(a.clone(), b), epoch(c, a.clone())], a).unwrap();
        assert_eq!(p.conflicts, vec!["a"]);
    }
    #[test]
    fn preserves_unrelated_manual_and_recognizes_partial_undo() {
        let a = snapshot(&[("a", "A"), ("manual", "M0")]);
        let b = snapshot(&[("a", "B"), ("manual", "M0")]);
        let c = snapshot(&[("a", "B"), ("manual", "M1")]);
        let d = snapshot(&[("a", "C"), ("manual", "M1")]);
        let p = plan_restore(&[epoch(a.clone(), b.clone()), epoch(c, d.clone())], d).unwrap();
        assert!(p.conflicts.is_empty());
        assert_eq!(p.target["manual"].oid, "M1");
        assert_eq!(p.changes.len(), 1);
        let p = plan_restore(
            &[
                epoch(a, b.clone()),
                epoch(b.clone(), snapshot(&[("a", "C"), ("manual", "M0")])),
            ],
            b,
        )
        .unwrap();
        assert!(p.conflicts.is_empty());
        assert_eq!(p.target["a"].oid, "A");
    }
    #[test]
    fn missing_and_empty_and_mode_changes_are_real() {
        let a = snapshot(&[]);
        let mut b = snapshot(&[("empty", "")]);
        b.files.get_mut("empty").unwrap().bytes = 0;
        let p = plan_restore(&[epoch(a, b.clone())], b).unwrap();
        assert_eq!(p.changes.len(), 1);
        assert!(p.changes[0].after.is_none());
        let a = snapshot(&[("x", "same")]);
        let mut b = a.clone();
        b.files.get_mut("x").unwrap().mode = "100755".into();
        assert_eq!(
            plan_restore(&[epoch(a, b.clone())], b)
                .unwrap()
                .changes
                .len(),
            1
        );
    }
    #[test]
    fn incomplete_and_git_changed_never_mean_zero() {
        let a = snapshot(&[]);
        let mut e = epoch(a.clone(), a.clone());
        e.post = None;
        assert!(plan_restore(&[e], a.clone()).is_err());
        let mut b = a.clone();
        b.git.head = "changed".into();
        assert!(plan_restore(&[epoch(a.clone(), a)], b).is_err());
    }
}
