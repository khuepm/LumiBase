# LumiBase Examples

This directory contains standalone, production-ready examples demonstrating how to build applications, handle events, and write extensions with LumiBase.

## Examples List

### 1. [Next.js Blog](file:///Users/khuepm/workplace/LumiBase/examples/nextjs-blog)
A blog application built with Next.js (App Router, Server Components) that fetches data using `@lumibase/sdk`.
- Demonstrates typed collections fetching via `createLumiClient` and `legacyRest`.
- Integrates typegen for compile-time safety.
- Implements Next.js dynamic caching & ISR.

### 2. [Hono Webhook Handler](file:///Users/khuepm/workplace/LumiBase/examples/hono-webhook)
A webhook receiver built with Hono.js.
- Explains how to verify webhook signatures using HMAC-SHA256.
- Parses and processes type-safe payloads for items modification (create, update, delete).

### 3. [Color Picker Extension](file:///Users/khuepm/workplace/LumiBase/examples/extension-color-picker)
A custom field extension for LumiBase Studio.
- Implements a modern color-picker UI.
- Communicates with the LumiBase Studio shell via postMessage.
- Uses `manifest.json` declaration for easy uploading.

### 4. [Email Setup Extension](file:///Users/khuepm/workplace/LumiBase/examples/extension-email-setup)
An endpoint extension that sends email through LumiBase's built-in EmailService.
- Shows the split: the extension owns the trigger/UI; LumiBase owns transport + templates.
- Calls the core `POST /api/v1/email/send` with a `templateKey` — never talks SMTP itself.
- Declares minimal capabilities (`http:fetch`, `env:read`).

---

## Getting Started

To run any of the examples, navigate to its directory, install dependencies, and configure environment variables.

Example:
```bash
cd examples/nextjs-blog
cp .env.example .env.local
pnpm install
pnpm dev
```
