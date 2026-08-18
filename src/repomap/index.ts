// SPDX-License-Identifier: Apache-2.0
/**
 * The repo map, ruling 39.
 *
 * The whole surface is `buildRepoMap(repoDir, { budgetTokens })`. Everything
 * else exported here is a constant a caller needs in order to report the map
 * honestly, or a type describing what came back.
 *
 * Deliberately NOT exported: anything that takes a work item. Ruling 39 settled
 * that the map is built once per run, and the cheapest way to keep that true is
 * for there to be no other door.
 */

export { buildRepoMap, REPO_MAP_FRAMING } from "./map.ts";
export type { RepoMap, RepoMapCoverage, RepoMapOptions, UnmappedLanguage } from "./map.ts";
export { CHARS_PER_TOKEN, DEFAULT_BUDGET_TOKENS, UNDERCOUNT_CORRECTION, estimateTokens } from "./tokens.ts";
export { GRAMMARS } from "./grammars.ts";
export type { GrammarSpec, LanguageName } from "./grammars.ts";
