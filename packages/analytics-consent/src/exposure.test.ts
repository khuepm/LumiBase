import { describe, expect, it, vi } from 'vitest';
import { trackVariantExposure, variantFromHeaders, VARIANT_EXPOSURE_EVENT } from './exposure';

describe('trackVariantExposure (#762)', () => {
  it('sends one event only with an explicit grant', () => {
    const gtag = vi.fn();
    expect(trackVariantExposure(gtag, null, { subject: 'home', audience: 'vn' })).toBe(false);
    expect(trackVariantExposure(gtag, 'denied', { subject: 'home', audience: 'vn' })).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
    expect(trackVariantExposure(gtag, 'granted', { subject: 'home', audience: 'vn', variants: ['v1', 'v2'] })).toBe(true);
    expect(gtag).toHaveBeenCalledWith('event', VARIANT_EXPOSURE_EVENT, { lumi_subject: 'home', lumi_audience: 'vn', lumi_variants: 'v1,v2' });
  });

  it('labels the default content and tolerates a missing gtag', () => {
    const gtag = vi.fn();
    trackVariantExposure(gtag, 'granted', { subject: 'home', audience: '_' });
    expect(gtag.mock.calls[0]![2]).toEqual({ lumi_subject: 'home', lumi_audience: 'default' });
    expect(trackVariantExposure(undefined, 'granted', { subject: 'home', audience: null })).toBe(false);
  });

  it('reads the audience from the delivery header', () => {
    expect(variantFromHeaders(new Headers({ 'X-Lumi-Variant': 'gold-members' }))).toBe('gold-members');
    expect(variantFromHeaders(new Headers({ 'X-Lumi-Variant': '_' }))).toBeNull();
    expect(variantFromHeaders(new Headers())).toBeNull();
  });
});
