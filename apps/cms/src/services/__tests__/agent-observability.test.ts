import { describe, expect, it } from 'vitest';
import { metricAgent, metricTool, metricReason, metricKind, metricStatus, observeAgentCost, agentEstimatedTokensTotal, agentEstimatedCostUsdTotal } from '../agent-metrics';
import { maskSecrets, runErrorMessage, safeRequestId } from '../agent-run-service';

describe('#584 bounded and redacted observability', () => {
  it('maps arbitrary identifiers into a fixed vocabulary', () => {
    for (let i = 0; i < 1000; i++) {
      expect(metricAgent(`tenant-agent-${i}`)).toBe('custom');
      expect(metricTool(`plugin-${i}`)).toBe('custom');
      expect(metricReason(`private-error-${i}`)).toBe('other');
      expect(metricKind(`eval-${i}`)).toBe('other');
      expect(metricStatus(`status-${i}`)).toBe('other');
    }
    expect(metricTool('createItem')).toBe('createItem');
    expect(metricAgent('lumibase-copilot')).toBe('lumibase-copilot');
  });
  it('records numeric usage under bounded tool labels', async () => {
    agentEstimatedTokensTotal.reset(); agentEstimatedCostUsdTotal.reset();
    observeAgentCost('customer-private-tool', { tokens: 42, usd: 0.25 });
    observeAgentCost('customer-private-tool', { tokens: Infinity, usd: -1 });
    expect((await agentEstimatedTokensTotal.get()).values).toEqual([expect.objectContaining({ value: 42, labels: { tool: 'custom' } })]);
    expect((await agentEstimatedCostUsdTotal.get()).values).toEqual([expect.objectContaining({ value: 0.25, labels: { tool: 'custom' } })]);
  });
  it('keeps useful identifiers but removes secret and personal values', () => {
    const input = { id: 'item_584', email: 'private@example.dev', phone: '123456', apiToken: 'secret584', title: 'Contact private@example.dev', nested: { password: 'secret584' } };
    const encoded = JSON.stringify(maskSecrets(input));
    expect(encoded).toContain('item_584');
    for (const value of ['private@example.dev', '123456', 'secret584']) expect(encoded).not.toContain(value);
    const driver = Object.assign(new Error('invalid value "private@example.dev secret584"'), { code: '22P02' });
    expect(runErrorMessage(new Error('Failed query: select\nparams: secret584', { cause: driver }))).toBe('Database query failed (SQLSTATE 22P02)');
    expect(safeRequestId('req_584')).toBe('req_584');
    expect(safeRequestId('private@example.dev')).toBeNull();
    expect(safeRequestId('x'.repeat(65))).toBeNull();
  });
});
