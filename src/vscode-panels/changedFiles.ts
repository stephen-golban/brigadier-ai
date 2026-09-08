import {
  Emitter,
  Event,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { fileUri } from "./workspace";
import { bindingKey, type PanelBinding } from "./types";

/** The small, read-only SCM service surface consumed by Search's changed-files toggle.
 * It contributes no panel, commands, menus, input models, or Git operations. */
export class ChangedFilesIndex {
  readonly onDidAddRepository = Event.None;
  readonly onDidRemoveRepository = Event.None;
  private readonly changed = new Emitter<void>();
  private signature = "";
  readonly repositoryCount = 1;
  readonly repositories = [
    {
      provider: {
        onDidChangeResources: this.changed.event,
        groups: [
          { resources: [] as { sourceUri: ReturnType<typeof fileUri> }[] },
        ],
      },
    },
  ];
  getRepository() {
    return undefined;
  }
  registerSCMProvider(): never {
    throw new Error("Git providers are managed by Brigadier");
  }
  update(binding: PanelBinding) {
    const signature = JSON.stringify([
      bindingKey(binding),
      binding.revision,
      binding.status?.changes,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.repositories[0].provider.groups[0].resources = (
      binding.status?.changes ?? []
    ).map((change) => ({ sourceUri: fileUri(binding, change.path) }));
    this.changed.fire();
  }
}
