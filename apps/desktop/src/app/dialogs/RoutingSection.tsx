import { Plus, Trash } from "@openai/apps-sdk-ui/components/Icon";
import { useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { ErrorLine } from "@/app/dialogs/fields";
import { RuleForm } from "@/app/routing/RuleForm";
import type { ModelGroup } from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import { ruleSentence } from "@/lib/routing";
import { removeOverride } from "@/state/routing";
import { useApp } from "@/state/store";

/**
 * Settings → Routing: the user's rules, which always win over routing's scores and quota
 * balancing. Adding or removing one applies at once.
 */
export function RoutingSection({ groups }: { groups: readonly ModelGroup[] }) {
  const rules = useApp((s) => s.settings.routingOverrides);
  const projects = useApp((s) => s.projects);
  const [adding, setAdding] = useState(false);
  const remove = useAction();
  return (
    <section aria-labelledby="settings-routing" className="grid gap-2">
      <div className="flex items-center gap-2">
        <h3 id="settings-routing" className="text-muted-foreground min-w-0 flex-1 text-xs">
          Routing rules
        </h3>
        {!adding && (
          <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <Plus />
            Add rule
          </Button>
        )}
      </div>
      {rules.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No rules: routing picks each task's model by its scores and quota.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rules.map((rule) => (
            <li
              key={rule.id}
              data-slot="routing-rule"
              className="hover:bg-accent/50 rounded-control flex items-center gap-2 px-2 py-1"
            >
              <span className="min-w-0 flex-1 text-sm">{ruleSentence(rule, groups, projects)}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove: ${ruleSentence(rule, groups, projects)}`}
                disabled={remove.busy}
                onClick={() => remove.run(() => removeOverride(rule.id))}
              >
                <Trash />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={remove.error} />
      {adding && <RuleForm groups={groups} onDone={() => setAdding(false)} />}
      <p className="text-muted-foreground text-xs">
        Rules always win over scores and balancing, but never over Brigadier's own limits (no
        Fable, effort at most high). A rule applies as soon as you add it.
      </p>
    </section>
  );
}
