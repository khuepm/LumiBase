import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineIntentHandler, type IntentHandlerDefinition, type StudioIntent as SdkIntent } from '@lumibase/extension-sdk';
import type { StudioIntent } from '@lumibase/contracts/intents';
import {
  capabilitiesCoverIntent,
  clearIntentHandlers,
  rankIntentClaims,
  registerIntentHandlers,
  resolveIntent,
} from '../registry';

// The SDK mirrors the contract type structurally; both directions must hold.
const toSdk = (i: StudioIntent): SdkIntent => i;
const toContract = (i: SdkIntent): StudioIntent => i;
void toSdk;
void toContract;

const edit: StudioIntent = { v: 1, action: 'edit', collection: 'posts', id: 'p1', field: 'title' };

function handler(id: string, priority: number, navigate = `/content/posts/p1?by=${id}`): IntentHandlerDefinition {
  return defineIntentHandler({ id, canHandle: () => priority, handle: () => ({ navigate }) });
}

afterEach(() => clearIntentHandlers());

describe('capability scoping', () => {
  it.each([
    [['intents:claim:edit:posts'], true],
    [['intents:claim:*:posts'], true],
    [['intents:claim:edit:*'], true],
    [['intents:claim:*:*'], true],
    [['intents:claim:open:posts'], false],
    [['intents:claim:edit:pages'], false],
    [['items:read:posts'], false],
    [['intents:claim:edit:posts:extra'], false],
    [[], false],
  ])('%j covers edit/posts → %s', (caps, expected) => {
    expect(capabilitiesCoverIntent(caps, edit)).toBe(expected);
  });

  it('ignores handlers of an extension without a covering capability', async () => {
    registerIntentHandlers('ext-a', ['intents:claim:edit:pages'], [handler('h', 10)]);
    expect(rankIntentClaims(edit)).toEqual([]);
    expect(await resolveIntent(edit, 's1')).toMatchObject({ source: 'built-in', reason: 'no_claim' });
  });

  it('registers nothing without any intent capability', () => {
    expect(registerIntentHandlers('ext-a', ['items:read:posts'], [handler('h', 10)])).toBe(0);
  });
});

describe('deterministic resolution', () => {
  it('highest priority wins', async () => {
    registerIntentHandlers('ext-a', ['intents:claim:*:*'], [handler('low', 1)]);
    registerIntentHandlers('ext-b', ['intents:claim:*:*'], [handler('high', 5)]);
    expect(await resolveIntent(edit, 's1')).toEqual({
      source: 'extension',
      extension: 'ext-b',
      handlerId: 'high',
      path: '/content/posts/p1?by=high',
    });
  });

  it('ties break on extension name then handler id, independent of registration order', async () => {
    registerIntentHandlers('ext-z', ['intents:claim:*:*'], [handler('a', 3)]);
    registerIntentHandlers('ext-m', ['intents:claim:*:*'], [handler('b', 3), handler('a', 3)]);
    expect(rankIntentClaims(edit).map((c) => `${c.extension}/${c.handlerId}`)).toEqual([
      'ext-m/a',
      'ext-m/b',
      'ext-z/a',
    ]);
  });

  it('declines on 0, negative, NaN, Infinity, false and a throwing canHandle', async () => {
    const values = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, false, null];
    registerIntentHandlers(
      'ext-a',
      ['intents:claim:*:*'],
      [
        ...values.map((v, i) => defineIntentHandler({ id: `h${i}`, canHandle: () => v as number, handle: () => ({ navigate: '/x' }) })),
        defineIntentHandler({ id: 'boom', canHandle: () => { throw new Error('x'); }, handle: () => ({ navigate: '/x' }) }),
      ],
    );
    expect(rankIntentClaims(edit)).toEqual([]);
  });

  it('passes the built-in path and site to the handler', async () => {
    const handle = vi.fn(() => ({ navigate: '/content/posts/p1' }));
    registerIntentHandlers('ext-a', ['intents:claim:edit:posts'], [defineIntentHandler({ id: 'h', canHandle: () => 1, handle })]);
    await resolveIntent(edit, 'site_9');
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), {
      siteId: 'site_9',
      builtInPath: '/content/posts/p1?field=title',
    });
  });
});

describe('fallback to the built-in handler', () => {
  it('when the winner throws', async () => {
    registerIntentHandlers('ext-a', ['intents:claim:*:*'], [
      defineIntentHandler({ id: 'h', canHandle: () => 9, handle: () => { throw new Error('nope'); } }),
    ]);
    expect(await resolveIntent(edit, 's1')).toEqual({
      source: 'built-in',
      path: '/content/posts/p1?field=title',
      reason: 'handler_error',
    });
  });

  it('when the winner hands the intent back', async () => {
    registerIntentHandlers('ext-a', ['intents:claim:*:*'], [
      defineIntentHandler({ id: 'h', canHandle: () => 9, handle: async () => ({ fallback: true }) }),
    ]);
    expect(await resolveIntent(edit, 's1')).toMatchObject({ source: 'built-in', reason: 'declined' });
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/intent/edit?collection=posts&id=p1',
    '/lumi-7f3a9c/intent/edit?collection=posts&id=p1',
  ])('when the winner returns an unsafe target %j (open redirect / loop)', async (navigate) => {
    registerIntentHandlers('ext-a', ['intents:claim:*:*'], [handler('h', 9, navigate)]);
    expect(await resolveIntent(edit, 's1')).toMatchObject({ source: 'built-in', reason: 'unsafe_target' });
  });

  it('skips malformed handler definitions and duplicate ids', () => {
    const kept = registerIntentHandlers('ext-a', ['intents:claim:*:*'], [
      { id: 'ok', canHandle: () => 1, handle: () => ({ navigate: '/x' }) },
      { id: 'ok', canHandle: () => 2, handle: () => ({ navigate: '/y' }) },
      { id: '', canHandle: () => 1, handle: () => ({}) },
      { canHandle: () => 1 },
      null,
    ]);
    expect(kept).toBe(1);
  });
});
