/**
 * One question: **when is the composer allowed to say nothing is connected?**
 *
 * The banner used to read "The selected execution settings are unavailable" the moment the
 * provider catalogue was empty, and the catalogue is empty for the first read of every launch
 * while the Rust side is still discovering (`docs/research/execution-settings-banner.md`). So it
 * fired at every launch, in auto mode, where there are no selected settings to be unavailable.
 *
 * Pinned here: nothing while the catalogue has not settled, the honest sentence once it has, and
 * silence once a provider is there. Text and roles, never class names.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { NewSession } from "./NewSession";
import * as providerCatalog from "../providerCatalog";
import type { ProjectId, ProjectView } from "../wire";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PROJECT: ProjectView = {
  id: "project-one" as ProjectId,
  name: "job-portal",
  root_path: "/repos/job-portal",
  created_at_ms: 1_700_000_000_000,
};

const CODEX: providerCatalog.ProviderCatalogEntry = {
  id: "codex", label: "Codex", instanceId: "codex:default", version: null,
  models: [{ id: "gpt-5.1-codex", label: "Codex", efforts: ["high"] }], efforts: ["high"], modelCatalogKnown: true,
};

function mount(catalog: providerCatalog.ProviderCatalogState) {
  vi.spyOn(providerCatalog, "useProviderCatalog").mockReturnValue(catalog);
  return render(<NewSession project={PROJECT} models={[]} disabled={false} onStart={() => {}} />);
}

const alerts = () => screen.queryAllByRole("alert").map(node => node.textContent ?? "");

it("says nothing about providers while the catalogue has not settled", async () => {
  mount({ providers: [], error: "", loaded: false });
  await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
  expect(alerts()).toEqual([]);
});

it("names the real condition once the catalogue settles empty", async () => {
  mount({ providers: [], error: "", loaded: true });
  await waitFor(() => expect(alerts()).toHaveLength(1));
  expect(alerts()[0]).toBe("No provider CLI is connected. Install Claude Code or Codex and reopen.");
  expect(alerts()[0]).not.toContain("execution settings are unavailable");
});

it("says nothing when a provider is connected", async () => {
  mount({ providers: [CODEX], error: "", loaded: true });
  await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
  expect(alerts()).toEqual([]);
});

/*
 * A registered provider that cannot run is a different fact from no provider at all, and the
 * install sentence would be a lie in front of an installed CLI.
 */
it("distinguishes a connected-but-blocked provider from an empty catalogue", async () => {
  vi.spyOn(providerCatalog, "useProviderCatalog").mockReturnValue({
    providers: [{ ...CODEX, id: "claude-code", label: "Claude Code", instanceId: "claude-code:default" }], error: "", loaded: true,
  });
  render(<NewSession project={PROJECT} models={[]} disabled onStart={() => {}} />);
  await waitFor(() => expect(alerts()).toHaveLength(1));
  expect(alerts()[0]).toContain("The connected provider is unavailable");
});
