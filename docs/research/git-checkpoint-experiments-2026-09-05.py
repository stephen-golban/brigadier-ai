"""Disposable Git research only; never accepts an owner workspace argument.

Run with python3; creates a fresh TemporaryDirectory and prints JSON evidence.
This is not production capture/restore code (no race-safe I/O or durable journal).
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import tempfile
import time


with tempfile.TemporaryDirectory(prefix="brigadier-checkpoint-research-") as tmp:
    root = Path(tmp)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    hooks = root / "empty-hooks"
    hooks.mkdir()
    results = {}

    def git(cwd, *args, data=None, index=None, check=True):
        e = dict(env)
        if index is not None:
            e["GIT_INDEX_FILE"] = str(index)
        p = subprocess.run(["git", "-c", "core.fsmonitor=false", "-c",
                            f"core.hooksPath={hooks}", "-c", "gc.auto=0",
                            "-C", str(cwd), *map(str, args)], input=data,
                           capture_output=True, env=e)
        if check and p.returncode:
            raise RuntimeError((args, p.returncode, p.stderr.decode(errors="replace")))
        return p

    def init(name, bare=False):
        p = root / name
        p.mkdir()
        git(p, "init", "--template=", *(["--bare"] if bare else []))
        if not bare:
            git(p, "config", "user.name", "Disposable Research")
            git(p, "config", "user.email", "research@example.invalid")
        return p

    def commit(repo):
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "fixture")

    def state(repo):
        idx = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index").stdout.decode().strip())
        return dict(head=git(repo, "rev-parse", "HEAD").stdout.decode().strip(),
                    branch=git(repo, "symbolic-ref", "-q", "HEAD", check=False).stdout.decode().strip(),
                    index_sha256=hashlib.sha256(idx.read_bytes()).hexdigest())

    def entries(repo, tree):
        return {r.split(b"\t", 1)[1].decode(errors="surrogateescape"):
                tuple(r.split(b"\t", 1)[0].decode().split()[::2])
                for r in git(repo, "ls-tree", "-rz", tree).stdout.split(b"\0") if r}

    def scan(work):
        found = {}
        for base, dirs, files in os.walk(work, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d != ".git")
            for d in list(dirs):
                p = Path(base) / d
                if p.is_symlink():
                    dirs.remove(d)
                    files.append(d)
                elif (p / ".git").exists():
                    dirs.remove(d)  # nested repos are unsupported by this fixture scanner
            for name in sorted(files):
                if name == ".git":
                    continue
                p = Path(base) / name
                s = p.lstat()
                if stat.S_ISLNK(s.st_mode):
                    mode, data = "120000", os.fsencode(os.readlink(p))
                elif stat.S_ISREG(s.st_mode):
                    mode, data = ("100755" if s.st_mode & 0o111 else "100644"), p.read_bytes()
                else:
                    continue
                found[p.relative_to(work).as_posix()] = (mode, data)
        return found

    def snapshot(work, store, tag):
        index = root / (tag + ".index")
        git(store, "read-tree", "--empty", index=index)
        records = b""
        manifest = scan(work)
        for name, (mode, data) in manifest.items():
            oid = git(store, "hash-object", "-w", "--stdin", "--no-filters", data=data).stdout.strip()
            records += mode.encode() + b" " + oid + b"\t" + os.fsencode(name) + b"\0"
        git(store, "update-index", "-z", "--index-info", data=records, index=index)
        tree = git(store, "write-tree", index=index).stdout.decode().strip()
        git(store, "update-ref", f"refs/checkpoints/{tag}", tree, "0" * len(tree))
        return tree, manifest

    repo = init("owner-fixture")
    (repo / "tracked").write_bytes(b"committed\n")
    (repo / ".gitignore").write_text("ignored\n")
    (repo / "empty").write_bytes(b"")
    (repo / "delete").write_text("delete me")
    commit(repo)
    (repo / "tracked").write_bytes(b"staged\n")
    git(repo, "add", "tracked")
    (repo / "tracked").write_bytes(b"staged plus unstaged\n")
    (repo / "untracked").write_text("manual draft")
    (repo / "ignored").write_text("ignored fixture")
    before = state(repo)
    alt = root / "alternate.index"
    git(repo, "read-tree", "HEAD", index=alt)
    git(repo, "add", "-A", index=alt)
    alt_tree = git(repo, "write-tree", index=alt).stdout.decode().strip()
    git(repo, "update-ref", "refs/brigadier/research", alt_tree)
    alt_entries = entries(repo, alt_tree)
    assert state(repo) == before
    assert "untracked" in alt_entries and "ignored" not in alt_entries
    results["alternate_index"] = dict(head_branch_index_preserved=True,
        included_untracked=True, omitted_ignored=True,
        staged_blob=git(repo, "show", ":tracked").stdout.decode(),
        captured_blob=git(repo, "show", f"{alt_tree}:tracked").stdout.decode())

    store = init("snapshots.git", bare=True)
    (repo / "binary").write_bytes(bytes(range(256)))
    (repo / "crlf").write_bytes(b"a\r\nb\r\n")
    (repo / "exec").write_text("#!/bin/sh\n")
    (repo / "exec").chmod(0o755)
    (repo / "link").symlink_to("../outside")
    (root / "outside").write_text("outside sentinel")
    (repo / "empty-dir").mkdir()
    (repo / "line\nbreak\tfile").write_text("odd path")
    base_tree, base = snapshot(repo, store, "pre")
    assert state(repo) == before
    raw_entries = entries(store, base_tree)
    for name, (mode, data) in base.items():
        assert raw_entries[name][0] == mode
        assert git(store, "cat-file", "blob", raw_entries[name][1]).stdout == data
    assert "empty-dir" not in raw_entries
    results["raw_fidelity"] = dict(files=len(base), raw_roundtrip=True,
        ignored_included_by_explicit_scanner=True, empty_directory_omitted=True,
        outside_untouched=(root / "outside").read_text() == "outside sentinel",
        newline_tab_path=True, modes={n: raw_entries[n][0] for n in ["exec", "link", "empty"]})

    (repo / "tracked").write_text("agent via shell\n")
    (repo / "empty").unlink()
    (repo / "delete").rename(repo / "renamed")
    (repo / "binary").write_bytes(b"\0new\xff")
    (repo / "exec").chmod(0o644)
    (repo / "created").write_bytes(b"")
    end_tree, end = snapshot(repo, store, "end")
    diff = git(store, "diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", base_tree, end_tree).stdout.decode()
    assert all(n in diff for n in ["tracked", "empty", "delete", "renamed", "binary", "exec", "created"])
    results["changes"] = dict(path_status=diff, empty_file_deletion_and_creation_detected=True)
    unchanged_tree, _ = snapshot(repo, store, "identical")
    assert end_tree == unchanged_tree
    (repo / "tracked").write_text("temporary write")
    (repo / "tracked").write_bytes(end["tracked"][1])
    undone_tree, _ = snapshot(repo, store, "undone")
    assert end_tree == undone_tree
    results["no_op"] = dict(identical_writes_same_tree=True, write_then_undo_same_tree=True)

    # Pure path-level restore planner: expected end versus current, target=pre.
    def plan(target, expected, current):
        actions, conflicts = {}, []
        for name in target.keys() | expected.keys():
            a, b, c = target.get(name), expected.get(name), current.get(name)
            if a == b or c == a:
                continue
            if c == b:
                actions[name] = a
            else:
                conflicts.append(name)
        return actions, sorted(conflicts)

    (repo / "unrelated-manual").write_text("keep me")
    actions, conflicts = plan(base, end, scan(repo))
    assert not conflicts and "unrelated-manual" not in actions
    recovery_tree, recovery = snapshot(repo, store, "recovery")
    for name, target in actions.items():
        p = repo / name
        if p.exists() or p.is_symlink():
            p.unlink()
        if target is not None:
            mode, data = target
            if mode == "120000":
                p.symlink_to(os.fsdecode(data))
            else:
                p.write_bytes(data)
                p.chmod(0o755 if mode == "100755" else 0o644)
    assert state(repo) == before
    assert all(scan(repo).get(k) == v for k, v in base.items())
    assert (repo / "unrelated-manual").read_text() == "keep me"
    results["guarded_restore"] = dict(actions=len(actions), restored_baseline=True,
        original_staged_and_unstaged_preserved=True, unrelated_manual_preserved=True,
        recovery_tree=recovery_tree)
    c = dict(end)
    c["tracked"] = ("100644", b"later overlapping manual edit")
    assert "tracked" in plan(base, end, c)[1]
    c["tracked"] = base["tracked"]
    assert "tracked" not in plan(base, end, c)[0]
    results["conflicts"] = dict(overlapping_manual_blocked=True, already_restored_is_no_op=True)

    # Separate per-turn boundaries preserve an idle manual change to an unrelated path.
    a = {"agent": ("100644", b"A"), "manual": ("100644", b"M0")}
    b = dict(a, agent=("100644", b"B"))
    c = dict(b, manual=("100644", b"M1"))
    d = dict(c, agent=("100644", b"C"))
    virtual = dict(d)
    for pre, post in [(c, d), (a, b)]:
        acts, conflicts = plan(pre, post, virtual)
        assert not conflicts
        virtual.update(acts)
    assert virtual == dict(a, manual=("100644", b"M1"))
    # Aggregate baseline->end would incorrectly restore manual M1 to M0.
    assert "manual" in plan(a, d, d)[0]
    results["per_turn_boundaries"] = dict(reverse_turn_deltas_preserve_idle_manual=True,
        baseline_to_latest_would_erase_idle_manual=True)
    virtual = dict(a)
    for pre, post in [(b, a), (a, b)]:
        acts, conflicts = plan(pre, post, virtual)
        assert not conflicts
        virtual.update(acts)
    assert virtual == a
    results["per_turn_boundaries"]["two_turn_change_then_undo_has_empty_final_plan"] = True

    # Coalesce continuous per-path epochs before comparing to later manual state.
    # Otherwise A->B->A can falsely conflict with later manual D despite net zero.
    def composed_plan(epochs, current):
        virtual, conflicts = dict(current), []
        names = set().union(*(pre.keys() | post.keys() for pre, post in epochs))
        for name in names:
            segments = []
            active = [(epochs[0][0].get(name), epochs[0][1].get(name))]
            for pre, post in epochs[1:]:
                if pre.get(name) != active[-1][1]:
                    segments.append(active)
                    active = []
                active.append((pre.get(name), post.get(name)))
            segments.append(active)
            for segment in reversed(segments):
                if segment[0][0] == segment[-1][1]:
                    continue
                failed = False
                for first, last in reversed(segment):
                    value = virtual.get(name)
                    if first == last or value == first:
                        continue
                    if value != last:
                        conflicts.append(name)
                        failed = True
                        break
                    if first is None:
                        virtual.pop(name, None)
                    else:
                        virtual[name] = first
                if failed:
                    break
        return virtual, sorted(set(conflicts))

    later = dict(a, agent=("100644", b"D manual"))
    candidate, conflicts = composed_plan([(a, b), (b, a)], later)
    assert not conflicts and candidate == later
    gap = dict(b, agent=("100644", b"C manual"))
    _, conflicts = composed_plan([(a, b), (gap, a)], a)
    assert conflicts == ["agent"]
    candidate, conflicts = composed_plan([(a, b), (c, d)], d)
    assert not conflicts and candidate == dict(a, manual=("100644", b"M1"))
    candidate, conflicts = composed_plan([(a, b), (b, d)], b)
    assert not conflicts and candidate == a
    results["per_turn_boundaries"].update(
        continuous_net_zero_preserves_later_divergent_manual=True,
        same_path_idle_gap_not_coalesced=True,
        composed_plan_preserves_unrelated_idle_manual=True,
        nonzero_segment_preserves_partial_undo_handling=True)

    # A source index flag can hide a physical edit from ordinary git add.
    flagged = init("flagged-index")
    (flagged / "a").write_text("original")
    commit(flagged)
    git(flagged, "update-index", "--assume-unchanged", "a")
    (flagged / "a").write_text("changed")
    git(flagged, "add", "-A")
    assert git(flagged, "show", ":a").stdout == b"original"
    flagged_tree, _ = snapshot(flagged, store, "flagged-raw")
    assert git(store, "cat-file", "blob", entries(store, flagged_tree)["a"][1]).stdout == b"changed"
    results["index_flags"] = dict(assume_unchanged_hid_edit_from_add=True,
        raw_scanner_detected_edit=True)

    unborn = init("unborn")
    (unborn / "draft").write_bytes(b"before initial commit")
    unborn_tree, _ = snapshot(unborn, store, "unborn")
    plain = root / "not-a-repository"
    plain.mkdir()
    (plain / "draft").write_bytes(b"before initial commit")
    plain_tree, _ = snapshot(plain, store, "plain")
    assert unborn_tree == plain_tree
    results["workspace_without_head"] = dict(unborn_and_non_git_directory_capture=True)

    # Standard git add normalizes data and can execute a configured clean filter.
    filt = init("filters")
    marker = root / "filter-ran"
    script = root / "filter.sh"
    script.write_text(f"#!/bin/sh\ncat >/dev/null\necho yes >> '{marker}'\nprintf FILTERED\n")
    script.chmod(0o755)
    git(filt, "config", "filter.fixture.clean", str(script))
    (filt / ".gitattributes").write_text("payload filter=fixture\ncrlf text eol=lf\n")
    (filt / "payload").write_bytes(b"raw content")
    (filt / "crlf").write_bytes(b"x\r\n")
    git(filt, "add", "-A")
    assert marker.exists()
    assert git(filt, "show", ":payload").stdout == b"FILTERED"
    assert git(filt, "show", ":crlf").stdout == b"x\n"
    marker.unlink()
    ft, fm = snapshot(filt, store, "filter-raw")
    assert not marker.exists()
    assert git(store, "cat-file", "blob", entries(store, ft)["crlf"][1]).stdout == b"x\r\n"
    results["filters"] = dict(git_add_executed_clean=True, git_add_normalized_crlf=True,
        raw_snapshot_no_filter_execution=True, raw_preserved_crlf=True)

    linked = root / "linked"
    git(repo, "worktree", "add", "-b", "fixture-linked", linked, "HEAD")
    assert git(linked, "rev-parse", "refs/brigadier/research").stdout.decode().strip() == alt_tree
    assert state(linked)["index_sha256"] != before["index_sha256"]
    results["linked_worktree"] = dict(custom_ref_shared=True,
        main_index_path=git(repo, "rev-parse", "--git-path", "index").stdout.decode().strip(),
        linked_index_path=git(linked, "rev-parse", "--git-path", "index").stdout.decode().strip())
    # Changes to Git history do not invalidate stored bytes, but are a restore policy guard.
    pre_commit_state = state(linked)
    (linked / "tracked").write_text("provider committed content")
    commit(linked)
    git(linked, "switch", "-c", "provider-changed-branch")
    assert pre_commit_state != state(linked)
    assert git(store, "cat-file", "-t", base_tree).stdout == b"tree\n"
    results["provider_git_changes"] = dict(head_and_branch_change_detected=True,
        old_raw_tree_still_readable=True)

    nested = init("submodule-source")
    (nested / "inner").write_text("inner initial")
    commit(nested)
    parent = init("submodule-parent")
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", nested, "sub")
    commit(parent)
    old = git(parent, "write-tree").stdout
    (parent / "sub" / "inner").write_text("dirty nested bytes")
    (parent / "sub" / "untracked").write_text("new nested")
    git(parent, "add", "-A")
    assert git(parent, "write-tree").stdout == old
    results["submodule"] = dict(parent_tree_unchanged_despite_dirty_nested_content=True,
        parent_entry_mode=entries(parent, old.decode().strip())["sub"][0])

    # Ref CAS and multi-ref rejection. GC here is ONLY in disposable bare store.
    wrong = "0" * len(base_tree)
    cas = git(store, "update-ref", "refs/checkpoints/pre", end_tree, wrong, check=False)
    assert cas.returncode != 0
    tx = (f"start\nupdate refs/checkpoints/pre {end_tree} {wrong}\n"
          f"create refs/checkpoints/transaction-other {end_tree}\nprepare\ncommit\n").encode()
    rejected = git(store, "update-ref", "--stdin", data=tx, check=False)
    assert rejected.returncode != 0
    assert git(store, "show-ref", "--verify", "refs/checkpoints/transaction-other", check=False).returncode != 0
    orphan = git(store, "hash-object", "-w", "--stdin", data=b"unique orphan").stdout.decode().strip()
    git(store, "gc", "--prune=now")
    assert git(store, "cat-file", "-t", base_tree).stdout == b"tree\n"
    assert git(store, "cat-file", "-t", orphan, check=False).returncode != 0
    results["refs_gc"] = dict(stale_cas_rejected=True, failed_transaction_created_no_other_ref=True,
        tree_ref_survived_gc=True, unreferenced_blob_pruned=True)

    # Deterministic counterexample: a Git tree need never have existed all at once.
    pair = root / "pair"
    pair.mkdir()
    (pair / "a").write_text("0")
    (pair / "b").write_text("0")
    captured_a = (pair / "a").read_text()
    (pair / "a").write_text("1")
    (pair / "b").write_text("1")
    captured_b = (pair / "b").read_text()
    assert (captured_a, captured_b) == ("0", "1")
    results["snapshot_race"] = dict(captured=[captured_a, captured_b],
        actual_states=[["0", "0"], ["1", "0"], ["1", "1"]], atomic_snapshot=False)

    # Illustrative local timing: 1,000 x 1 KiB synthetic files; batch raw hashing.
    bench = root / "bench"
    bench.mkdir()
    for i in range(1000):
        (bench / f"f{i:04d}").write_bytes((f"{i:04d}:".encode() + b"x" * 1019))
    names = sorted(bench.iterdir())
    bt = []
    byte_sizes = []
    for run in range(3):
        start = time.perf_counter()
        ids = git(store, "hash-object", "-w", "--no-filters", "--stdin-paths",
                  data=("\n".join(map(str, names)) + "\n").encode()).stdout.splitlines()
        ix = root / "bench.index"
        git(store, "read-tree", "--empty", index=ix)
        data = b"".join(b"100644 " + oid + b"\t" + p.name.encode() + b"\0" for p, oid in zip(names, ids))
        git(store, "update-index", "-z", "--index-info", data=data, index=ix)
        tree = git(store, "write-tree", index=ix).stdout.decode().strip()
        git(store, "update-ref", f"refs/checkpoints/bench-{run}", tree)
        bt.append(round((time.perf_counter() - start) * 1000, 2))
        byte_sizes.append(sum(p.stat().st_size for p in (store / "objects").rglob("*") if p.is_file()))
    assert len(set(byte_sizes)) == 1
    results["performance"] = dict(files=1000, bytes=1024000, run_ms=bt,
        object_store_bytes_after_each_identical_snapshot=byte_sizes,
        caveat="Synthetic warm local filesystem, no durability fsync; batch paths exclude newlines")
    results["environment"] = dict(git=git(root, "--version").stdout.decode().strip(),
        platform=platform.platform(), python=platform.python_version(), disposable_only=True)
    print(json.dumps(results, indent=2, ensure_ascii=True))
