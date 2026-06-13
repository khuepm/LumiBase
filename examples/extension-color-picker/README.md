# LumiBase Color Picker Custom Field Extension

This is a premium custom field interface extension scaffold for LumiBase Studio that provides a visual color picker.

## Features
- **React-based UI**: Built using React 18 for seamless integration into the Studio shell.
- **Custom configurations**: Exposes a `defaultColor` configurable option in the Studio dashboard.
- **Library Build**: Uses Vite to compile to an ESM bundle (`dist/index.js`), which is lightweight and signed for the LumiBase Marketplace.

## Getting Started

1. **Install Dependencies**:
   ```bash
   pnpm install
   ```

2. **Run in Development / Build**:
   ```bash
   pnpm dev    # Starts the Vite preview/dev environment
   pnpm build  # Builds the extension to dist/index.js
   ```

3. **Install into LumiBase Studio**:
   Use the LumiBase CLI to register and install the compiled extension:
   ```bash
   lumibase extension install ./dist/index.js --local
   ```
