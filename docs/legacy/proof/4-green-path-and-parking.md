# brigadier: the green path, and a parked run

Run 2026-08-31T09:52:48Z, against real workers.

## A — every piece merges, and `bun test` passes on the merged result

```
run       20260831-095248-2dfb  detached, 4 pieces
width     min(3 independent pieces, cap 4, memory allows 12) = 3, bound by independent pieces
check in  brigadier status 20260831-095248-2dfb
```

```
run       20260831-095248-2dfb  done
goal      Implement three string helpers and a barrel that re-exports them.
repo      /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/strutil  (never written to; results land on refs/brigadier/20260831-095248-2dfb/<piece>)
width     min(3 independent pieces, cap 4, memory allows 12) = 3, bound by independent pieces
  merged   slugify  5 turns, 71873 tokens
           refs/brigadier/20260831-095248-2dfb/slugify
  merged   truncate  4 turns, 56303 tokens
           refs/brigadier/20260831-095248-2dfb/truncate
  merged   title-case  6 turns, 87635 tokens
           refs/brigadier/20260831-095248-2dfb/title-case
  merged   index-barrel  6 turns, 88547 tokens
           refs/brigadier/20260831-095248-2dfb/index-barrel

verify    `bun test` on the merged result: exit 0

left behind (nothing is deleted):
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095248-2dfb/_merged
  /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/strutil refs/brigadier/20260831-095248-2dfb/merged
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095248-2dfb/slugify
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095248-2dfb/truncate
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095248-2dfb/title-case
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095248-2dfb/index-barrel
```

Tree fingerprint before `4de4f8c803c741a89d364505fb50396fa0a370bf103451e9590d2b31f316d67d`, after `4de4f8c803c741a89d364505fb50396fa0a370bf103451e9590d2b31f316d67d` — identical.

Verify ran on the merged result, not on any piece alone. Each piece passed its own
work order in isolation; only the merge could tell whether they compose.

## B — a worker's question parks the run, and `resume` continues it

```
run       20260831-095329-6d9e  detached, 1 pieces
width     min(1 independent pieces, cap 4, memory allows 12) = 1, bound by independent pieces
check in  brigadier status 20260831-095329-6d9e
```

### The run parked. The question reaches the user in their own conversation, verbatim.

```
run       20260831-095329-6d9e  parked
goal      Set the project's default locale.
repo      /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/locale  (never written to; results land on refs/brigadier/20260831-095329-6d9e/<piece>)
width     min(1 independent pieces, cap 4, memory allows 12) = 1, bound by independent pieces
  parked   locale  1 turns, 13586 tokens

parked    locale asked, in its own words:
          "Should `DEFAULT_LOCALE` in src/locale.ts be "en-GB" or "en-US"? The repo doesn't record a preference, and the choice changes date and currency formatting throughout."
          continue with: brigadier resume 20260831-095329-6d9e --answer "<their answer>"
```

### The user answers, and the run continues

```
$ brigadier resume 20260831-095329-6d9e --answer "en-GB"
run       20260831-095329-6d9e  resumed, detached
check in  brigadier status 20260831-095329-6d9e
```

```
run       20260831-095329-6d9e  done
goal      Set the project's default locale.
repo      /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/locale  (never written to; results land on refs/brigadier/20260831-095329-6d9e/<piece>)
width     min(1 independent pieces, cap 4, memory allows 12) = 1, bound by independent pieces
  merged   locale  5 turns, 69510 tokens
           refs/brigadier/20260831-095329-6d9e/locale

verify    no verify command; nothing was run and nothing is wrong with that

left behind (nothing is deleted):
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095329-6d9e/_merged
  /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/locale refs/brigadier/20260831-095329-6d9e/merged
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run2/home/workspaces/20260831-095329-6d9e/locale
```

What the worker wrote, once it had the answer it needed:

```
export const DEFAULT_LOCALE = "en-GB";
```

