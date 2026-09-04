# Third-Party Notices

This repository and its distributed apps bundle or self-host the following open-source fonts.
Each font is licensed under the SIL Open Font License, Version 1.1 (OFL-1.1).
The OFL allows the fonts to be used, modified, embedded, bundled, and redistributed
with software, provided the license and copyright notices are preserved.

## Fonts

| Font | License | Copyright | Source |
|------|---------|-----------|--------|
| Archivo | SIL Open Font License 1.1 | Copyright 2020 The Archivo Project Authors | <https://github.com/google/fonts/tree/main/ofl/archivo> |
| Literata | SIL Open Font License 1.1 | Copyright 2017 The Literata Project Authors | <https://github.com/google/fonts/tree/main/ofl/literata> |
| DM Mono | SIL Open Font License 1.1 | Copyright 2020 The DM Mono Project Authors | <https://github.com/google/fonts/tree/main/ofl/dmmono> |
| Inter | SIL Open Font License 1.1 | Copyright 2020 The Inter Project Authors | <https://github.com/google/fonts/tree/main/ofl/inter> |
| Geist | SIL Open Font License 1.1 | Copyright 2023 Fonttools Inc. | <https://github.com/vercel/geist-font>, <https://github.com/google/fonts/tree/main/ofl/geist> |
| Geist Mono | SIL Open Font License 1.1 | Copyright 2023 Fonttools Inc. | <https://github.com/vercel/geist-font>, <https://github.com/google/fonts/tree/main/ofl/geistmono> |

## How fonts are used

- `apps/landing` self-hosts **Archivo**, **Literata**, and **DM Mono** at build time
  via `next/font/google`.
- `apps/consumer` self-hosts **Geist** and **Geist Mono** at build time via
  `next/font/google`.
- `apps/docs` self-hosts **Inter** at build time via the `@fontsource/inter`
  package and Vite.

## Full license text

The complete SIL Open Font License 1.1 text is included in each Fontsource package
under `node_modules/@fontsource/*/LICENSE` and in the Google Fonts repository
linked above.
