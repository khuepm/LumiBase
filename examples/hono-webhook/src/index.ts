import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';

const app = new Hono();

// 1. Define the Zod schema matching LumiBase Webhook Payload format
const WebhookPayloadSchema = z.object({
  event: z.enum(['item.create', 'item.update', 'item.delete']),
  collection: z.string(),
  siteId: z.string(),
  timestamp: z.string(),
  data: z.object({
    id: z.string(),
    [key: string]: z.unknown(),
  }),
  previousData: z.record(z.string(), z.unknown()).optional(),
});

type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-webhook-shared-secret';

/**
 * Verify HMAC-SHA256 signature sent by LumiBase.
 */
function verifySignature(payloadText: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !WEBHOOK_SECRET) return false;
  
  const hmac = createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(payloadText);
  const digest = hmac.digest('hex');
  
  try {
    return timingSafeEqual(
      Buffer.from(digest, 'hex'),
      Buffer.from(signatureHeader, 'hex')
    );
  } catch {
    return false;
  }
}

// 2. Webhook receiver route
app.post('/webhooks/lumibase', async (c) => {
  const signature = c.req.header('x-lumi-signature');
  const bodyText = await c.req.text();

  // Validate signature
  if (!verifySignature(bodyText, signature || null)) {
    console.warn('[Webhook] Unauthorized request — invalid signature');
    return c.json({ error: 'Unauthorized — Invalid signature' }, 401);
  }

  // Parse JSON
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  // Validate payload format using Zod
  const result = WebhookPayloadSchema.safeParse(json);
  if (!result.success) {
    console.warn('[Webhook] Payload format validation failed:', result.error.format());
    return c.json({ error: 'Validation failed', details: result.error.format() }, 400);
  }

  const payload: WebhookPayload = result.data;
  console.log(`[Webhook] Received verified event: ${payload.event} on collection: ${payload.collection}`);

  // 3. Process event
  switch (payload.event) {
    case 'item.create':
      console.log(`- New item created with ID: ${payload.data.id}`);
      // Implement your custom side-effects here (e.g. index in search, send email)
      break;

    case 'item.update':
      console.log(`- Item updated: ID: ${payload.data.id}`);
      console.log('- Previous state:', payload.previousData);
      break;

    case 'item.delete':
      console.log(`- Item deleted: ID: ${payload.data.id}`);
      break;

    default:
      console.warn(`- Unknown event: ${payload.event}`);
  }

  return c.json({ received: true });
});

// Start dev server if run directly
const port = Number(process.env.PORT) || 3005;
console.log(`[Webhook Server] Listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
