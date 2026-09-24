/**
 * Startup milestones, so a slow cold start says where the time went: when the webview began
 * loading the page, when the app's code started running, and each step up to the first
 * interactive paint.
 */
const marks: [string, number][] = [];

/** Records a milestone at the current time. */
export function markStartup(name: string): void {
  marks.push([name, performance.now()]);
}

/** The milestones in ms since the OS started the app process, e.g. `webview 410, script 690`. */
export function startupBreakdown(processStartMs: number): string {
  const since = (performanceMs: number) =>
    Math.round(performance.timeOrigin + performanceMs - processStartMs);
  return [["webview", 0] as [string, number], ...marks]
    .map(([name, at]) => `${name} ${since(at)}`)
    .join(", ");
}
