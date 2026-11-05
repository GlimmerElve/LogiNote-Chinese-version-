# Teachable Figures renderer provenance

`anatomy-iso-kit.mjs` is the unmodified `assets/anatomy/kit/iso-kit.mjs` distributed with Teachable Figures revision `049f476d6188a4cd568550de7196fa94c12f4a1a`. The upstream Anatomy revision is `454a0ef801b6d9b905f08309d094491c7085b3dd`. Its MIT license is in `ANATOMY-LICENSE.txt`.

`anatomyIsoSource.ts` embeds that same source as a string for the Electron bundle. The guest-only adapter removes ESM `export` prefixes and exposes a small projection API inside the isolated figure renderer. It does not expose the host bridge or turn a fixed projection into true 3D.

`anatomy-kit/` contains the upstream MIT modules needed for rigid 3D construction. `anatomy3dSource.ts` is a browser IIFE built from `anatomy3dEntry.mjs`; it is injected only into an explicitly marked isolated guest. Its optional 3D renderer is a teaching model, not an engineering or medical simulator. The upstream 3D engine is beta; per-scene geometry, accessibility and performance require separate verification.

Re-generate after updating the source with `node scripts/generate-teachable-iso-source.cjs` and `node scripts/generate-teachable-3d-source.cjs`; run the isolated native figure test to validate the bundle. No original Teachable Figures lesson, application references, screenshots or anatomical meshes are included here.
