import { defaultProviderDeps, type ProviderDeps } from './providers';

/**
 * Network/JWKS dependencies the routes hand to the providers. A holder (not a
 * bare import) so tests can swap in a mocked `fetch` and a local JWKS without
 * touching the network.
 */
export const providerDeps: { current: ProviderDeps } = { current: defaultProviderDeps };
