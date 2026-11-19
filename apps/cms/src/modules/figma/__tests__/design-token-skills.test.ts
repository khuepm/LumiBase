/**
 * Agent skills for design tokens (#758): `mapDesignTokens` is read-only and
 * runs without approval; `applyThemeOverrides` changes every editor's Studio
 * and is classified control-plane (HITL / autonomy gated).
 */
import { describe, expect, it } from 'vitest';
import { CORE_SKILLS as CATALOGUE } from '@lumibase/ai-skills';
import { CORE_SKILLS, isControlPlaneSkill } from '../../../services/ai-harness';
import { mapFrame } from '../mapper';
import { HERO_FRAME } from './fixtures';

describe('design-token skills', () => {
  it('are in both the executable registry and the LLM catalogue', () => {
    for (const name of ['mapDesignTokens', 'applyThemeOverrides']) {
      expect(CORE_SKILLS[name], name).toBeDefined();
      expect(CATALOGUE[name], name).toBeDefined();
      expect(CATALOGUE[name]!.requiredCapabilities).toEqual(CORE_SKILLS[name]!.requiredCapabilities);
    }
  });

  it('mapDesignTokens maps preview tokens to theme overrides and needs no approval', async () => {
    expect(isControlPlaneSkill(CORE_SKILLS.mapDesignTokens!, 'mapDesignTokens')).toBe(false);
    const out = (await CORE_SKILLS.mapDesignTokens!.handler({ tokens: mapFrame(HERO_FRAME).tokens })) as { light: Record<string, string> };
    expect(out.light['--primary']).toBe('243.4 75.4% 58.6%');
    await expect(CORE_SKILLS.mapDesignTokens!.handler({ tokens: { colors: [{ hex: 'red', count: 1, usage: [] }] } })).rejects.toThrow(/INVALID_INPUT/);
  });

  it('applyThemeOverrides is governed and validates against the Studio token whitelist', async () => {
    expect(isControlPlaneSkill(CORE_SKILLS.applyThemeOverrides!, 'applyThemeOverrides')).toBe(true);
    // The offline registry has no site database: it refuses rather than pretending.
    await expect(CORE_SKILLS.applyThemeOverrides!.handler({ themeOverrides: { light: { '--primary': '240 5.9% 10%' } } })).rejects.toThrow(/SITE_DB_NOT_CONFIGURED/);
  });
});
