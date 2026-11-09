// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpStarterPrompts } from '../mcp-setup';
import { MCP_PROMPTS } from '../mcp-prompts';

afterEach(cleanup);

describe('McpStarterPrompts', () => {
  it('copies the exact prompt text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<McpStarterPrompts />);

    const first = MCP_PROMPTS.find((p) => p.category === 'explore')!;
    fireEvent.click(screen.getByRole('button', { name: `Copy prompt: ${first.title}` }));

    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(first.prompt);
  });

  it('switches category and warns when the role cannot run admin prompts', () => {
    render(<McpStarterPrompts roleHasAdminAccess={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }));

    const adminPrompt = MCP_PROMPTS.find((p) => p.access === 'admin')!;
    expect(screen.getByText(adminPrompt.title)).toBeInTheDocument();
    expect(screen.getByText(/selected role has no admin access/)).toBeInTheDocument();
  });

  it('shows no admin warning before a role is chosen', () => {
    render(<McpStarterPrompts />);
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }));
    expect(screen.queryByText(/selected role has no admin access/)).toBeNull();
  });
});
