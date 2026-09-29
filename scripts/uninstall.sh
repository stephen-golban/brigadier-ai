#!/usr/bin/env bash
# Standalone Brigadier uninstaller. Bash 3.2 (the version supplied with macOS) is enough.

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--keep-data] [--dry-run] [--data-dir PATH] [--app-id ID]
                    [--dev] [--app PATH] [-h]

The data directory must already contain brigadier.db and run/. --dev requires
one explicit ai.brigadier.<name> identifier and --data-dir; it never sweeps
other installations. Unmerged branches and dirty worktrees are kept.
EOF
}

say() { printf '%s\n' "$*"; }
error() { printf 'uninstall: %s\n' "$*" >&2; exit 2; }
kept() { KEEP+=("$*"); say "KEEP: $*"; }
uncertain() { UNKNOWN+=("$*"); say "UNCONFIRMED: $*"; }
removed() { REMOVED+=("$*"); say "REMOVED: $*"; }
in_trash() { TRASHED+=("$*"); say "TRASH: $*"; }
run() {
  if (( DRY )); then printf 'DRY RUN:'; printf ' %q' "$@"; printf '\n';
  else "$@"; fi
}

DRY=0 KEEP_DATA=0 DEV=0 ID=ai.brigadier.app ID_EXPLICIT=0 DATA_EXPLICIT=0
DATA=${BRIGADIER_DATA_DIR:-"$HOME/Library/Application Support/Brigadier"}
APP='' APP_EXPLICIT=0
KEEP=() UNKNOWN=() REMOVED=() TRASHED=() REPOS=() WORKTREES=() PLANNED=()
while (( $# )); do
  case "$1" in
    --keep-data) KEEP_DATA=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --dev) DEV=1; shift ;;
    --data-dir|--app-id|--app)
      flag=$1; (( $# >= 2 )) || error "$flag requires a value"
      case "$flag" in
        --data-dir) DATA=$2; DATA_EXPLICIT=1 ;;
        --app-id) ID=$2; ID_EXPLICIT=1 ;;
        --app) APP=$2; APP_EXPLICIT=1 ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) error "unknown option: $1" ;;
  esac
done

case "$ID" in
  ai.brigadier.app)
    (( ! DEV && ID_EXPLICIT )) || error 'the default identifier requires explicit --app-id ai.brigadier.app without --dev' ;;
  ai.brigadier.*)
    [[ "$ID" =~ ^ai\.brigadier\.[A-Za-z0-9_-]+$ ]] || error 'invalid app identifier' ;;
  *) error 'identifier must be ai.brigadier.<name>' ;;
esac
if (( DEV )); then
  (( ID_EXPLICIT && DATA_EXPLICIT )) || error '--dev requires --app-id and --data-dir';
fi
if (( ! APP_EXPLICIT && ! DEV )); then APP=/Applications/Brigadier.app; fi
[[ "$DATA" = /* ]] || error 'data directory must be an absolute path'

# Refuse symlinks in every component; cd -P then removes harmless dot components.
no_symlink_components() {
  local path=$1 part prefix=/
  [[ "$path" = /* ]] || return 1
  IFS=/ read -r -a parts <<< "${path#/}"
  for part in "${parts[@]}"; do
    [[ -z "$part" || "$part" = . ]] && continue
    [[ "$part" != .. ]] || return 1
    prefix="${prefix%/}/$part"
    # macOS itself makes /tmp a link to /private/tmp. Accept that one known
    # alias so a --data-dir /tmp/... can address the same daemon and ledger.
    if [[ "$prefix" = /tmp && "$(readlink /tmp 2>/dev/null)" = private/tmp ]] ||
       [[ "$prefix" = /var && "$(readlink /var 2>/dev/null)" = private/var ]]; then continue; fi
    [[ ! -L "$prefix" ]] || return 1
  done
}
# Device:inode, and owner uid plus permission bits, of a path itself (links not followed).
if [[ "$(uname -s)" = Darwin ]]; then
  file_id() { stat -f '%d:%i' "$1" 2>/dev/null; }
  owner_mode() { stat -f '%u %Lp' "$1" 2>/dev/null; }
else
  file_id() { stat -c '%d:%i' "$1" 2>/dev/null; }
  owner_mode() { stat -c '%u %a' "$1" 2>/dev/null; }
fi
no_symlink_components "$DATA" || error 'data directory contains a symlink or unsafe component'
[[ -d "$DATA" ]] || error 'data directory does not exist'
DATA=$(cd "$DATA" && pwd -L)
[[ "$DATA" != / && "$DATA" != "$HOME" ]] || error 'refusing / or HOME as data directory'
[[ -f "$DATA/brigadier.db" && -d "$DATA/run" ]] || error 'data directory lacks brigadier.db or run/'
[[ ! -L "$DATA/brigadier.db" && ! -L "$DATA/run" ]] || error 'data directory markers must not be symlinks'
[[ -x /usr/bin/sqlite3 ]] || error '/usr/bin/sqlite3 is required'
[[ "$DATA" != *$'\n'* && "$DATA" != *$'\037'* ]] || error 'data directory contains unsupported control characters'
DATA_ID=$(file_id "$DATA") || error 'cannot identify the data directory'
bundle_id() {
  [[ -f "$1/Contents/Info.plist" ]] || return 1
  /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null
}
if [[ -n "$APP" && -e "$APP" ]]; then
  no_symlink_components "$APP" || error 'app bundle path contains a symlink or unsafe component'
  [[ "$(bundle_id "$APP")" = "$ID" ]] || error 'app bundle identifier does not match --app-id'
  APP_ID=$(file_id "$APP") || error 'cannot identify the app bundle'
fi

SQLITE=(/usr/bin/sqlite3 -readonly -noheader -separator $'\037' "$DATA/brigadier.db")
"${SQLITE[@]}" 'SELECT count(*) FROM events' >/dev/null 2>&1 || error 'cannot read the event store'
say "Uninstalling $ID from $DATA"

contains_path() { [[ "$1" = "$DATA"/* ]]; }
valid_external() {
  [[ "$1" = /* && "$1" != *$'\n'* && "$1" != *$'\037'* ]] && no_symlink_components "$1"
}

TRASH_DIR='' DATA_MOVE_ALLOWED=0
# trash PATH [ID]: moves PATH to the Trash if it is still the file ID names (the one checked
# earlier), or, without ID, the one seen when this starts.
trash() {
  local path=$1 expected=${2:-} name dest id
  [[ -e "$path" ]] || return 0
  if (( ! DATA_MOVE_ALLOWED )) && [[ "$DATA" = "$path" || "$DATA" = "$path/"* ]]; then
    uncertain "path contains the data directory and must be resolved separately: $path"
    return 1
  fi
  if ! valid_external "$path" || [[ -L "$path" ]]; then uncertain "unsafe path left in place: $path"; return 1; fi
  id=$(file_id "$path") || { uncertain "cannot identify $path"; return 1; }
  if [[ -n "$expected" && "$id" != "$expected" ]]; then uncertain "changed since it was checked, left in place: $path"; return 1; fi
  if (( DRY )); then TRASHED+=("$path"); say "DRY RUN: move to Trash $path"; return 0; fi
  if [[ -z "$TRASH_DIR" ]]; then
    mkdir -p "$HOME/.Trash" || { uncertain 'cannot create Trash'; return 1; }
    TRASH_DIR=$(mktemp -d "$HOME/.Trash/Brigadier-uninstall.XXXXXXXX") || { uncertain 'cannot create Trash entry'; return 1; }
  fi
  name=${path##*/}; dest="$TRASH_DIR/$name"; local n=1
  while [[ -e "$dest" ]]; do dest="$TRASH_DIR/$name.$n"; ((n++)); done
  if [[ -L "$path" || "$(file_id "$path")" != "$id" ]] || ! no_symlink_components "$path"; then
    uncertain "changed since it was checked, left in place: $path"; return 1
  fi
  if mv "$path" "$dest" && [[ ! -e "$path" ]]; then in_trash "$path -> $dest"; return 0; fi
  uncertain "could not move to Trash: $path"; return 1
}

matching_daemons() {
  local pid exe args
  while read -r pid exe; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$exe" in */brigadierd|brigadierd) ;; *) continue ;; esac
    args=$(ps -o args= -p "$pid" 2>/dev/null) || continue
    case " $args " in *" --data-dir $DATA "*) printf '%s\n' "$pid" ;; esac
  done < <(ps -axo pid=,comm=)
}

# The app first: while it runs it starts its daemon again. An application is identified from
# its containing bundle, never by its process name alone.
APP_RUNNING=0
# `comm` is the executable's whole path, spaces included (a renamed "Brigadier 2.app").
while read -r pid exe; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  case "$exe" in
  */Contents/MacOS/brigadierd) ;; # its daemon is asked next, and only this data directory's
  *.app/Contents/MacOS/*)
    bundle=${exe%/Contents/MacOS/*}
    if [[ "$(bundle_id "$bundle")" = "$ID" ]]; then
      if (( DRY )); then say "DRY RUN: quit app PID $pid ($bundle)"
      else
        kill -TERM "$pid" 2>/dev/null || uncertain "could not quit app PID $pid"
        for ((i=0; i<100; i++)); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$pid" 2>/dev/null; then APP_RUNNING=1; uncertain "app PID $pid is still running"; fi
      fi
    fi ;;
  esac
done < <(ps -axo pid=,comm=)

DAEMON=$(matching_daemons)
if (( DRY )); then
  [[ -z "$DAEMON" ]] || say "DRY RUN: request orderly daemon shutdown for $DATA (PID $(echo $DAEMON))"
else
  daemon_bin=
  if [[ -n "$APP" && -x "$APP/Contents/MacOS/brigadierd" ]]; then daemon_bin="$APP/Contents/MacOS/brigadierd"
  elif command -v brigadierd >/dev/null 2>&1; then daemon_bin=$(command -v brigadierd)
  fi
  quit_code=3
  if [[ -n "$daemon_bin" ]]; then
    "$daemon_bin" quit --data-dir "$DATA"; quit_code=$?
  fi
  DAEMON=$(matching_daemons)
  if (( quit_code != 0 )) && [[ -n "$DAEMON" ]]; then
    for pid in $DAEMON; do
      kill -TERM "$pid" 2>/dev/null || uncertain "cannot SIGTERM daemon PID $pid"
    done
  fi
  for pid in $DAEMON; do
    for ((i=0; i<100; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && uncertain "daemon PID $pid is still running"
  done
  [[ -z "$(matching_daemons)" ]] || uncertain "daemon still serves $DATA"
  [[ -z "$(matching_daemons)" ]] || { say 'Daemon is still running; no files were removed.'; exit 1; }
  if (( quit_code == 1 )) && [[ -z "$DAEMON" ]]; then
    uncertain "daemon shutdown for $DATA could not be confirmed"
    exit 1
  fi
fi

# Only literal paths from cleanup.recorded qualify. Historical removed/completed
# entries are omitted; a later re-record of the same artifact qualifies again.
ledger=$(
  "${SQLITE[@]}" "SELECT json_extract(r.payload,'\$.artifact.type'),
    COALESCE(json_extract(r.payload,'\$.artifact.path'),json_extract(r.payload,'\$.artifact.sessionId'),json_extract(r.payload,'\$.artifact.threadId'),''),
    COALESCE(json_extract(r.payload,'\$.artifact.repo'),'')
    FROM events r WHERE r.stream='cleanup' AND r.kind='cleanup.recorded'
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.stream='cleanup' AND e.seq>r.seq
      AND json_extract(e.payload,'\$.owner')=json_extract(r.payload,'\$.owner')
      AND (e.kind='cleanup.completed' OR
        (e.kind='cleanup.removed' AND EXISTS
          (SELECT 1 FROM json_each(e.payload,'\$.artifacts') a
           WHERE a.value=json_extract(r.payload,'\$.artifact')))))
    GROUP BY r.payload ORDER BY r.seq" 2>/dev/null
) || error 'could not query cleanup ledger'

while IFS=$'\037' read -r type value repo; do
  [[ -n "$type" ]] || continue
  case "$type" in
    worktree)
      if [[ "$value" = "$DATA/worktrees/"* && "$repo" = /* ]] && valid_external "$value" && valid_external "$repo"; then
        WORKTREES+=("$repo"$'\037'"$value")
        found=0
        for known in "${REPOS[@]}"; do [[ "$known" = "$repo" ]] && found=1; done
        (( found )) || REPOS+=("$repo")
      else uncertain "unsafe ledger worktree: $value"; fi ;;
  esac
done <<< "$ledger"

BRANCH_REPOS=()
for item in "${WORKTREES[@]}"; do
  repo=${item%%$'\037'*}; path=${item#*$'\037'}
  if [[ -d "$path" ]]; then
    branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=
    [[ -n "$branch" ]] && BRANCH_REPOS+=("$branch"$'\037'"$repo")
  fi
done

for item in "${WORKTREES[@]}"; do
  repo=${item%%$'\037'*}; path=${item#*$'\037'}
  [[ -e "$path" ]] || continue
  if [[ ! -d "$repo/.git" && ! -f "$repo/.git" ]]; then kept "worktree $path; repository unavailable: $repo"; continue; fi
  if (( DRY )); then
    if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
      kept "worktree $path has changes; resolve it, then run: git -C '$repo' worktree remove '$path'"
    else
      say "DRY RUN: git -C $repo worktree remove $path"
      PLANNED+=("$path")
    fi
    continue
  fi
  if git -C "$repo" worktree remove "$path"; then removed "worktree $path"
  else kept "worktree $path (possibly dirty). Resolve it, then run: git -C '$repo' worktree remove '$path'"; fi
done
for repo in "${REPOS[@]}"; do run git -C "$repo" worktree prune || uncertain "could not prune git worktrees in $repo"; done

# Which branches are Brigadier's, in which repository, and what each one's work lands on (its
# target). A branch qualifies only as recorded, in its recorded repository: first the branches
# kept when their conversation went (bound to the tip they had then), then session branches
# from their session's setup, then task branches with their session's repository.
branches=$(
  "${SQLITE[@]}" "SELECT json_extract(e.payload,'\$.repo'), json_extract(b.value,'\$.name'),
      json_extract(b.value,'\$.target'), json_extract(b.value,'\$.tip'), ''
    FROM events e, json_each(e.payload,'\$.branches') b WHERE e.kind='branches.kept';
    SELECT json_extract(payload,'\$.setup.repo'), json_extract(payload,'\$.setup.environment.branch'),
      json_extract(payload,'\$.setup.environment.base'), '', ''
    FROM events WHERE kind='conversation.setUp'
      AND json_extract(payload,'\$.setup.environment.type')='newWorktree';
    SELECT s.repo, t.branch, t.target, '', t.worktree FROM
      (SELECT json_extract(payload,'\$.task.conversationId') AS conversation,
          json_extract(payload,'\$.task.workspace.branch') AS branch,
          json_extract(payload,'\$.task.workspace.target') AS target,
          json_extract(payload,'\$.task.workspace.worktree') AS worktree, MAX(seq)
        FROM events WHERE kind='task.updated'
        GROUP BY json_extract(payload,'\$.task.id')) t
      LEFT JOIN
      (SELECT json_extract(payload,'\$.id') AS id, json_extract(payload,'\$.setup.repo') AS repo, MAX(seq)
        FROM events WHERE kind='conversation.setUp' GROUP BY json_extract(payload,'\$.id')) s
      ON s.id=t.conversation
      WHERE t.branch IS NOT NULL" 2>/dev/null
) || error 'could not query branch records'
HANDLED_BRANCHES=()
while IFS=$'\037' read -r repo branch target tip worktree; do
  [[ "$branch" = brigadier/* ]] || continue
  [[ "$branch" =~ ^brigadier/[A-Za-z0-9._/-]+$ && "$branch" != *..* ]] || { uncertain "unsafe branch name: $branch"; continue; }
  # A task whose session record is gone: its worktree's ledger record names the repository.
  if [[ -z "$repo" && -n "$worktree" ]]; then
    for item in "${WORKTREES[@]}"; do
      [[ "${item#*$'\037'}" = "$worktree" ]] && repo=${item%%$'\037'*}
    done
  fi
  if [[ -z "$repo" ]] || ! valid_external "$repo" || [[ ! -d "$repo" ]]; then
    uncertain "branch $branch has no confirmed repository; inspect it manually"; continue
  fi
  item="$branch"$'\037'"$repo"
  handled=0
  for known in "${HANDLED_BRANCHES[@]}"; do [[ "$known" = "$item" ]] && handled=1; done
  (( handled )) && continue
  HANDLED_BRANCHES+=("$item")
  current=$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}" 2>/dev/null) || continue
  manual="git -C '$repo' branch -D '$branch'"
  if [[ -n "$tip" && "$current" != "$tip" ]]; then
    kept "branch $branch changed since Brigadier recorded it; delete manually if wanted: $manual"
  elif [[ ! "$target" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ ]]; then
    uncertain "branch $branch has no recorded target; kept. Delete manually if wanted: $manual"
  elif ! target_tip=$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$target^{commit}" 2>/dev/null); then
    uncertain "branch $branch: its target $target is gone; kept. Delete manually if wanted: $manual"
  elif ! git -C "$repo" merge-base --is-ancestor "$current" "$target_tip" 2>/dev/null; then
    kept "unmerged branch $branch; delete manually if wanted: $manual"
  elif (( DRY )); then say "DRY RUN: git -C $repo branch -d $branch"
  elif git -C "$repo" branch -d "$branch"; then removed "merged branch $branch in $repo"
  else uncertain "git refused safe deletion of branch $branch; inspect: git -C '$repo' branch -d '$branch'"; fi
done <<< "$branches"
for item in "${BRANCH_REPOS[@]}"; do
  branch=${item%%$'\037'*}; repo=${item#*$'\037'}
  [[ "$branch" = brigadier/* ]] || continue
  handled=0
  for known in "${HANDLED_BRANCHES[@]}"; do [[ "$known" = "$item" ]] && handled=1; done
  if (( ! handled )) && git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    uncertain "recorded branch $branch has no base; kept. Delete manually if wanted: git -C '$repo' branch -D '$branch'"
  fi
done

CLAUDE_ROOT=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
CODEX_ROOT=${CODEX_HOME:-"$HOME/.codex"}
while IFS=$'\037' read -r type value repo; do
  [[ -n "$type" ]] || continue
  case "$type" in
    claudeSession)
      if [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
        for dir in "$CLAUDE_ROOT"/projects/*; do
          [[ -d "$dir" && ! -L "$dir" ]] || continue
          trash "$dir/$value.jsonl"; trash "$dir/$value"
        done
        trash "$CLAUDE_ROOT/tasks/$value"; trash "$CLAUDE_ROOT/session-env/$value"
        trash "$CLAUDE_ROOT/file-history/$value"; trash "$CLAUDE_ROOT/debug/$value.txt"
        for file in "$CLAUDE_ROOT"/todos/"$value"-*.json; do [[ -e "$file" ]] && trash "$file"; done
      else uncertain "invalid Claude session id: $value"; fi ;;
    claudeProjectDir)
      if [[ "$value" = "$CLAUDE_ROOT/projects/"* ]] && valid_external "$value"; then trash "$value"
      else uncertain "unsafe Claude project path: $value"; fi ;;
    claudeStagingDir)
      if valid_external "$value" && [[ -d "$value" && -z "$(ls -A "$value" 2>/dev/null)" ]]; then
        if (( DRY )); then say "DRY RUN: remove empty staging directory $value"
        elif rmdir "$value"; then removed "$value"
        else uncertain "could not remove empty staging directory $value"; fi
      elif [[ -e "$value" ]]; then uncertain "Claude staging directory is not empty: $value"; fi ;;
    codexGeneratedImages)
      if [[ "$value" = "$CODEX_ROOT/generated_images/"* ]] && valid_external "$value"; then trash "$value"
      else uncertain "unsafe Codex image path: $value"; fi ;;
    codexThread)
      if [[ "$value" =~ ^[A-Fa-f0-9-]{36}$ ]]; then
        for file in "$CODEX_ROOT"/sessions/*/*/*/rollout-*"$value".jsonl; do [[ -e "$file" ]] && trash "$file"; done
        uncertain "Codex state DB row for thread $value must be checked in Codex"
      else uncertain "invalid Codex thread id: $value"; fi ;;
    codexProjectTrust) uncertain "Codex config.toml trust entry for $value must be checked manually" ;;
    claudeTempDir)
      if [[ "$value" = /tmp/brigadier-* ]] && valid_external "$value"; then trash "$value"
      else uncertain "unsafe recorded temp path: $value"; fi ;;
  esac
done <<< "$ledger"

if [[ "$ID" = ai.brigadier.app && -e /etc/sudoers.d/brigadier-lid-closed ]]; then
  run sudo rm /etc/sudoers.d/brigadier-lid-closed || uncertain 'could not remove lid-closed sudoers rule'
fi
if command -v tccutil >/dev/null 2>&1; then
  run tccutil reset Microphone "$ID" || uncertain "microphone permission reset failed for $ID"
else uncertain 'tccutil unavailable; microphone permission was not reset'; fi

if [[ "$(uname -s)" = Darwin ]]; then
  for path in "$HOME/Library/Caches/$ID" "$HOME/Library/WebKit/$ID" \
    "$HOME/Library/HTTPStorages/$ID" "$HOME/Library/HTTPStorages/$ID.binarycookies" \
    "$HOME/Library/Preferences/$ID.plist" "$HOME/Library/Saved Application State/$ID.savedState" \
    "$HOME/Library/Logs/$ID" "$HOME/Library/Application Support/$ID"; do trash "$path"; done
  for key in DARWIN_USER_CACHE_DIR DARWIN_USER_TEMP_DIR; do
    root=$(getconf "$key" 2>/dev/null) || { uncertain "cannot resolve $key"; continue; }
    [[ "$root" = /* ]] && trash "${root%/}/$ID"
  done
else
  trash "${XDG_CACHE_HOME:-$HOME/.cache}/$ID"
  trash "${XDG_CONFIG_HOME:-$HOME/.config}/$ID"
  trash "${XDG_DATA_HOME:-$HOME/.local/share}/$ID"
fi

for path in /tmp/brigadier-*; do
  # Only Brigadier's own session temp folders: brigadier-<12 lowercase hex>, this user's, 0700.
  [[ "${path#/tmp/}" =~ ^brigadier-[0-9a-f]{12}$ ]] || continue
  [[ -d "$path" && ! -L "$path" && -f "$path/.brigadier-owner" && ! -L "$path/.brigadier-owner" ]] || continue
  [[ "$(owner_mode "$path")" = "$(id -u) 700" ]] || continue
  owner_data=$(sed -n '2p' "$path/.brigadier-owner")
  [[ "$owner_data" = "$DATA" ]] && trash "$path"
done

# A remaining worktree blocks the parent data directory, even with --keep-data.
remaining=0
if [[ -d "$DATA/worktrees" ]]; then
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    planned=0
    if (( DRY )); then
      for item in "${PLANNED[@]}"; do [[ "$item" = "$path" ]] && planned=1; done
    fi
    (( planned )) && continue
    remaining=1
    repo=
    for item in "${WORKTREES[@]}"; do
      [[ "${item#*$'\037'}" = "$path" ]] && repo=${item%%$'\037'*}
    done
    if [[ -n "$repo" ]]; then
      kept "remaining worktree $path; resolve and run: git -C '$repo' worktree remove '$path'"
    else kept "unrecorded worktree $path; inspect before removing it"; fi
  done < <(find "$DATA/worktrees" -mindepth 2 -maxdepth 2 -type d -print 2>/dev/null)
fi
for file in "$DATA/run/brigadierd.sock" "$DATA/run/brigadierd.lock" "$DATA/run/ipc.token"; do
  [[ -e "$file" || -L "$file" ]] || continue
  if (( DRY )); then say "DRY RUN: remove runtime file $file"
  elif [[ ! -L "$file" ]] && rm -f "$file"; then removed "$file"
  else uncertain "runtime file left: $file"; fi
done
if (( KEEP_DATA )); then kept "data directory $DATA (--keep-data)"
elif (( remaining )); then kept "data directory $DATA (worktrees remain)"
else
  DATA_MOVE_ALLOWED=1
  trash "$DATA" "$DATA_ID"
fi
if [[ -n "$APP" && -e "$APP" ]]; then
  if (( APP_RUNNING )); then kept "app bundle $APP (process still running)"
  else trash "$APP" "${APP_ID:-}"; fi
fi

say ''; say 'Summary:'
say "  Removed directly: ${#REMOVED[@]}"
if (( DRY )); then say "  Would move to Trash: ${#TRASHED[@]}"
else say "  Moved to Trash: ${#TRASHED[@]} (empty Trash to reclaim space)"; fi
say "  Kept: ${#KEEP[@]}"
say "  Unconfirmed: ${#UNKNOWN[@]}"
if (( remaining || ${#UNKNOWN[@]} )); then exit 1; fi
