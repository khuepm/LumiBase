/**
 * AIAssistant — floating chat panel for communicating with the AI agent.
 *
 * Features:
 * - 48×48px floating button at bottom-right (24px offset)
 * - 320×480px chat panel with glassmorphism (backdrop-blur)
 * - State: open, messages[], input, loading
 * - Calls POST /api/v1/ai/chat on send
 * - Shows loading indicator while processing
 * - Distinguishes 'user' and 'assistant' message roles
 * - Shows 'pending_approval' label when status matches
 * - Disables send button when input is empty/whitespace-only
 * - Limits message history to 50 messages
 * - Handles API errors by showing error message in chat
 */

import { useCallback, useRef, useState } from 'react';
import { MessageCircle, Send, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  status?: string;
  approvalId?: string;
}

interface ChatApiResponse {
  data?: {
    status: 'executed' | 'pending_approval' | 'denied';
    data?: unknown;
    approvalId?: string;
    message?: string;
  };
  errors?: Array<{ code: string; message: string }>;
}

const MAX_MESSAGES = 50;

export function AIAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg].slice(-MAX_MESSAGES));
  }, []);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMessage: ChatMessage = { role: 'user', text: trimmed };
    addMessage(userMessage);
    setInput('');
    setLoading(true);
    scrollToBottom();

    try {
      const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
      const token = localStorage.getItem('lumibase_dev_token') ?? '';

      const response = await fetch(`${baseUrl}/api/v1/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as ChatApiResponse | null;
        const errorText =
          errorBody?.errors?.[0]?.message ?? `Request failed with status ${response.status}`;
        addMessage({ role: 'assistant', text: errorText });
      } else {
        const body = (await response.json()) as ChatApiResponse;
        const result = body.data;

        if (result) {
          const assistantText =
            result.message ?? (result.status === 'executed' ? 'Done.' : result.status);
          addMessage({
            role: 'assistant',
            text: assistantText,
            status: result.status,
            approvalId: result.approvalId,
          });
        } else {
          addMessage({ role: 'assistant', text: 'Received an unexpected response.' });
        }
      }
    } catch {
      addMessage({
        role: 'assistant',
        text: 'Network error. Please check your connection and try again.',
      });
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  }, [input, loading, addMessage, scrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const isSendDisabled = !input.trim() || loading;

  return (
    <>
      {/* Floating trigger button */}
      <button
        type="button"
        aria-label={open ? 'Close AI assistant' : 'Open AI assistant'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'fixed z-50 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors',
          'bg-primary text-primary-foreground hover:bg-primary/90',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
        style={{ bottom: 24, right: 24 }}
      >
        {open ? (
          <X className="h-5 w-5" aria-hidden="true" />
        ) : (
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          role="dialog"
          aria-label="AI Assistant"
          className={cn(
            'fixed z-50 flex flex-col rounded-lg border shadow-xl',
            'bg-background/80 backdrop-blur-xl',
            'animate-in fade-in-0 slide-in-from-bottom-2',
          )}
          style={{ bottom: 84, right: 24, width: 320, height: 480 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-semibold">AI Assistant</span>
            <button
              type="button"
              aria-label="Close AI assistant"
              onClick={() => setOpen(false)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-3 py-3" aria-live="polite" aria-atomic="false">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
                <p>Send a message to start chatting with the AI assistant.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {messages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      'max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed',
                      msg.role === 'user'
                        ? 'ml-auto bg-primary text-primary-foreground'
                        : 'mr-auto bg-muted text-foreground',
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                    {msg.status === 'pending_approval' && (
                      <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        pending_approval
                      </span>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="mr-auto flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    <span>Thinking…</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t px-3 py-2">
            <div className="flex items-end gap-2">
              <textarea
                aria-label="Message input"
                placeholder="Ask the AI…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                className={cn(
                  'flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-xs',
                  'placeholder:text-muted-foreground',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  'max-h-20 min-h-[32px]',
                )}
              />
              <button
                type="button"
                aria-label="Send message"
                disabled={isSendDisabled}
                onClick={() => void handleSend()}
                className={cn(
                  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSendDisabled
                    ? 'cursor-not-allowed text-muted-foreground'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
