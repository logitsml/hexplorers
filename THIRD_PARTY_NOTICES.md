# Third-party notices

Hexplorers is licensed under the Apache License 2.0 ([LICENSE](LICENSE), with the credit in [NOTICE](NOTICE)). It includes or adapts the following work by others, each under its
own license. Full license texts are in [LICENSES/](LICENSES/) unless noted.

## Adapted code

| Where | Source | License |
|---|---|---|
| `src/render/env/oceanSim.ts` (Tessendorf's FFT ocean: the wave spectrum, its evolution and the shared-memory FFT) | [Noniv/web-ocean](https://github.com/Noniv/web-ocean), Copyright (c) 2026 Maksymilian Dendura | MIT, [LICENSES/MIT-web-ocean.txt](LICENSES/MIT-web-ocean.txt) |
| `src/render/env/sky.ts` (a modified copy of three.js's SkyMesh, the Preetham daylight model) | [three.js](https://github.com/mrdoob/three.js), Copyright © 2010-2026 three.js authors | MIT, [LICENSES/MIT-three.js.txt](LICENSES/MIT-three.js.txt) |

## Icons

| Where | Source | License |
|---|---|---|
| `src/ui/LineIcons.tsx` (the clouds, ship and crew, and the action icons, redrawn after Lucide's) | [Lucide](https://lucide.dev), Copyright (c) 2026 Lucide Icons and Contributors; icons derived from Feather, Copyright (c) 2013-present Cole Bemis | ISC, with Feather's under MIT, [LICENSES/ISC-lucide.txt](LICENSES/ISC-lucide.txt) |
| `src/ui/filledIcons.ts` (Material Symbols Rounded glyphs as SVG paths, rounded to a tenth of a unit) | [Material Symbols](https://github.com/google/material-design-icons), Google | Apache 2.0, [LICENSES/Apache-2.0-material-symbols.txt](LICENSES/Apache-2.0-material-symbols.txt) |

## Fonts

The fonts are installed from npm (`@fontsource`) and bundled into the built site; each package carries its license.

| Font | Copyright | License |
|---|---|---|
| Fraunces | Copyright 2020 The Fraunces Project Authors | SIL Open Font License 1.1 |
| Google Sans Flex | Copyright 2015 Google LLC | SIL Open Font License 1.1 |
| Alegreya Sans | Copyright 2013 The Alegreya Sans Project Authors | SIL Open Font License 1.1 |
| Lilita One | Copyright (c) 2011 Juan Montoreano | SIL Open Font License 1.1 |

The dice's 3D numerals (`src/render/fx/digits.json`) are Lilita One's digits converted to three.js's typeface format
and renamed "Exploratory Digits", as the license's Reserved Font Name clause requires. Its license is beside it in
[src/render/fx/digits-OFL.txt](src/render/fx/digits-OFL.txt).

## Libraries

The runtime dependencies are installed from npm and keep their own licenses: three, react, react-dom, motion,
zustand, torph, valibot and ws (all MIT). See `package.json`.

## Methods credited in the code

These are implemented from their papers or specifications, with no code copied: Jimenez's five-tap Catmull-Rom
filter, the OpenSkill ratings (Weng and Lin, 2011, as the MIT openskill.js and openskill.py implement them), a QR
encoder following ISO/IEC 18004 with the structure of Project
Nayuki's reference encoder (MIT), ChaCha20 (RFC 8439), and the Web Push and VAPID RFCs (8188, 8291, 8292).

## Art and sound

The painted art in `public/art/` was generated with OpenAI's gpt-image model from the prompts in
`scripts/art/gen_art.py`, then sized by `scripts/art/optimize.py`. It is part of this repository under the same Apache 2.0
license as the code. The sounds and music are synthesised in code (`src/audio/`); there are no recordings.

## The game's rules

Hexplorers is a hex-board resource-trading game. Its rules of play are mechanics, which
copyright doesn't cover; its names, text, art and code are its own. It is not affiliated with or endorsed by the
publisher of any other board game.
