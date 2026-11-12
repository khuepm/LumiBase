import { ASK_USER_LIMITS } from '@lumibase/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageCircleQuestion, Send } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { missionControlApi, type AgentQuestion } from './api';

/**
 * Answer box for an `askUser` question (#710). Shown in the exception inbox
 * list (compact) and in the inbox detail pane. Options the agent offered are
 * buttons that fill the answer; free text is offered unless the agent asked
 * for one of the options only. The CMS enforces the same rules — this form
 * only saves a round trip.
 */
export function QuestionAnswerForm({
  question,
  compact = false,
  onAnswered,
}: {
  question: AgentQuestion;
  compact?: boolean;
  onAnswered?: () => void;
}) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState('');
  const mutation = useMutation({
    mutationFn: (value: string) => missionControlApi.answerQuestion(question.id, value),
    onSuccess: () => {
      setAnswer('');
      queryClient.invalidateQueries({ queryKey: ['mc-questions'] });
      queryClient.invalidateQueries({ queryKey: ['mc-approvals'] });
      onAnswered?.();
    },
  });

  const trimmed = answer.trim();
  const choiceOnly = !question.allowFreeText && question.options.length > 0;
  const valid = trimmed.length > 0 && (!choiceOnly || question.options.includes(trimmed));
  const inputId = `question-answer-${question.id}`;

  return (
    <form
      className="space-y-2"
      aria-label={`Answer question from ${question.agentName}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !mutation.isPending) mutation.mutate(trimmed);
      }}
    >
      {!compact && (
        <p className="text-sm">
          <MessageCircleQuestion className="mr-1 inline h-4 w-4 text-violet-600" />
          {question.question}
        </p>
      )}
      {!compact && question.context && (
        <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
          {question.context}
        </p>
      )}
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested answers">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setAnswer(option)}
              aria-pressed={trimmed === option}
              className={cn(
                'rounded-md border px-2 py-1 text-xs hover:bg-muted',
                trimmed === option && 'border-violet-500 bg-violet-50 text-violet-800',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {!choiceOnly && (
          <label htmlFor={inputId} className="block grow text-xs font-medium text-muted-foreground">
            Your answer (shared with the agent as data)
            <textarea
              id={inputId}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              maxLength={ASK_USER_LIMITS.answer}
              rows={compact ? 1 : 3}
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
            />
          </label>
        )}
        <button
          type="submit"
          disabled={!valid || mutation.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-violet-400 px-3 py-2 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
        >
          <Send className="h-3 w-3" /> {mutation.isPending ? 'Sending…' : 'Answer'}
        </button>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          {mutation.error instanceof Error ? mutation.error.message : 'The answer was not accepted.'}
        </p>
      )}
    </form>
  );
}
