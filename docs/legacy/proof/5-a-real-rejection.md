# A reviewer rejecting a real piece, and brigadier refusing to merge it

**What this is, stated first.** This is a transcript excerpt from run
`20260831-021505-9922`, an earlier execution of `scripts/prove-run.sh` on 2026-08-31. Its working
directory was not retained, so unlike the other four files here this one cannot be re-derived by
re-running a script — it is quoted from the run's `run.json` and clone as they stood at the time.

It is kept because the later runs of the same script came back all-approved, and a review that never
rejects anything proves nothing about a rule that only fires on rejection. The mechanical behaviour
— a rejected piece does not merge, does not land on a ref, a review with no verdict line is treated
as broken rather than as approval, and a reviewer that ran out of turns has approved nothing
whatever text it emitted — is covered by tests that run every time (`test/run.test.ts`). What tests
cannot show is that the review is worth having.

## What the builder wrote

Work order: *"Create src/titleCase.ts exporting `titleCase(input: string): string`. Upper-case the
first character of every whitespace-separated word and lower-case the rest."*

```ts
export function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) =>
      word.length === 0
        ? word
        : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}
```

Both tests in the suite passed.

## What the reviewer said, verbatim

> src/titleCase.ts:3 — `.split(" ")` splits on the literal space only, so tab/newline-separated words
> are never capitalized: `titleCase("hello\tworld\nfoo BAR")` returns `"Hello\tworld\nfoo Bar"`, where
> the order specifies "every whitespace-separated word". Verified by running it.
>
> Everything else holds: named export, correct camelCase filename, no deps, no other files touched,
> `bun -e ...` prints `Hello World A B`, `""` → `""`, and runs of spaces are preserved
> (`"  many   spaces  "` → `"  Many   Spaces  "`).
>
> The two test cases pass, so nothing in the suite catches this — it is exactly the "right in the
> small, wrong in the large" case for a general-purpose helper that may see multi-line or
> tab-delimited input.
>
> Fix is one line and keeps the spacing-preservation property:
> `input.replace(/\S+/g, w => w[0]!.toUpperCase() + w.slice(1).toLowerCase())`
>
> VERDICT: rejected

## What brigadier did about it

```
  merged   slugify  6 turns, 89326 tokens
           refs/brigadier/20260831-021505-9922/slugify
           review: approved (same vendor as the builder — a weaker check than a different vendor reading it)
  merged   truncate  6 turns, 89201 tokens
           refs/brigadier/20260831-021505-9922/truncate
           review: approved (same vendor as the builder — a weaker check than a different vendor reading it)
  rejected title-case  9 turns, 121546 tokens
           review: rejected (same vendor as the builder — a weaker check than a different vendor reading it)
           the reviewer rejected this piece; brigadier refuses to merge it
  pending  index-barrel
```

`refs/brigadier/20260831-021505-9922/title-case` was never created. `index-barrel` depended on
`title-case` and stayed `pending` rather than building on a piece that had been turned down. The
verify command then failed on the merge, because the barrel it needed was not there, and the run
reported `failed`.

brigadier understood none of this. It read one marker line — `VERDICT: rejected` — and refused. The
judgement was entirely the reviewing model's; the refusal was entirely brigadier's.

## The honest caveat, which the run itself printed on every line

The reviewer was Claude. So was the builder. Same vendor, same model family, same blind spots —
which is a weaker check than a different vendor reading the code, and every verdict above says so
in the line that carries it.

That caveat stopped being abstract a few hours later. A different vendor reviewed this codebase and
found nineteen defects the same-vendor review had missed, including three claims in the
documentation that were false. Same-vendor review found a real bug in a string helper. Cross-vendor
review found that the spending gate did not work. Both are worth having; they are not worth the
same, and this is the file that says so.
