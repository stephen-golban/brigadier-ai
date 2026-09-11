/**
 * Vite treats a query-suffixed module id (`./Sidebar.tsx?unmocked`) as a **distinct module** that
 * still resolves to the same file, with its own relative imports landing in the one shared graph.
 * That is what lets `src/App.test.tsx` reach the real `Sidebar` past its own `vi.mock` of it
 * without instantiating a second copy of the sidebar context.
 *
 * TypeScript has no resolver for the suffix. This shorthand ambient declaration gives the id a
 * type of `any`, so a call site can annotate the shape it expects — `const real: typeof
 * import("./components/Sidebar") = await import("./components/Sidebar.tsx?unmocked")` — instead of
 * silencing the resolution failure with `@ts-expect-error`, which suppresses every other error on
 * the line with it.
 *
 * Test-only. Nothing in the app imports a query-suffixed id.
 */
declare module "*?unmocked";
