import { describe, expect, it } from 'vitest';
import { getEnvironmentBadge } from '../environment-badge';

describe('getEnvironmentBadge', () => {
  it('shows "dev" on the Vite dev server', () => {
    expect(getEnvironmentBadge({ DEV: true, VITE_LUMIBASE_RELEASE_CHANNEL: 'development' })).toBe('dev');
  });

  it('hides the badge on a production build', () => {
    expect(getEnvironmentBadge({ DEV: false, VITE_LUMIBASE_RELEASE_CHANNEL: 'production' })).toBeNull();
    expect(getEnvironmentBadge({ DEV: false, VITE_LUMIBASE_RELEASE_CHANNEL: undefined })).toBeNull();
  });

  it('labels non-production channels of a built bundle', () => {
    expect(getEnvironmentBadge({ DEV: false, VITE_LUMIBASE_RELEASE_CHANNEL: 'Staging' })).toBe('staging');
    expect(getEnvironmentBadge({ DEV: false, VITE_LUMIBASE_RELEASE_CHANNEL: 'development' })).toBe('dev');
  });
});
