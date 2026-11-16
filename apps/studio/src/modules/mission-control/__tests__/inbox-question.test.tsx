// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AgentQuestion } from '../api';

/**
 * Mission Control inbox — answering an `askUser` question (#710).
 *
 * The inbox is the human end of the clarification tool: a run is parked in
 * `waiting_user` behind every entry here. These tests pin what an operator
 * does with one: see the question and its choices, answer it through the API
 * (once), and see the server's refusal when the answer is not accepted.
 */

const api = vi.hoisted(() => ({
  approvals: vi.fn(),
  questions: vi.fn(),
  answerQuestion: vi.fn(),
  decideApproval: vi.fn().mockResolvedValue(undefined),
  staged: vi.fn(),
  veto: vi.fn().mockResolvedValue(undefined),
  autonomy: vi.fn(),
  intents: vi.fn(),
  resumeIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

import { ExceptionInbox } from '../inbox';
import { buildCounts, buildEntries } from '../use-inbox';

function question(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: 'q_1',
    runId: 'run_1',
    goalId: 'goal_1',
    toolCallId: 'tc_1',
    agentName: 'writer',
    question: 'Formal or casual tone?',
    options: ['formal', 'casual'],
    allowFreeText: true,
    context: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    answer: null,
    answeredAt: null,
    answeredBy: null,
    ...overrides,
  };
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  api.approvals.mockResolvedValue([]);
  api.staged.mockResolvedValue([]);
  api.autonomy.mockResolvedValue({ grants: [], openIncidents: [] });
  api.intents.mockResolvedValue([]);
  api.questions.mockResolvedValue([question()]);
  api.answerQuestion.mockResolvedValue({ ...question(), status: 'answered', answer: 'formal' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExceptionInbox · agent questions', () => {
  it('shows the question with its choices and answers it with the chosen option', async () => {
    renderWithClient(<ExceptionInbox />);

    expect(await screen.findByText(/Formal or casual tone\?/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: /answer question from writer/i });
    const send = within(form).getByRole('button', { name: /^answer$/i });
    expect(send).toBeDisabled();

    fireEvent.click(within(form).getByRole('button', { name: 'formal' }));
    expect(within(form).getByRole('button', { name: 'formal' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(send);

    await waitFor(() => expect(api.answerQuestion).toHaveBeenCalledWith('q_1', 'formal'));
    expect(api.answerQuestion).toHaveBeenCalledTimes(1);
    // The inbox re-reads its questions so the answered one leaves the list.
    await waitFor(() => expect(api.questions.mock.calls.length).toBeGreaterThan(1));
  });

  it('accepts free text when the agent allows it', async () => {
    api.questions.mockResolvedValue([question({ options: [], question: 'Which campaign is this for?' })]);
    renderWithClient(<ExceptionInbox />);

    const box = await screen.findByLabelText(/your answer/i);
    fireEvent.change(box, { target: { value: '  Spring launch  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));

    await waitFor(() => expect(api.answerQuestion).toHaveBeenCalledWith('q_1', 'Spring launch'));
  });

  it('offers only the choices when the agent asked for one of them', async () => {
    api.questions.mockResolvedValue([question({ allowFreeText: false })]);
    renderWithClient(<ExceptionInbox />);

    await screen.findByText(/Formal or casual tone\?/);
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'casual' }));
    fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));
    await waitFor(() => expect(api.answerQuestion).toHaveBeenCalledWith('q_1', 'casual'));
  });

  it('shows the server refusal instead of pretending the run resumed', async () => {
    api.answerQuestion.mockRejectedValue(new Error('Question already answered'));
    renderWithClient(<ExceptionInbox />);

    fireEvent.click(await screen.findByRole('button', { name: 'formal' }));
    fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Question already answered');
  });
});

describe('buildEntries · questions', () => {
  it('lists pending questions as their own entries and never as approvals', () => {
    const now = Date.now();
    const entries = buildEntries(
      [
        {
          id: 'q_row',
          runId: 'run_1',
          subjectType: 'tool_call',
          subjectId: 'tc_1',
          status: 'pending',
          kind: 'question',
          autoCommitAt: null,
          requestedByAgent: 'writer',
          approverType: 'human',
          createdAt: new Date(now).toISOString(),
        },
      ],
      [],
      [],
      [],
      now,
      [question(), question({ id: 'q_done', status: 'answered' })],
    );
    expect(entries.map((entry) => entry.id)).toEqual(['question:q_1']);
    expect(buildCounts(entries)).toMatchObject({ total: 1, questions: 1, approvals: 0 });
  });
});
