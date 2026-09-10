# Striped disc — reference reconstruction

## Selected for production

The owner selected this logo on 2026-09-10. The scalable production master is `public/brand/striped-disc.svg`: a manual geometric reconstruction of the approved raster, with fifteen thin vertical strokes, stepped rounded core strokes and a solid center. It is not a pixel-exact trace. The mark inherits the app's text color and has no background, masks or raster dependency.

The shared BrandMark, startup HTML, platform icon generator and current-intro preview now use this master. Existing icon background, intro animation and soundtrack are preserved. Converge remains a saved favorite.

Pipeline references: `docs/research/striped-disc-logo-2026-09-10.md`.

Verification on 2026-09-10: icon generation and current-intro preview build succeeded; all 21 launch/audio tests passed; `npm run build` passed (TypeScript and Vite), with dependency-externalization and large-chunk warnings; `git diff --check` passed. The 256 px generated icon and browser preview were visually inspected, and the intro reached an enabled Continue button. Native build was attempted but could not start because Cargo is unavailable, including at the documented `$HOME/.cargo/bin` location. Native WKWebView and startup/burn performance checks therefore remain unverified. No installed application bundle was replaced.

## Original exploration

Requested 2026-09-10: rebuild the supplied reference as closely as possible. Converge was separately saved as a favorite in `../favorites/converge/`.

- `reference.png`: original user-supplied 400 × 300 reference.
- `reconstruction.png`: high-resolution raster reconstruction made with the built-in image-generation tool.
- `image-prompt.txt`: exact generation prompt.

Visually inspected: retains the centered black core, vertical strokes, circular outer envelope, and light background. This is a close visual reconstruction, not a pixel-exact trace; strokes and their joins are heavier and rounder than the original. This initial exploration preceded the production selection above.
