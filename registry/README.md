# registry

The curated model registry, published from this repository so installed apps can update it
without a release. `models.json` records, for each model, its vendor, CLI, effort levels,
context window, modalities, strengths per task category and quality tier. It arrives with
Phase 5 (routing and resilience); see [docs/PLAN.md](../docs/PLAN.md) §3 and §6.

Not to be confused with `crates/registry`, the MCP, plugin and skill registry.
