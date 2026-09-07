/**
 * Per-file test setup.
 *
 * `@testing-library/jest-dom/vitest` registers the DOM matchers *and* augments Vitest's
 * `Assertion` type; because this file sits under `src/` it is inside `tsconfig.json`'s
 * `include`, so `toBeInTheDocument()` type-checks with no `types` entry anywhere.
 *
 * `import.meta.env.DEV` is `true` under `vitest run` (measured), so `fps.ts` would otherwise
 * consider its meter enabled and `console.debug` a frame report every simulated second — and
 * `feedStore`'s drain calls `fps.sampleFrame()` on every frame. The stored "off" is read by
 * `fps.readEnabled()` at module load, which is re-run by every `vi.resetModules()` import.
 */
import "@testing-library/jest-dom/vitest";

localStorage.setItem("brigadier.fps", "off");

import {beforeEach} from "vitest";
beforeEach(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem("brigadier.fps","off");});
Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.setAttribute("open","");}});

Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });
HTMLElement.prototype.scrollIntoView = function() {};

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
