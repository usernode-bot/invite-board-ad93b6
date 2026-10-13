# Invite Board icon

The app's mark is an envelope pinned to a small board with a pushpin, drawn
flat in the Homeroom brand's Cream + Black pairing. No text, no gradients,
no shadows.

## Files

| File | Size | Pairing |
| --- | --- | --- |
| `icon.png` (+ `icon.svg` source) | 1024×1024 | black mark on cream — set as `icon.image` in `dapp.json`, with the ✉️ emoji kept as fallback |
| `featured-light.png` (+ `featured-light.svg`) | 1600×900 | black mark on cream |
| `featured-dark.png` (+ `featured-dark.svg`) | 1600×900 | cream mark on black |

The featured images are the artwork for the Invite Board listing in the
Homeroom directory, in a light and a dark version. Homeroom has no manifest
field to point the directory at them, so they live here; placing them in the
listing happens on Homeroom's side.

## Colours

Only the brand's Cream `#FFFEEA` and Black `#000000`.

## Rebuilding the PNGs

The PNGs are rendered from the SVG sources at their native sizes:

```sh
npx --yes @resvg/resvg-js-cli brand/icon.svg brand/icon.png
npx --yes @resvg/resvg-js-cli brand/featured-light.svg brand/featured-light.png
npx --yes @resvg/resvg-js-cli brand/featured-dark.svg brand/featured-dark.png
```
