import { describe, expect, it } from 'vitest';

import {
  CONSENT_STORAGE_KEY,
  clearConsent,
  isValidMeasurementId,
  readConsent,
  resolveMeasurementId,
  shouldAskForConsent,
  shouldLoadAnalytics,
  writeConsent,
  type ConsentStorage,
} from './consent';
import { DENIED_CONSENT_SIGNALS, buildGtagBootstrap, gtagScriptUrl, loadGtag } from './gtag';

function memoryStorage(initial: Record<string, string> = {}): ConsentStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const throwingStorage: ConsentStorage = {
  getItem: () => {
    throw new Error('SecurityError: storage disabled');
  },
  setItem: () => {
    throw new Error('SecurityError: storage disabled');
  },
  removeItem: () => {
    throw new Error('SecurityError: storage disabled');
  },
};

describe('readConsent', () => {
  it('returns null when nothing was stored', () => {
    expect(readConsent(memoryStorage())).toBeNull();
  });

  it('round-trips a stored decision', () => {
    const storage = memoryStorage();
    writeConsent(storage, 'granted');
    expect(readConsent(storage)).toBe('granted');

    writeConsent(storage, 'denied');
    expect(readConsent(storage)).toBe('denied');
  });

  it('treats an unrecognised stored value as no decision', () => {
    // A stale key from an older banner, or a hand-edited one, must not be
    // mistaken for a grant.
    expect(readConsent(memoryStorage({ [CONSENT_STORAGE_KEY]: 'yes' }))).toBeNull();
    expect(readConsent(memoryStorage({ [CONSENT_STORAGE_KEY]: 'true' }))).toBeNull();
    expect(readConsent(memoryStorage({ [CONSENT_STORAGE_KEY]: '' }))).toBeNull();
  });

  it('fails closed when storage throws or is missing', () => {
    expect(readConsent(throwingStorage)).toBeNull();
    expect(readConsent(null)).toBeNull();
    expect(readConsent(undefined)).toBeNull();
  });
});

describe('writeConsent / clearConsent', () => {
  it('does not throw when storage is unavailable', () => {
    expect(() => writeConsent(throwingStorage, 'granted')).not.toThrow();
    expect(() => writeConsent(null, 'granted')).not.toThrow();
    expect(() => clearConsent(throwingStorage)).not.toThrow();
    expect(() => clearConsent(null)).not.toThrow();
  });

  it('clearing brings back the undecided state', () => {
    const storage = memoryStorage();
    writeConsent(storage, 'granted');
    clearConsent(storage);
    expect(readConsent(storage)).toBeNull();
  });
});

describe('resolveMeasurementId', () => {
  it('accepts a GA4 measurement ID', () => {
    expect(resolveMeasurementId('G-ABC1234567')).toBe('G-ABC1234567');
  });

  it('trims and upper-cases operator input', () => {
    expect(resolveMeasurementId('  g-abc1234  ')).toBe('G-ABC1234');
  });

  it('returns null when unset or blank — the default is no analytics', () => {
    expect(resolveMeasurementId(undefined)).toBeNull();
    expect(resolveMeasurementId(null)).toBeNull();
    expect(resolveMeasurementId('')).toBeNull();
    expect(resolveMeasurementId('   ')).toBeNull();
  });

  it('rejects anything that is not a measurement ID', () => {
    // UA- properties, GTM containers, and injection attempts all fail the same way:
    // the ID lands inside an inline <script>, so only the exact shape may pass.
    expect(resolveMeasurementId('UA-12345-1')).toBeNull();
    expect(resolveMeasurementId('GTM-ABCD')).toBeNull();
    expect(resolveMeasurementId("G-ABC'});alert(1);//")).toBeNull();
    expect(resolveMeasurementId('G-ABC/../evil')).toBeNull();
    expect(resolveMeasurementId('G-AB')).toBeNull();
  });
});

describe('isValidMeasurementId', () => {
  it('guards against non-strings', () => {
    expect(isValidMeasurementId(undefined)).toBe(false);
    expect(isValidMeasurementId(42)).toBe(false);
    expect(isValidMeasurementId({ toString: () => 'G-ABCD' })).toBe(false);
  });
});

describe('gating', () => {
  const id = 'G-ABC1234';

  it('loads the tag only on an explicit grant', () => {
    expect(shouldLoadAnalytics(id, 'granted')).toBe(true);
    expect(shouldLoadAnalytics(id, 'denied')).toBe(false);
    expect(shouldLoadAnalytics(id, null)).toBe(false);
  });

  it('never loads the tag without a configured ID', () => {
    expect(shouldLoadAnalytics(null, 'granted')).toBe(false);
  });

  it('asks only when there is something to consent to and no answer yet', () => {
    expect(shouldAskForConsent(id, null)).toBe(true);
    expect(shouldAskForConsent(id, 'granted')).toBe(false);
    expect(shouldAskForConsent(id, 'denied')).toBe(false);
    // No GA configured means no cookies, which means no banner to show.
    expect(shouldAskForConsent(null, null)).toBe(false);
  });
});

describe('buildGtagBootstrap', () => {
  const snippet = buildGtagBootstrap('G-ABC1234');

  it('defaults every consent signal to denied before granting analytics', () => {
    const defaultCall = snippet.indexOf("gtag('consent', 'default'");
    const updateCall = snippet.indexOf("gtag('consent', 'update'");
    const configCall = snippet.indexOf("gtag('config'");

    expect(defaultCall).toBeGreaterThanOrEqual(0);
    expect(defaultCall).toBeLessThan(updateCall);
    expect(updateCall).toBeLessThan(configCall);
    expect(snippet).toContain("analytics_storage: 'denied'");
  });

  it('never grants an advertising signal', () => {
    for (const signal of DENIED_CONSENT_SIGNALS) {
      expect(snippet).toContain(`${signal}: 'denied'`);
      expect(snippet).not.toContain(`${signal}: 'granted'`);
    }
    // Tolerant of quoting/spacing: what matters is that both are off.
    expect(snippet).toMatch(/allow_google_signals"?\s*:\s*false/);
    expect(snippet).toMatch(/allow_ad_personalization_signals"?\s*:\s*false/);
  });

  it('grants analytics storage exactly once', () => {
    expect(snippet.match(/analytics_storage: 'granted'/g)).toHaveLength(1);
  });

  it('embeds the measurement ID as a quoted literal', () => {
    expect(snippet).toContain('gtag(\'config\', "G-ABC1234"');
  });

  it('refuses to build a snippet for an unvalidated ID', () => {
    expect(() => buildGtagBootstrap("G-X'});alert(1);//")).toThrow(/invalid measurement ID/);
    expect(() => buildGtagBootstrap('')).toThrow(/invalid measurement ID/);
  });
});

describe('gtagScriptUrl', () => {
  it('points at the tag for the configured property', () => {
    expect(gtagScriptUrl('G-ABC1234')).toBe(
      'https://www.googletagmanager.com/gtag/js?id=G-ABC1234'
    );
  });

  it('refuses an unvalidated ID', () => {
    expect(() => gtagScriptUrl('G-A&id=G-EVIL')).toThrow(/invalid measurement ID/);
  });
});

/**
 * A document stub, so the imperative loader is testable without jsdom. Only the
 * four members `loadGtag` touches are implemented.
 */
function fakeDocument() {
  const head: { children: FakeScript[] } = { children: [] };
  const win: { dataLayer?: unknown[] } = {};

  interface FakeScript {
    id: string;
    async: boolean;
    src: string;
  }

  const doc = {
    defaultView: win,
    getElementById: (id: string) => head.children.find((el) => el.id === id) ?? null,
    createElement: (): FakeScript => ({ id: '', async: false, src: '' }),
    head: {
      appendChild: (el: FakeScript) => void head.children.push(el),
    },
  };

  return { doc: doc as unknown as Document, win, scripts: head.children };
}

describe('loadGtag', () => {
  it('injects an async tag script and applies Consent Mode', () => {
    const { doc, win, scripts } = fakeDocument();

    expect(loadGtag('G-ABC1234', { doc })).toBe(true);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      async: true,
      src: 'https://www.googletagmanager.com/gtag/js?id=G-ABC1234',
    });

    // Pushed as Arguments objects, which is what gtag.js expects; read them back
    // positionally.
    const calls = (win.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(calls.map((call) => [call[0], call[1]])).toEqual([
      ['consent', 'default'],
      ['consent', 'update'],
      ['js', expect.any(Date)],
      ['config', 'G-ABC1234'],
    ]);
    expect(calls[0]?.[2]).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    expect(calls[1]?.[2]).toEqual({ analytics_storage: 'granted' });
    expect(calls[3]?.[2]).toEqual({
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  });

  it('is idempotent — a re-render cannot stack duplicate tags', () => {
    const { doc, win, scripts } = fakeDocument();

    expect(loadGtag('G-ABC1234', { doc })).toBe(true);
    expect(loadGtag('G-ABC1234', { doc })).toBe(false);
    expect(scripts).toHaveLength(1);
    expect(win.dataLayer).toHaveLength(4);
  });

  it('preserves a dataLayer that another script already created', () => {
    const { doc, win } = fakeDocument();
    const existing = [{ event: 'pre-existing' }];
    win.dataLayer = existing;

    loadGtag('G-ABC1234', { doc });

    expect(win.dataLayer).toBe(existing);
    expect(existing[0]).toEqual({ event: 'pre-existing' });
  });

  it('does nothing under SSR, where there is no document', () => {
    expect(loadGtag('G-ABC1234', { doc: undefined })).toBe(false);
  });

  it('refuses an unvalidated ID before touching the document', () => {
    const { doc, scripts } = fakeDocument();

    expect(() => loadGtag('GTM-ABCD', { doc })).toThrow(/invalid measurement ID/);
    expect(scripts).toHaveLength(0);
  });
});
