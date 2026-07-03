import { registerProvider } from './provider';
import { vercelProvider } from './vercel';
import { netlifyProvider } from './netlify';

/**
 * Register the built-in deployment providers. Importing this module wires the
 * registry; the DeploymentService imports it for its side effect.
 */
registerProvider(vercelProvider);
registerProvider(netlifyProvider);

export * from './provider';
export { vercelProvider, mapVercelStatus } from './vercel';
export { netlifyProvider, mapNetlifyStatus } from './netlify';
