# VEMI brand files

- `vemi-wordmark.svg`, `vemi-wordmark-white.svg`: the wordmark as vector paths (no font needed).
- `vemi-animated.svg`, `vemi-animated-white.svg`: the same wordmark, with the letters rising and the dot dropping. The motion stops when a device asks for less motion.
- `icons/`: the app icon (a v with the dot over its arm): SVG, maskable SVG, and the 192, 512, maskable 512 and Apple touch PNGs. The build serves these; see `src/web/appIcon.ts`.
- `social-preview.png`: the 1280 by 640 picture for a link preview.

To rebuild everything after the artwork changes, edit `vemi-wordmark.svg` and run:

    node scripts/make-brand.mjs

The wordmark was drawn from the Ibrand typeface and traced to outlines. The typefaces are not in this repository.
