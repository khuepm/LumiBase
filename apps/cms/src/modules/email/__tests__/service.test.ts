import { describe, it, expect, vi } from 'vitest';
import {
  EmailModuleService,
  EmailNotConfiguredError,
  TemplateNotFoundError,
} from '../service';
import type { EmailService } from '../../../services/email/email-service';
import type { DeliveryResult } from '../../notifications/types';

/**
 * EmailModuleService coverage — the render+send logic the routes delegate to.
 * The DB is faked just enough to back `render()` lookups; EmailService is a
 * stub capturing the message it would send.
 */

interface FakeRow {
  id: string;
  siteId: string;
  key: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string | null;
  layoutId?: string | null;
  html?: string;
  enabled?: boolean;
}

/**
 * Minimal Drizzle-shaped fake: `db.select().from(table).where(...).limit(n)`
 * resolves to the seeded rows. The render paths under test query only the
 * templates table (no-layout fixtures), so we return `templates` unless the
 * caller tags a fake table object with `__kind: 'layouts'`.
 */
function fakeDb(fixtures: { templates: FakeRow[]; layouts: FakeRow[] }) {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows =
            (table as { __kind?: string }).__kind === 'layouts'
              ? fixtures.layouts
              : fixtures.templates;
          const chain = {
            where() {
              return chain;
            },
            limit() {
              return Promise.resolve(rows);
            },
            then(resolve: (v: FakeRow[]) => unknown) {
              return Promise.resolve(rows).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
}

function stubEmailService(result: DeliveryResult = { ok: true }) {
  const sent: unknown[] = [];
  const svc = {
    transportKind: 'smtp' as const,
    defaultFrom: 'no-reply@test',
    async send(msg: unknown) {
      sent.push(msg);
      return result;
    },
  } as unknown as EmailService;
  return { svc, sent };
}

// The service introspects table identity by reference; we tag our fake table
// objects and patch the imported tables for `render()` to read. Simpler: drive
// only the paths that don't depend on table identity (capabilities + inline
// send + not-configured), and render via a templates-only fixture.

describe('EmailModuleService.capabilities', () => {
  it('reports configured when an EmailService is present', () => {
    const { svc } = stubEmailService();
    const service = new EmailModuleService({ db: {} as never, siteId: 's1', emailService: svc });
    expect(service.capabilities()).toEqual({ configured: true, transport: 'smtp', from: 'no-reply@test' });
  });

  it('reports not configured in degraded mode', () => {
    const service = new EmailModuleService({ db: {} as never, siteId: 's1', emailService: null });
    expect(service.capabilities()).toEqual({ configured: false, transport: null, from: null });
  });
});

describe('EmailModuleService.send (inline)', () => {
  it('throws EmailNotConfiguredError when no transport', async () => {
    const service = new EmailModuleService({ db: {} as never, siteId: 's1', emailService: null });
    await expect(
      service.send({ to: ['a@b.c'], inline: { subject: 's', text: 't' }, variables: {} }),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it('sends an inline message verbatim and returns the delivery result', async () => {
    const { svc, sent } = stubEmailService({ ok: true });
    const service = new EmailModuleService({ db: {} as never, siteId: 's1', emailService: svc });
    const { result, rendered } = await service.send({
      to: ['a@b.c'],
      inline: { subject: 'Hi', html: '<p>x</p>', text: 'x' },
      variables: {},
    });
    expect(result).toEqual({ ok: true });
    expect(rendered.subject).toBe('Hi');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['a@b.c'], subject: 'Hi', html: '<p>x</p>' });
  });

  it('surfaces a failed delivery result', async () => {
    const { svc } = stubEmailService({ ok: false, error: 'smtp-550', retryable: false });
    const service = new EmailModuleService({ db: {} as never, siteId: 's1', emailService: svc });
    const { result } = await service.send({
      to: ['a@b.c'],
      inline: { subject: 'Hi', text: 'x' },
      variables: {},
    });
    expect(result).toEqual({ ok: false, error: 'smtp-550', retryable: false });
  });
});

describe('EmailModuleService.render', () => {
  it('throws TemplateNotFoundError for an unknown key', async () => {
    const db = fakeDb({ templates: [], layouts: [] });
    const service = new EmailModuleService({
      db: db as never,
      siteId: 's1',
      emailService: null,
    });
    await expect(service.render('missing', {})).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('renders subject + body with variable substitution (no layout)', async () => {
    const db = fakeDb({
      templates: [
        {
          id: 't1',
          siteId: 's1',
          key: 'welcome',
          subject: 'Hi {{name}}',
          bodyHtml: '<p>Hello {{name}}</p>',
          bodyText: null,
          layoutId: null,
        },
      ],
      layouts: [],
    });
    const service = new EmailModuleService({ db: db as never, siteId: 's1', emailService: null });
    const out = await service.render('welcome', { name: 'Sam' });
    expect(out.subject).toBe('Hi Sam');
    expect(out.html).toBe('<p>Hello Sam</p>');
    expect(out.missing).toEqual([]);
  });
});
