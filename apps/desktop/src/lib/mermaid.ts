/**
 * Mermaid diagrams for the thread's ```mermaid blocks. Loaded on demand; strict security, so
 * a diagram's labels can't carry scripts or links out.
 */
import mermaid from "mermaid";

let ready = false;
let next = 0;

/** The diagram as SVG markup, or null while `code` isn't a valid diagram (still streaming). */
export async function renderDiagram(code: string): Promise<string | null> {
  if (!ready) {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    ready = true;
  }
  if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
  const { svg } = await mermaid.render(`brigadier-diagram-${next++}`, code);
  return svg;
}
