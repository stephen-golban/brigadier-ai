// SPDX-License-Identifier: Apache-2.0
/**
 * The staleness gate.
 *
 * Ruling 62, standard (g). v1 lost four documents to invisible staleness **in
 * one day**, and every instance passed all four gates, because a prompt, a
 * schema description and a document are all just text. The mitigation that
 * actually worked was a full-tree grep for the CLAIM after each wave — not a
 * review of changed files.
 *
 * That distinction is the whole point, and it is structural rather than
 * incidental: **every other check in this design is scoped to changed files**,
 * and this failure class is defined by living in a file nobody touched. Ruling
 * 51's ownership diff cannot catch it. A reviewer reading the diff cannot catch
 * it. Only a full-tree scan for the claim can.
 *
 * For this repository the greppable claims are ruling citations. Every `.ts`
 * file cites the rulings it implements, `BAR.md` carries a coverage row per
 * ruling, and ruling 48 requires that table to be revisited whenever a grilling
 * ticket lands a ruling with a user-visible promise. This makes that
 * requirement mechanical instead of remembered.
 *
 * The second claim in this tree is a TRANSCRIPTION rather than a citation.
 * `bar/lib/contract.ts` says in prose that it is the product's published record
 * format, copied by hand because `bar/` imports nothing from `src/`. That claim
 * was FALSE and nothing noticed: `CheckOutcome` listed `skipped`, which the
 * product has never emitted, and omitted `not-run`, which is `INITIAL_OUTCOME`
 * and therefore the most common value in a killed run's record. Three items
 * found the shape wrong, widened it locally, and carried on — the drift did not
 * make anything fail, it made three items measure the wrong thing quietly.
 * Check 5 below is the mechanical version of "somebody diffs the two files on
 * purpose", which is what that file currently rests on.
 *
 * Three decisions in check 5 were made after a critic broke earlier drafts of
 * it, and each one is a way this file could have become the thing it exists to
 * catch:
 *
 *   - **Nothing here may fail open.** An unreadable vocabulary, an unresolvable
 *     type and a file that does not parse are all LOUD failures, never empty
 *     ones. An earlier draft resolved `CheckOutcome` to `undefined`, coalesced
 *     it to `[]`, compared nothing, and exited 0 while printing
 *     `outcomes ` — which is `LSP servers (1)` for `{"notARealKey": 1}`, in
 *     the file whose header cites that incident.
 *   - **It must pass on a correct tree**, or it gets deleted rather than fixed.
 *     Re-exports (`export … from`) and merged interface declarations are both
 *     ordinary TypeScript, and a comparison that cannot see through them
 *     reports a faithful transcription as drift, or a real drift as agreement.
 *   - **The success line names what it compared**, field by field. "Everything
 *     agreed" and "nothing was read" must not print the same way.
 *
 * The five checks run under `import.meta.main` — the gate is entry-point
 * dependent on purpose, because `test/contract-drift.test.ts` imports this
 * module to exercise check 5 against synthetic drift, and a full-tree scan that
 * calls `process.exit(1)` is not something an import should do. Nothing else in
 * the tree imports this file.
 *
 * Deliberately offline: the map is the canonical artifact but it lives on
 * GitHub, and a gate that needs the network is a gate that fails in the wrong
 * way. `BAR.md`'s coverage table is the local shadow of it, and the checks below
 * are the ones that can be made without leaving the tree.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { RECORD_LINE, type CheckOutcome as BarOutcome, blocks as barBlocks } from "../bar/lib/contract.ts";
import { recordPointer } from "../src/report/record.ts";
import { INITIAL_OUTCOME, type CheckOutcome as SrcOutcome, blocks as srcBlocks } from "../src/work/check.ts";
import { crossings } from "./forbidden-imports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CITATION = /\bruling(?:s)?\s+(\d+(?:\s*(?:,|and|–|-|\/)\s*\d+)*)/gi;

/**
 * The one declared correspondence in this repository: the harness's hand-written
 * transcription, and the product file it claims to transcribe.
 *
 * These two constants are the only hard-coded knowledge check 5 has. Everything
 * else — which types exist, which fields they carry, which strings each
 * enumeration admits — is READ from the two files. A list of expected members
 * kept here would be a third transcription, and a third transcription drifts
 * exactly like the second one did.
 */
const BAR_CONTRACT = "bar/lib/contract.ts";
const RECORD_ENTRY = "src/report/record.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|md)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every ruling number cited anywhere in the tree, with where it was cited. */
function citations(): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CITATION)) {
      for (const raw of match[1]!.split(/[,/]|\band\b|[–-]/)) {
        const n = Number(raw.trim());
        if (!Number.isInteger(n) || n < 1) continue;
        const where = found.get(n) ?? [];
        where.push(relative(ROOT, file));
        found.set(n, where);
      }
    }
  }
  return found;
}

/** The ruling numbers `BAR.md`'s coverage table accounts for. */
function coveredRulings(): number[] {
  const bar = readFileSync(join(ROOT, "BAR.md"), "utf8");
  const rows = bar.matchAll(/^\|\s*(\d+)\s+[^|]*\|/gm);
  return [...rows].map((r) => Number(r[1])).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Check 5: the transcription, compared to the thing it transcribes.
// ---------------------------------------------------------------------------

/** One disagreement, named by the symbol it is about. Never a count — see `difference`. */
export interface ContractDrift {
  /** `CheckOutcome`, `RecordItem.kind`, `RunRecord.cost.quota` — the reader's first grep. */
  symbol: string;
  /** Which side has what, in both directions. */
  how: string;
  /** The product file this symbol should have agreed with, when it is not the record module. */
  where?: string;
}

export interface ContractComparison {
  /**
   * The symbols that were actually put side by side, fields included.
   *
   * Reported on SUCCESS, by name, because a structural check that resolved
   * nothing looks exactly like one that resolved everything and agreed. This
   * repository has already measured that shape of lie once: `.lsp.json` was
   * reported as `LSP servers (1)` for `{"notARealKey": 1}`.
   */
  compared: string[];
  drifts: ContractDrift[];
}

/**
 * A string enumeration as this checker could read it.
 *
 * `enumerable` is false when the union has a member that is not a string
 * literal — `(string & {})`, `Lowercase<…>`, a reference this parser cannot
 * follow. That is not "no members": it is a vocabulary that is no longer closed,
 * so exhaustive comparison is impossible and saying so is the only honest
 * answer. Ruling 52's vocabulary is closed by design; a widened one is drift.
 */
export interface Vocabulary {
  members: string[];
  enumerable: boolean;
}

type Declared = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

/** All declarations of one name in one module — plural because interfaces merge. */
interface Located {
  nodes: Declared[];
  file: string;
}

/** A name a module binds to a declaration elsewhere, and whether it PUBLISHES it. */
interface Binding {
  from: string;
  name: string;
  reexported: boolean;
}

interface Bindings {
  named: Map<string, Binding>;
  /** `export * from` only. An import-star brings nothing into a module's exports. */
  stars: string[];
}

/** Posix-normalised, root-relative module keys — the map's keys and `import` targets agree. */
function resolveSpecifier(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const out: string[] = [];
  for (const part of [...from.split("/").slice(0, -1), ...specifier.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * A parse-only view of a set of modules: what each one declares, what it
 * imports and re-exports, and what a type expression means once every alias is
 * resolved.
 *
 * Parse-only on purpose. A full `ts.Program` would need the standard library,
 * the tsconfig and the filesystem, and this has to run against a `Map` of
 * strings so the guard itself can be exercised against synthetic drift. Nothing
 * here needs inference — both sides of the comparison are hand-written
 * declarations.
 */
function graphFrom(sources: ReadonlyMap<string, string>) {
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const declaredCache = new Map<string, Map<string, { nodes: Declared[]; exported: boolean }>>();
  const boundCache = new Map<string, Bindings>();
  /**
   * Files that did not parse.
   *
   * `ts.createSourceFile` reports nothing and returns a tree with fewer
   * statements, so without this a syntax error reads as "that type has no
   * fields" — a silent pass, from the checker whose entire job is silent
   * failure. `parseDiagnostics` is TypeScript-internal; `test/contract-drift.test.ts`
   * pins it with a deliberately broken source, so the day it disappears is a
   * red test rather than a quiet one.
   */
  const parseProblems: ContractDrift[] = [];

  function sourceOf(file: string): ts.SourceFile | undefined {
    if (!parsed.has(file)) {
      const text = sources.get(file);
      let source: ts.SourceFile | undefined;
      if (text !== undefined) {
        source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
        const carrier = source as unknown as {
          parseDiagnostics?: readonly { start?: number; messageText: string | ts.DiagnosticMessageChain }[];
        };
        for (const diagnostic of carrier.parseDiagnostics ?? []) {
          const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
          parseProblems.push({
            symbol: file,
            how: `did not parse — ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")} at line ${line}; a file that does not parse is a file with fewer declarations, and everything it declares is invisible to this comparison`,
          });
        }
      }
      parsed.set(file, source);
    }
    return parsed.get(file);
  }

  function declaredIn(file: string): Map<string, { nodes: Declared[]; exported: boolean }> {
    const cached = declaredCache.get(file);
    if (cached !== undefined) return cached;
    const found = new Map<string, { nodes: Declared[]; exported: boolean }>();
    const source = sourceOf(file);
    for (const statement of source?.statements ?? []) {
      if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue;
      const exported = (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      // Interfaces MERGE. A second `interface RecordItem { … }` anywhere in the
      // file adds fields to every item, and an earlier draft that kept only the
      // last declaration reported a clean pass over a shape that had grown.
      const previous = found.get(statement.name.text);
      found.set(statement.name.text, {
        nodes: [...(previous?.nodes ?? []), statement],
        exported: (previous?.exported ?? false) || exported,
      });
    }
    declaredCache.set(file, found);
    return found;
  }

  /**
   * Every name a module binds to a declaration elsewhere.
   *
   * `export … from` counts. A critic moved `CheckOutcome` into a new module and
   * re-exported it — same members, same behaviour, `tsc` clean — and a draft
   * that understood `import` only reported the whole transcription as drift.
   * A gate that fails on a correct tree gets deleted rather than fixed.
   */
  function boundIn(file: string): Bindings {
    const cached = boundCache.get(file);
    if (cached !== undefined) return cached;
    const named = new Map<string, Binding>();
    const stars: string[] = [];
    const source = sourceOf(file);
    for (const statement of source?.statements ?? []) {
      if (ts.isImportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          named.set(element.name.text, {
            from: resolveSpecifier(file, specifier.text),
            name: (element.propertyName ?? element.name).text,
            reexported: false,
          });
        }
        continue;
      }
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
      const from = resolveSpecifier(file, specifier.text);
      const clause = statement.exportClause;
      if (clause === undefined) {
        stars.push(from);
        continue;
      }
      if (!ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        named.set(element.name.text, { from, name: (element.propertyName ?? element.name).text, reexported: true });
      }
    }
    const bound = { named, stars };
    boundCache.set(file, bound);
    return bound;
  }

  /** Where a type NAME used in `file` is actually declared, following imports and re-exports. */
  function declaration(name: string, file: string, seen = new Set<string>()): Located | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const local = declaredIn(file).get(name);
    if (local !== undefined) return { nodes: local.nodes, file };
    const bound = boundIn(file);
    const named = bound.named.get(name);
    if (named !== undefined) return declaration(named.name, named.from, seen);
    for (const star of bound.stars) {
      const found = declaration(name, star, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * The types and interfaces a module exports, including the ones it re-exports.
   *
   * An `import` is NOT an export, and an early draft of this counted them the
   * same: `import type { WorkKind }` in the record module made check 2 demand
   * that the bar transcribe `WorkKind`, which the product does not publish in
   * that record at all. `export … from` and `export *` do count, because from a
   * reader's side there is no difference between a type declared here and one
   * forwarded through here.
   */
  function exportsOf(file: string, seen = new Set<string>()): Map<string, Located> {
    const found = new Map<string, Located>();
    if (seen.has(file)) return found;
    seen.add(file);
    const bound = boundIn(file);
    for (const star of bound.stars) {
      for (const [name, located] of exportsOf(star, seen)) found.set(name, located);
    }
    for (const [name, target] of bound.named) {
      if (!target.reexported) continue;
      const resolved = declaration(target.name, target.from);
      if (resolved !== undefined) found.set(name, resolved);
    }
    for (const [name, decl] of declaredIn(file)) {
      if (decl.exported) found.set(name, { nodes: decl.nodes, file });
    }
    return found;
  }

  const text = (node: ts.Node, file: string): string => {
    const source = sourceOf(file);
    const raw = source === undefined ? "" : node.getText(source);
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  /** The single type alias behind a name, or `undefined` if it is an interface. */
  function aliasOf(nodes: readonly Declared[]): ts.TypeAliasDeclaration | undefined {
    const first = nodes[0];
    return nodes.length === 1 && first !== undefined && ts.isTypeAliasDeclaration(first) ? first : undefined;
  }

  /** Every property signature of a name, merged across every declaration of it. */
  function membersOf(nodes: readonly Declared[]): ts.PropertySignature[] | undefined {
    const members: ts.PropertySignature[] = [];
    for (const node of nodes) {
      if (!ts.isInterfaceDeclaration(node)) return undefined;
      members.push(...node.members.filter(ts.isPropertySignature));
    }
    return members;
  }

  /**
   * A type expression as a flat set of union members, with every alias followed.
   *
   * Following aliases is what lets `kind?: "write" | "read-only"` in the bar be
   * compared with `kind: WorkKind` in the product: the transcription inlines
   * what the product names, and a comparison that could not see through the
   * name would report every inlining as drift and be turned off within a week.
   */
  function parts(node: ts.TypeNode, file: string, seen: Set<string>): string[] {
    if (ts.isParenthesizedTypeNode(node)) return parts(node.type, file, seen);
    if (ts.isUnionTypeNode(node)) return node.types.flatMap((t) => parts(t, file, seen));
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined) {
      const key = `${file}#${node.typeName.text}`;
      if (!seen.has(key)) {
        const target = declaration(node.typeName.text, file);
        const alias = target === undefined ? undefined : aliasOf(target.nodes);
        if (target !== undefined && alias !== undefined) {
          return parts(alias.type, target.file, new Set([...seen, key]));
        }
      }
    }
    return [atom(node, file, seen)];
  }

  function atom(node: ts.TypeNode, file: string, seen: Set<string>): string {
    if (ts.isLiteralTypeNode(node)) {
      return ts.isStringLiteral(node.literal) ? JSON.stringify(node.literal.text) : text(node.literal, file);
    }
    if (ts.isArrayTypeNode(node)) {
      const element = normalise(node.elementType, file, seen);
      return element.includes(" | ") ? `(${element})[]` : `${element}[]`;
    }
    if (ts.isTypeLiteralNode(node)) {
      const members = node.members
        .filter(ts.isPropertySignature)
        .map((m) => `${memberName(m, file)}: ${m.type === undefined ? "unknown" : normalise(m.type, file, seen)}`)
        .sort();
      return `{ ${members.join("; ")} }`;
    }
    if (ts.isTypeReferenceNode(node)) {
      const name = text(node.typeName, file);
      const args = node.typeArguments;
      if (args === undefined) return name;
      return `${name}<${args.map((a) => normalise(a, file, seen)).join(", ")}>`;
    }
    return text(node, file);
  }

  /** A type expression as one canonical string: unions sorted and deduplicated. */
  function normalise(node: ts.TypeNode, file: string, seen = new Set<string>()): string {
    return [...new Set(parts(node, file, seen))].sort().join(" | ");
  }

  function memberName(member: ts.PropertySignature, file: string): string {
    return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
      ? member.name.text
      : text(member.name, file);
  }

  /** The property signatures of an object type, or `undefined` if it is not one. */
  function objectMembers(node: ts.TypeNode): ts.PropertySignature[] | undefined {
    if (ts.isParenthesizedTypeNode(node)) return objectMembers(node.type);
    if (ts.isTypeLiteralNode(node)) return node.members.filter(ts.isPropertySignature);
    return undefined;
  }

  return { declaration, exportsOf, normalise, memberName, objectMembers, membersOf, aliasOf, parseProblems };
}

/** Single quotes, so a drift line reads as prose rather than as JSON. */
function quoteList(members: string[]): string {
  return members.map((m) => `'${m.startsWith('"') ? (JSON.parse(m) as string) : m}'`).join(", ");
}

/**
 * How two normalised forms disagree, named member by member where they are
 * enumerations.
 *
 * Never "2 members differ". A count is satisfied by any two numbers that happen
 * to match, and the whole reason this file exists is that a plausible-looking
 * summary of a stale artifact is indistinguishable from a summary of a fresh
 * one. The failure line has to be greppable for the member that moved.
 */
function difference(barForm: string, srcForm: string): string {
  const bar = barForm.split(" | ");
  const src = srcForm.split(" | ");
  if ([...bar, ...src].every((m) => m.startsWith('"') && m.endsWith('"'))) {
    const extra = bar.filter((m) => !src.includes(m));
    const missing = src.filter((m) => !bar.includes(m));
    const phrases: string[] = [];
    if (extra.length > 0) phrases.push(`bar declares ${quoteList(extra)} which src never emits`);
    if (missing.length > 0) phrases.push(`src emits ${quoteList(missing)} which bar omits`);
    if (phrases.length > 0) return phrases.join("; ");
  }
  return `bar transcribes ${barForm}; src declares ${srcForm}`;
}

/**
 * Compare the harness's transcription with the product's record format.
 *
 * "Disagrees" means, precisely:
 *
 *   1. a type the bar transcribes has no declaration reachable from the
 *      product's record module — the bar is describing something that is gone;
 *   2. a type the record module exports has no transcription at all — the
 *      product grew a shape the harness cannot see;
 *   3. two same-named declarations differ in KIND (alias against interface);
 *   4. their enumerated string members differ in either direction, after every
 *      alias on both sides is followed to its literals — this is the round-15
 *      defect exactly: `skipped` present on one side, `not-run` on the other;
 *   5. two same-named FIELDS differ: one side carries a field the other does
 *      not, or their resolved types differ. Nested object literals recurse, so
 *      `cost.quota`'s three values are compared as `RunRecord.cost.quota`;
 *   6. a field the product may OMIT is required by the bar. See below;
 *   7. a file that had to be read did not parse.
 *
 * Optionality is compared in ONE direction only, and the direction is the whole
 * content of the rule. The bar may be looser than the product: it parses records
 * it does not trust, including forged ones, `parseRecord` enforces almost
 * nothing, and requiring `number: number` there would be requiring the harness
 * to believe a liar. The bar may never be STRICTER: `runRoot?: string` on the
 * product side against `runRoot: string` here is a field an item will
 * dereference on a record where the product never wrote it, which is round 15's
 * failure with the sides swapped. An earlier draft exempted both directions and
 * a critic loosened a product field straight through it.
 *
 * Not compared: doc comments. They are the part most likely to drift and the
 * part least able to make an item measure the wrong thing.
 */
export function compareContract(
  sources: ReadonlyMap<string, string>,
  barPath: string,
  entryPath: string,
): ContractComparison {
  const graph = graphFrom(sources);
  const drifts: ContractDrift[] = [];
  const compared: string[] = [];

  const compareType = (
    symbol: string,
    bar: { node: ts.TypeNode; file: string },
    src: { node: ts.TypeNode; file: string },
  ): void => {
    const barMembers = graph.objectMembers(bar.node);
    const srcMembers = graph.objectMembers(src.node);
    if (barMembers !== undefined && srcMembers !== undefined) {
      compareMembers(symbol, barMembers, bar.file, srcMembers, src.file);
      return;
    }
    const barForm = graph.normalise(bar.node, bar.file);
    const srcForm = graph.normalise(src.node, src.file);
    if (barForm !== srcForm) drifts.push({ symbol, how: difference(barForm, srcForm) });
  };

  function compareMembers(
    symbol: string,
    barMembers: ts.PropertySignature[],
    barFile: string,
    srcMembers: ts.PropertySignature[],
    srcFile: string,
  ): void {
    const bar = new Map(barMembers.map((m): [string, ts.PropertySignature] => [graph.memberName(m, barFile), m]));
    const src = new Map(srcMembers.map((m): [string, ts.PropertySignature] => [graph.memberName(m, srcFile), m]));
    for (const name of bar.keys()) {
      if (src.has(name)) continue;
      drifts.push({
        symbol: `${symbol}.${name}`,
        how: "bar declares this field; src writes no such field, so every item reading it reads undefined forever",
      });
    }
    for (const name of src.keys()) {
      if (bar.has(name)) continue;
      drifts.push({
        symbol: `${symbol}.${name}`,
        how: "src writes this field; bar omits it, so an item wanting it must widen the shape locally — which is what drift looks like from inside",
      });
    }
    for (const [name, barMember] of bar) {
      const srcMember = src.get(name);
      if (srcMember === undefined) continue;
      const path = `${symbol}.${name}`;
      compared.push(path);
      if (srcMember.questionToken !== undefined && barMember.questionToken === undefined) {
        drifts.push({
          symbol: path,
          how: "src may omit this field; bar declares it required, so an item will dereference a value the product never wrote",
        });
      }
      if (barMember.type === undefined || srcMember.type === undefined) continue;
      compareType(path, { node: barMember.type, file: barFile }, { node: srcMember.type, file: srcFile });
    }
  }

  const barExports = graph.exportsOf(barPath);
  if (barExports.size === 0) {
    drifts.push({
      symbol: barPath,
      how: "no exported type or interface was found — the transcription could not be read, so nothing was compared",
    });
    return { compared, drifts: [...graph.parseProblems, ...drifts] };
  }

  for (const [name, bar] of barExports) {
    const src = graph.declaration(name, entryPath);
    if (src === undefined) {
      drifts.push({
        symbol: name,
        how: `bar transcribes this type; nothing reachable from ${entryPath} declares it`,
      });
      continue;
    }
    compared.push(name);
    const barMembers = graph.membersOf(bar.nodes);
    const srcMembers = graph.membersOf(src.nodes);
    if ((barMembers === undefined) !== (srcMembers === undefined)) {
      drifts.push({
        symbol: name,
        how: `bar declares ${barMembers === undefined ? "a type alias" : "an interface"}; src declares ${srcMembers === undefined ? "a type alias" : "an interface"}`,
      });
      continue;
    }
    if (barMembers !== undefined && srcMembers !== undefined) {
      compareMembers(name, barMembers, bar.file, srcMembers, src.file);
      continue;
    }
    const barAlias = graph.aliasOf(bar.nodes);
    const srcAlias = graph.aliasOf(src.nodes);
    if (barAlias === undefined || srcAlias === undefined) {
      drifts.push({ symbol: name, how: "one side declares this name more than once and it is not an interface" });
      continue;
    }
    compareType(name, { node: barAlias.type, file: bar.file }, { node: srcAlias.type, file: src.file });
  }

  for (const name of graph.exportsOf(entryPath).keys()) {
    if (barExports.has(name)) continue;
    drifts.push({
      symbol: name,
      how: `${entryPath} exports this type; ${barPath} transcribes nothing by that name`,
    });
  }

  // A file that did not parse is reported first: everything below it is a
  // comparison against a tree with declarations missing.
  return { compared, drifts: [...graph.parseProblems, ...drifts] };
}

/**
 * The members of a string enumeration, resolved through aliases, imports and
 * re-exports.
 *
 * `undefined` means the name is not a resolvable type alias AT ALL, and callers
 * must treat that as a failure rather than as an empty vocabulary. Exported so
 * the run-time half of check 5 can ask "which outcomes exist?" without a literal
 * list living in this file — see `BAR_CONTRACT`.
 */
export function vocabulary(
  sources: ReadonlyMap<string, string>,
  file: string,
  name: string,
): Vocabulary | undefined {
  const graph = graphFrom(sources);
  const found = graph.declaration(name, file);
  const alias = found === undefined ? undefined : graph.aliasOf(found.nodes);
  if (found === undefined || alias === undefined) return undefined;
  const parts = graph.normalise(alias.type, found.file).split(" | ");
  const literals = parts.filter((m) => m.startsWith('"') && m.endsWith('"'));
  return {
    members: literals.map((m) => JSON.parse(m) as string),
    enumerable: literals.length === parts.length,
  };
}

/**
 * The half of the transcription a structural diff cannot see.
 *
 * `RECORD_LINE` is a regex rather than a type, `blocks()` is a function rather
 * than a type, and `INITIAL_OUTCOME` is a VALUE — every one of them can drift
 * while both files still declare identical shapes. They are checked by running
 * the two implementations against each other, so nothing here is transcribed
 * a third time.
 *
 * Everything below fails LOUD or not at all. An earlier draft asked for the
 * outcome vocabulary, got `undefined` because the union was no longer readable,
 * coalesced it to `[]`, compared nothing and exited 0 — printing an empty list
 * where the outcomes should have been. That is `LSP servers (1)` for
 * `{"notARealKey": 1}`, from the guard whose whole subject is silent failure.
 * An unreadable vocabulary is a worse failure than a wrong one, not a softer
 * one, and it is reported as such.
 *
 * The implementations arrive as arguments rather than as imports so this can be
 * run against synthetic drift — including the case where BOTH files widen their
 * union in step and only the behaviour underneath moves.
 */
export interface ContractProbe {
  /** The product's own pointer renderer, and a path to put through it. */
  pointerFor: (path: string) => string;
  samplePath: string;
  /** The bar's own pattern for finding that line again. */
  recordLine: RegExp;
  /** The value the product writes into every blocking check's slot before it runs. */
  initialOutcome: string;
  barBlocks: (outcome: string) => boolean;
  srcBlocks: (outcome: string) => boolean;
  /** Where `blocks()` and the outcome vocabulary actually live, for the message. */
  behaviourFile: string;
}

export function runtimeDrift(
  sources: ReadonlyMap<string, string>,
  barPath: string,
  entryPath: string,
  probe: ContractProbe,
): ContractDrift[] {
  const drifts: ContractDrift[] = [];
  const where = probe.behaviourFile;

  const pointer = probe.pointerFor(probe.samplePath);
  const read = probe.recordLine.exec(pointer)?.[1];
  if (read !== probe.samplePath) {
    drifts.push({
      symbol: "RECORD_LINE",
      how: `the product prints '${pointer}' and bar's pattern reads ${read === undefined ? "nothing" : `'${read}'`} out of it, so the record would be unfindable`,
    });
  }

  const src = vocabulary(sources, entryPath, "CheckOutcome");
  if (src === undefined) {
    drifts.push({
      symbol: "CheckOutcome",
      where,
      how: `no type alias of that name is reachable from ${entryPath}, so blocks() parity went unchecked — an outcome vocabulary this gate cannot read is a failure, never an empty list`,
    });
  } else {
    if (!src.enumerable) {
      drifts.push({
        symbol: "CheckOutcome",
        where,
        how: "the product's outcome union is no longer a closed set of string literals, so blocks() can no longer be compared exhaustively — ruling 52's vocabulary is closed by design",
      });
    }
    for (const outcome of src.members) {
      const bar = probe.barBlocks(outcome);
      const product = probe.srcBlocks(outcome);
      if (bar !== product) {
        drifts.push({ symbol: `blocks('${outcome}')`, where, how: `bar says ${bar}, src says ${product}` });
      }
    }
  }

  const bar = vocabulary(sources, barPath, "CheckOutcome");
  if (bar === undefined) {
    drifts.push({
      symbol: "CheckOutcome",
      where,
      how: `${barPath} declares no readable CheckOutcome alias, so the value the product writes into every blocking slot went unchecked`,
    });
  } else if (!bar.enumerable) {
    drifts.push({
      symbol: "CheckOutcome",
      where,
      how: "bar's outcome union is no longer a closed set of string literals, so it can no longer be checked against what the product writes",
    });
  } else if (!bar.members.includes(probe.initialOutcome)) {
    drifts.push({
      symbol: "CheckOutcome",
      where,
      how: `the product writes INITIAL_OUTCOME '${probe.initialOutcome}' into every blocking check's slot before it runs, and bar's vocabulary cannot name it`,
    });
  }

  return drifts;
}

if (import.meta.main) {
  const coverage: string[] = [];
  const seams: string[] = [];
  const drifted: string[] = [];
  const covered = coveredRulings();
  const highest = covered[covered.length - 1] ?? 0;

  // 1. The table is contiguous. A gap is a ruling nobody wrote a row for, which is
  //    exactly the "one-line way to make the bar lie" ruling 48 names.
  for (let n = 1; n <= highest; n++) {
    if (!covered.includes(n)) coverage.push(`BAR.md coverage table has no row for ruling ${n}`);
  }

  // 2. Nothing cites a ruling the table has never heard of. This is the staleness
  //    signal: a ruling landed, code cites it, and the table was not revisited.
  for (const [n, where] of [...citations()].sort((a, b) => a[0] - b[0])) {
    if (n > highest) {
      coverage.push(
        `ruling ${n} is cited in ${[...new Set(where)].join(", ")} but BAR.md's coverage table stops at ${highest}`,
      );
    }
  }

  // 3. The table has no duplicate rows.
  const seen = new Set<number>();
  for (const n of covered) {
    if (seen.has(n)) coverage.push(`BAR.md coverage table has two rows for ruling ${n}`);
    seen.add(n);
  }

  // 4. The seams that must not be crossed — `src/` into `probes/`, and (decision
  //    22, made mechanical by ruling 66) the router's competence path into the
  //    cost store, in either direction.
  const sources = new Map<string, string>();
  for (const file of walk(join(ROOT, "src"))) {
    sources.set(relative(ROOT, file).split("\\").join("/"), readFileSync(file, "utf8"));
  }
  for (const crossing of crossings(sources)) {
    seams.push(
      `${crossing.file} imports "${crossing.specifier}" across a forbidden seam — ${crossing.seam.why}`,
    );
  }

  // 5. The harness's transcription of the record format, against the record
  //    format. Ruling 52's vocabulary and every field of the record are copied
  //    by hand into `bar/lib/contract.ts` because `bar/` imports nothing from
  //    `src/`, and until now the only thing keeping the copy honest was somebody
  //    remembering to diff it.
  const contractSources = new Map<string, string>();
  for (const [path, text] of sources) if (path.endsWith(".ts")) contractSources.set(path, text);
  contractSources.set(BAR_CONTRACT, readFileSync(join(ROOT, BAR_CONTRACT), "utf8"));

  const contract = compareContract(contractSources, BAR_CONTRACT, RECORD_ENTRY);
  const drift = (where: string, symbol: string, how: string): void => {
    drifted.push(`${BAR_CONTRACT} has drifted from ${where} — ${symbol}: ${how}`);
  };
  for (const found of contract.drifts) drift(found.where ?? RECORD_ENTRY, found.symbol, found.how);

  //    The type is only half of the transcription: `RECORD_LINE`, `blocks()`
  //    and `INITIAL_OUTCOME` are a regex, a function and a value, and every one
  //    of them can move while both files still declare identical shapes.
  const runtime = runtimeDrift(contractSources, BAR_CONTRACT, RECORD_ENTRY, {
    pointerFor: recordPointer,
    samplePath: "/tmp/brigadier/run-2026-08-19/record.json",
    recordLine: RECORD_LINE,
    initialOutcome: INITIAL_OUTCOME,
    barBlocks: (outcome) => barBlocks(outcome as BarOutcome),
    srcBlocks: (outcome) => srcBlocks(outcome as SrcOutcome),
    behaviourFile: "src/work/check.ts",
  });
  for (const found of runtime) drift(found.where ?? RECORD_ENTRY, found.symbol, found.how);

  if (coverage.length + seams.length + drifted.length > 0) {
    console.error("claims gate FAILED\n");
    for (const problem of [...coverage, ...seams, ...drifted]) console.error(`  ${problem}`);
    if (coverage.length > 0) {
      console.error(
        "\nRuling 48: the coverage table must be revisited each time a grilling ticket",
      );
      console.error("lands a ruling with a user-visible promise. This is that check.");
    }
    if (drifted.length > 0) {
      console.error(`\nRuling 52 and ruling 62: ${BAR_CONTRACT} is a hand transcription of the`);
      console.error("product's record format. When it drifts, items do not fail — they measure");
      console.error(`the wrong thing quietly. Edit it to match ${RECORD_ENTRY}.`);
    }
    process.exit(1);
  }

  console.log(`claims gate passed — ${covered.length} rulings covered, highest ${highest}`);
  console.log(`${BAR_CONTRACT} in step with ${RECORD_ENTRY}, symbol by symbol:`);
  const groups = new Map<string, string[]>();
  for (const symbol of contract.compared) {
    const dot = symbol.indexOf(".");
    const top = dot === -1 ? symbol : symbol.slice(0, dot);
    const fields = groups.get(top) ?? [];
    if (dot !== -1) fields.push(symbol.slice(dot + 1));
    groups.set(top, fields);
  }
  for (const [top, fields] of groups) {
    if (fields.length > 0) {
      console.log(`  ${top}: ${[...fields].sort().join(", ")}`);
      continue;
    }
    const enumerated = vocabulary(contractSources, BAR_CONTRACT, top);
    console.log(`  ${top} = ${enumerated === undefined ? "(unreadable)" : enumerated.members.map((m) => `'${m}'`).join(" ")}`);
  }
}
