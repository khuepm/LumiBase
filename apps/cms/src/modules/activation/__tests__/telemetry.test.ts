import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventSchema,
} from '@lumibase/contracts';
import {
  buildTelemetryEvent,
  resolveTelemetryConfig,
  runScheduledTelemetry,
  type TelemetryEnv,
} from '../telemetry';

/**
 * The two promises this module makes, proven without a database:
 *
 *   1. Nothing is sent — and nothing is even read — before opt-in.
 *   2. What is sent is exactly the published schema, field for field.
 */

const INSTALL_ID = '3f0c1e52-8a55-4b0e-9d5e-0c6f1f6f2a11';
const ENDPOINT = 'https://collector.example.test/v1/events';
const OPTED_IN: TelemetryEnv = {
  LUMIBASE_TELEMETRY_ENABLED: 'true',
  LUMIBASE_TELEMETRY_ENDPOINT: ENDPOINT,
};

/** A db that fails the test the moment anything touches it. */
function untouchableDb(): { db: Database; touched: () => number } {
  let touches = 0;
  const db = new Proxy(
    {},
    {
      get() {
        touches += 1;
        throw new Error('database must not be touched while telemetry is off');
      },
    },
  ) as unknown as Database;
  return { db, touched: () => touches };
}

/**
 * Minimal stand-in for the drizzle builder: every method chains, and awaiting
 * the chain yields the next queued result. Query order in the emitter is
 * state insert → state select → (per unsent event: lookup → [update]).
 */
function queuedDb(results: unknown[][]): { db: Database; remaining: () => number } {
  const queue = [...results];
  const chain: Record<string | symbol, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => void) => resolve(queue.shift() ?? []);
      }
      return () => proxy;
    },
  });
  return { db: proxy as Database, remaining: () => queue.length };
}

const okFetch = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

describe('resolveTelemetryConfig', () => {
  it('is off with an empty environment', () => {
    expect(resolveTelemetryConfig({})).toEqual({ active: false, reason: 'not_opted_in' });
  });

  it('is off when only an endpoint is set (an endpoint is not consent)', () => {
    expect(resolveTelemetryConfig({ LUMIBASE_TELEMETRY_ENDPOINT: ENDPOINT })).toEqual({
      active: false,
      reason: 'not_opted_in',
    });
  });

  it('is off when opted in but no endpoint is configured — there is no built-in one', () => {
    expect(resolveTelemetryConfig({ LUMIBASE_TELEMETRY_ENABLED: 'true' })).toEqual({
      active: false,
      reason: 'no_endpoint',
    });
  });

  it('lets the single off switch win over an explicit opt-in', () => {
    expect(resolveTelemetryConfig({ ...OPTED_IN, LUMIBASE_TELEMETRY_DISABLED: '1' })).toEqual({
      active: false,
      reason: 'kill_switch',
    });
  });

  it('honours DO_NOT_TRACK', () => {
    expect(resolveTelemetryConfig({ ...OPTED_IN, DO_NOT_TRACK: '1' })).toEqual({
      active: false,
      reason: 'do_not_track',
    });
  });

  it.each(['not a url', 'http://collector.example.test/e', 'ftp://collector.example.test', 'https://user:pw@collector.example.test/'])(
    'rejects the endpoint %s',
    (endpoint) => {
      expect(
        resolveTelemetryConfig({ LUMIBASE_TELEMETRY_ENABLED: 'true', LUMIBASE_TELEMETRY_ENDPOINT: endpoint }),
      ).toEqual({ active: false, reason: 'no_endpoint' });
    },
  );

  it('accepts https, and http only to loopback', () => {
    expect(resolveTelemetryConfig(OPTED_IN)).toEqual({ active: true, endpoint: ENDPOINT });
    expect(
      resolveTelemetryConfig({
        LUMIBASE_TELEMETRY_ENABLED: 'on',
        LUMIBASE_TELEMETRY_ENDPOINT: 'http://localhost:8787/e',
      }),
    ).toEqual({ active: true, endpoint: 'http://localhost:8787/e' });
  });
});

describe('runScheduledTelemetry — nothing before opt-in', () => {
  const off: Array<[string, TelemetryEnv]> = [
    ['default (no variables)', {}],
    ['endpoint set, not enabled', { LUMIBASE_TELEMETRY_ENDPOINT: ENDPOINT }],
    ['enabled, no endpoint', { LUMIBASE_TELEMETRY_ENABLED: 'true' }],
    ['enabled=false', { LUMIBASE_TELEMETRY_ENABLED: 'false', LUMIBASE_TELEMETRY_ENDPOINT: ENDPOINT }],
    ['off switch over opt-in', { ...OPTED_IN, LUMIBASE_TELEMETRY_DISABLED: 'true' }],
    ['DO_NOT_TRACK over opt-in', { ...OPTED_IN, DO_NOT_TRACK: '1' }],
  ];

  it.each(off)('%s: no request, no database access, no install id', async (_name, env) => {
    const fetchSpy = okFetch();
    const { db, touched } = untouchableDb();

    const result = await runScheduledTelemetry({ db, env, runtime: 'docker', version: '2.0.0', fetch: fetchSpy });

    expect(result.active).toBe(false);
    expect(result.sent).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(touched()).toBe(0);
  });
});

describe('runScheduledTelemetry — after opt-in', () => {
  it('sends one request per reached milestone, each matching the published schema exactly', async () => {
    const fetchSpy = okFetch();
    const { db } = queuedDb([
      [], // insert state (on conflict do nothing)
      [{ id: 'singleton', installId: INSTALL_ID, sent: {} }],
      [{ at: new Date('2026-11-01T10:15:30.000Z') }], // first_site_created
      [], // mark sent
      [{ at: new Date('2026-11-02T23:59:59.000Z') }], // first_item_published
      [], // mark sent
      [{ at: null }], // first_delivery_request — not reached
      [{ at: null }], // first_agent_run — not reached
    ]);

    const result = await runScheduledTelemetry({
      db,
      env: OPTED_IN,
      runtime: 'docker',
      version: '2.0.0',
      fetch: fetchSpy,
    });

    expect(result).toEqual({ active: true, sent: ['first_site_created', 'first_item_published'] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const bodies = fetchSpy.mock.calls.map(([url, init]) => {
      expect(url).toBe(ENDPOINT);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      // Only a content type: no cookie, no authorization, no custom identifier.
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      return JSON.parse(String(init?.body)) as Record<string, unknown>;
    });

    expect(bodies).toEqual([
      {
        schemaVersion: 1,
        installId: INSTALL_ID,
        event: 'first_site_created',
        occurredOn: '2026-11-01',
        version: '2.0.0',
        runtime: 'docker',
      },
      {
        schemaVersion: 1,
        installId: INSTALL_ID,
        event: 'first_item_published',
        occurredOn: '2026-11-02',
        version: '2.0.0',
        runtime: 'docker',
      },
    ]);
    for (const body of bodies) {
      // `.strict()` — an extra key would throw here.
      expect(() => TelemetryEventSchema.parse(body)).not.toThrow();
    }
  });

  it('skips events already marked sent', async () => {
    const fetchSpy = okFetch();
    const { db, remaining } = queuedDb([
      [],
      [
        {
          id: 'singleton',
          installId: INSTALL_ID,
          sent: Object.fromEntries(TELEMETRY_EVENTS.map((e) => [e, '2026-11-01'])),
        },
      ],
    ]);

    const result = await runScheduledTelemetry({ db, env: OPTED_IN, runtime: 'cloudflare', version: '2.0.0', fetch: fetchSpy });

    expect(result.sent).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(remaining()).toBe(0);
  });

  it('does not mark an event sent when the endpoint fails, and never throws', async () => {
    const failing = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const throwing = vi.fn<typeof fetch>(async () => {
      throw new Error('network down');
    });
    for (const fetchSpy of [failing, throwing]) {
      const { db, remaining } = queuedDb([
        [],
        [{ id: 'singleton', installId: INSTALL_ID, sent: {} }],
        [{ at: new Date('2026-11-01T00:00:00.000Z') }],
        [{ at: null }],
        [{ at: null }],
        [{ at: null }],
      ]);
      const result = await runScheduledTelemetry({ db, env: OPTED_IN, runtime: 'docker', version: '2.0.0', fetch: fetchSpy });
      expect(result).toEqual({ active: true, sent: [] });
      // Every queued result was a read; no "mark sent" update consumed one.
      expect(remaining()).toBe(0);
    }
  });
});

describe('published schema', () => {
  it('rejects any field outside the schema', () => {
    const valid = buildTelemetryEvent({
      installId: INSTALL_ID,
      event: 'first_agent_run',
      occurredAt: new Date('2026-11-03T12:00:00.000Z'),
      version: '2.0.0',
      runtime: 'cloudflare',
    });
    expect(TelemetryEventSchema.safeParse(valid).success).toBe(true);
    for (const extra of ['siteId', 'hostname', 'ip', 'email', 'userId', 'occurredAt']) {
      expect(TelemetryEventSchema.safeParse({ ...valid, [extra]: 'x' }).success).toBe(false);
    }
  });

  it('keeps day precision only and falls back to "unknown" for a blank version', () => {
    const event = buildTelemetryEvent({
      installId: INSTALL_ID,
      event: 'first_site_created',
      occurredAt: new Date('2026-11-03T23:59:59.999Z'),
      version: '   ',
      runtime: 'docker',
    });
    expect(event.occurredOn).toBe('2026-11-03');
    expect(event.version).toBe('unknown');
  });

  it('matches the published JSON Schema file in docs/schemas', () => {
    const file = fileURLToPath(
      new URL('../../../../../../docs/schemas/telemetry-event.v1.schema.json', import.meta.url),
    );
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { const?: unknown; enum?: string[]; pattern?: string }>;
    };
    const shape = TelemetryEventSchema.shape;

    expect(json.additionalProperties).toBe(false);
    expect(Object.keys(json.properties).sort()).toEqual(Object.keys(shape).sort());
    expect([...json.required].sort()).toEqual(Object.keys(shape).sort());
    expect(json.properties.schemaVersion?.const).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(json.properties.event?.enum).toEqual([...TELEMETRY_EVENTS]);
    expect(json.properties.runtime?.enum).toEqual(shape.runtime.options);

    // Same accept/reject behaviour on the two pattern-constrained fields.
    const installId = new RegExp(json.properties.installId?.pattern ?? '');
    const occurredOn = new RegExp(json.properties.occurredOn?.pattern ?? '');
    for (const candidate of [INSTALL_ID, crypto.randomUUID(), 'not-a-uuid', '018f3b1e-7a55-7b0e-9d5e-0c6f1f6f2a11']) {
      expect(installId.test(candidate)).toBe(shape.installId.safeParse(candidate).success);
    }
    for (const candidate of ['2026-11-03', '2026-11-03T00:00:00Z', '03/11/2026']) {
      expect(occurredOn.test(candidate)).toBe(shape.occurredOn.safeParse(candidate).success);
    }
  });
});
