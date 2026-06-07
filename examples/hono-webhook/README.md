# Hono.js Webhook Receiver Example

This example demonstrates how to implement a secure, type-safe webhook receiver for LumiBase webhook events (e.g. item created, updated, or deleted).

## Features
- **HMAC-SHA256 Signature Verification**: Rejects unauthorized requests by verifying signatures using timing-safe comparisons.
- **Type-Safe Validation**: Validates the request body structure against a Zod schema.
- **Event Dispatching**: Hooks into specific lifecycle events (`item.create`, `item.update`, `item.delete`).

## Getting Started

1. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   Set `WEBHOOK_SECRET` to the secret defined in your LumiBase Studio Webhook dashboard.

2. **Install & Run**:
   ```bash
   pnpm install
   pnpm dev
   ```

3. **Deploy & test**:
   Expose this server locally using Ngrok or Cloudflare Tunnel, then configure your webhook URL in LumiBase Studio:
   `https://<your-tunnel-subdomain>.ngrok-free.app/webhooks/lumibase`
