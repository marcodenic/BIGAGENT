# Grok Bot 0.18 face renderer provenance

This prototype vendors an isolated dependency closure of the face component
from the publicly distributed Grok Bot 0.18.0 Electron renderer. It is not a
clean-room recreation and does not use Bloub.

## Official renderer extraction

For this prototype, the team inspected the publicly distributed macOS Grok Bot
0.18.0 application package. The extracted Electron renderer bundle was
`dist/renderer/assets/index-UbX-y3il.js` (SHA-256
`ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa`) inside
the verified `app.asar` (SHA-256
`6665408168466f9cacc6087e917890c17f59d2e2e9c2404a5c4a59ad79c1de58`).

The extracted component was the minified renderer identifier `$_t`. Its
transitive local dependencies were isolated from that exact bundle, including
the original body geometry, face paths, expressions, springs, blink/gaze
scheduler, idle movement, lifecycle reactions, effect animations, colors, and
timing constants. That dependency closure is stored in
`src/vendor/grok-bot-0.18/renderer.tsx`. The only hand-written additions in
that file are React/JSX-runtime bindings, provenance comments, and exports.

`src/components/AnimatedFace.tsx` is an application adapter: it selects an
official shape/color/state and mounts the extracted renderer. App-state
mapping is kept separately in `src/components/animatedFaceModel.ts`.

## License posture

No source-code license granting redistribution of the proprietary Grok Bot
renderer was found with the inspected application. Cursor's published third
party notices concern bundled open-source dependencies and do not grant a
license to the Grok Bot renderer itself. The vendored extraction should
therefore be treated as local prototype/research code and should not be shipped
or redistributed without an independent rights review.

The public `b-nnett/grok-bot-0.18-reconstructed` repository was used only as a
map for locating renderer areas. Its provenance notice likewise says it does
not assert an upstream source-code license. No code or assets from that project
or from Bloub are included here.

## Integration files

- `src/vendor/grok-bot-0.18/renderer.tsx` — exact extracted renderer dependency
  closure.
- `src/components/animatedFaceModel.ts` — typed official shape/color/state
  catalog and app-state mapping.
- `src/components/AnimatedFace.tsx` — thin application adapter around the
  extracted renderer.
- `src/components/FaceVisual.tsx` — temporary implementation switch. Add
  `?face=matrix` to use the original dot-matrix component for comparison.
