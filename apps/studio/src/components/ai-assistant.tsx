/**
 * AIAssistant — floating chat panel for communicating with the AI agent.
 *
 * Features:
 * - 48×48px floating button at bottom-right (24px offset)
 * - 320×480px chat panel with glassmorphism (backdrop-blur)
 * - Conversation history with persistence (POST-GA Task #2)
 * - Calls POST /api/v1/ai/chat on send
 * - Shows loading indicator while processing
 * - Distinguishes 'user' and 'assistant' message roles
 * - Shows 'pending_approval' label when status matches
 * - Disables send button when input is empty/whitespace-only
 * - Limits message history to 50 messages
 * - Handles API errors by showing error message in chat
 * - Conversation selector dropdown to switch between conversations
 * - "New conversation" button
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, X, Loader2, Plus, ChevronDown, Trash2, Paperclip, Upload, FileText, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getActiveSite, getActiveToken, getApiClient } from '@/lib/api';
import { useMediaPicker } from '@/modules/files/media-picker';
import { getApiBaseUrl } from '@/lib/api-base';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  status?: string;
  approvalId?: string;
  /** Files sent with a user turn (#709): names only, the bytes are never kept. */
  attachments?: ChatAttachment[];
}

/** A media-library file attached to the next turn (#709). */
export interface ChatAttachment {
  fileId: string;
  name: string;
  mimeType: string;
}

/** What the model accepts as input; mirrors `AI_ATTACHMENT_LIMITS` in the CMS. */
export const ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const;
export const MAX_ATTACHMENTS = 4;

/** Adds `next` to `current` without duplicates, capped at {@link MAX_ATTACHMENTS}. */
export function mergeAttachments(current: ChatAttachment[], next: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set(current.map((a) => a.fileId));
  const merged = [...current];
  for (const attachment of next) {
    if (merged.length >= MAX_ATTACHMENTS) break;
    if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(attachment.mimeType) || seen.has(attachment.fileId)) continue;
    seen.add(attachment.fileId);
    merged.push(attachment);
  }
  return merged;
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface ChatApiResponse {
  data?: {
    status: 'executed' | 'pending_approval' | 'denied';
    data?: unknown;
    approvalId?: string;
    message?: string;
    conversationId?: string;
  };
  errors?: Array<{ code: string; message: string }>;
}

const MAX_MESSAGES = 50;

function getApiHeaders(): Record<string, string> {
  const token = getActiveToken();
  return {
    'Content-Type': 'application/json',
    'X-Lumi-Site': getActiveSite(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function getBaseUrl(): string {
  return getApiBaseUrl();
}

export function AIAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showConvDropdown, setShowConvDropdown] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const openMediaPicker = useMediaPicker();

  async function pickFromLibrary() {
    if (!openMediaPicker) return;
    const picked = await openMediaPicker({
      multiple: true,
      allowedMimeTypes: [...ATTACHMENT_MIME_TYPES],
      max: Math.max(1, MAX_ATTACHMENTS - attachments.length),
    });
    if (!picked) return;
    setAttachments((prev) =>
      mergeAttachments(prev, picked.map((f) => ({ fileId: f.id, name: f.filenameDownload, mimeType: f.mime }))),
    );
  }

  /** Upload from the device into the media library, then attach (#709). */
  async function uploadAndAttach(list: FileList | null) {
    const chosen = Array.from(list ?? []).slice(0, MAX_ATTACHMENTS - attachments.length);
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      const client = getApiClient();
      const added: ChatAttachment[] = [];
      for (const file of chosen) {
        const { data: presigned } = await client.files.getPresignedUrl(file.name);
        const put = await fetch(presigned.url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!put.ok) throw new Error(`Upload of "${file.name}" failed (${put.status}).`);
        const { data } = await client.files.create({
          filenameDisk: presigned.key,
          filenameDownload: file.name,
          mime: file.type || 'application/octet-stream',
          filesize: file.size,
        });
        added.push({ fileId: data.id, name: data.filenameDownload, mimeType: data.mime });
      }
      setAttachments((prev) => mergeAttachments(prev, added));
    } catch (err) {
      addMessage({ role: 'assistant', text: err instanceof Error ? err.message : 'Upload failed.' });
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  }

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg].slice(-MAX_MESSAGES));
  }, []);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }, []);

  // Load conversations list when panel opens
  useEffect(() => {
    if (!open) return;
    void loadConversations();
  }, [open]);

  async function loadConversations() {
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/ai/conversations`, {
        headers: getApiHeaders(),
      });
      if (res.ok) {
        const body = (await res.json()) as { data: ConversationSummary[] };
        setConversations(body.data);
      }
    } catch {
      // silently fail
    }
  }

  async function loadConversationMessages(convId: string) {
    try {
      const res = await fetch(
        `${getBaseUrl()}/api/v1/ai/conversations/${convId}/messages`,
        { headers: getApiHeaders() },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          data: Array<{
            role: string;
            content: string;
            metadata?: { status?: string; approvalId?: string; attachments?: ChatAttachment[] };
          }>;
        };
        const loaded: ChatMessage[] = body.data
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            text: m.content,
            status: m.metadata?.status,
            approvalId: m.metadata?.approvalId,
            ...(m.metadata?.attachments?.length ? { attachments: m.metadata.attachments } : {}),
          }));
        setMessages(loaded.slice(-MAX_MESSAGES));
        setConversationId(convId);
        scrollToBottom();
      }
    } catch {
      // silently fail
    }
  }

  function startNewConversation() {
    setConversationId(null);
    setMessages([]);
    setShowConvDropdown(false);
  }

  async function deleteConversation(convId: string) {
    try {
      await fetch(`${getBaseUrl()}/api/v1/ai/conversations/${convId}`, {
        method: 'DELETE',
        headers: getApiHeaders(),
      });
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (conversationId === convId) {
        startNewConversation();
      }
    } catch {
      // silently fail
    }
  }

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const sending = attachments;
    const userMessage: ChatMessage = {
      role: 'user',
      text: trimmed,
      ...(sending.length > 0 ? { attachments: sending } : {}),
    };
    addMessage(userMessage);
    setInput('');
    setAttachments([]);
    setLoading(true);
    scrollToBottom();

    try {
      const response = await fetch(`${getBaseUrl()}/api/v1/ai/chat`, {
        method: 'POST',
        headers: {
          ...getApiHeaders(),
          Prefer: 'respond-async',
        },
        body: JSON.stringify({
          message: trimmed,
          ...(conversationId ? { conversationId } : {}),
          ...(sending.length > 0 ? { attachments: sending.map((a) => ({ fileId: a.fileId })) } : {}),
        }),
      });

      if (response.status === 202) {
        const body = (await response.json()) as ChatApiResponse;
        const runId = (body.data as { runId?: string })?.runId;
        addMessage({
          role: 'assistant',
          text: runId
            ? `Request queued (run ${runId}). Poll GET /api/v1/flows/runs/${runId} for the result.`
            : 'Request queued for async processing.',
          status: 'pending',
        });
      } else if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as ChatApiResponse | null;
        const errorText =
          errorBody?.errors?.[0]?.message ?? `Request failed with status ${response.status}`;
        addMessage({ role: 'assistant', text: errorText });
      } else {
        const body = (await response.json()) as ChatApiResponse;
        const result = body.data;

        if (result) {
          // Save conversationId from server
          if (result.conversationId && !conversationId) {
            setConversationId(result.conversationId);
          }

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
      // Refresh conversations list
      void loadConversations();
    }
  }, [input, loading, attachments, addMessage, scrollToBottom, conversationId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const isSendDisabled = !input.trim() || loading || uploading;
  const canAttachMore = attachments.length < MAX_ATTACHMENTS && !uploading;

  return (
    <>
      {/* Floating trigger button */}
      <button
        type="button"
        aria-label={open ? 'Close AI assistant' : 'Open AI assistant'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'fixed bottom-24 z-50 flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors md:bottom-6',
          'bg-primary text-primary-foreground hover:bg-primary/90',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
        // Above the mobile bottom nav (md:hidden, ~64px); 24px from the edge on desktop.
        style={{ insetInlineEnd: 24 }}
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
            'fixed bottom-40 z-50 flex max-w-[calc(100vw-48px)] flex-col rounded-lg border shadow-xl md:bottom-[84px]',
            'bg-background/80 backdrop-blur-xl',
            'animate-in fade-in-0 slide-in-from-bottom-2',
          )}
          style={{ insetInlineEnd: 24, width: 320, height: 480 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">AI Assistant</span>
              {/* Conversation selector */}
              <div className="relative">
                <button
                  type="button"
                  aria-label="Select conversation"
                  onClick={() => setShowConvDropdown((v) => !v)}
                  className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </button>
                {showConvDropdown && (
                  <div className="absolute start-0 top-7 z-50 w-56 rounded-md border bg-background shadow-lg">
                    <button
                      type="button"
                      onClick={startNewConversation}
                      className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted"
                    >
                      <Plus className="h-3 w-3" /> New conversation
                    </button>
                    <div className="max-h-48 overflow-y-auto border-t">
                      {conversations.map((conv) => (
                        <div
                          key={conv.id}
                          className={cn(
                            'flex items-center justify-between px-3 py-2 text-xs hover:bg-muted',
                            conversationId === conv.id && 'bg-muted/50',
                          )}
                        >
                          <button
                            type="button"
                            className="flex-1 truncate text-start"
                            onClick={() => {
                              void loadConversationMessages(conv.id);
                              setShowConvDropdown(false);
                            }}
                          >
                            {conv.title}
                          </button>
                          <button
                            type="button"
                            aria-label="Delete conversation"
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteConversation(conv.id);
                            }}
                            className="ms-1 flex-shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                      {conversations.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          No conversations yet.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="New conversation"
                onClick={startNewConversation}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Close AI assistant"
                onClick={() => setOpen(false)}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
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
                        ? 'ms-auto bg-primary text-primary-foreground'
                        : 'me-auto bg-muted text-foreground',
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[10px] opacity-80" aria-label="Attached files">
                        {msg.attachments.map((a) => (
                          <li key={a.fileId} className="flex items-center gap-1 truncate">
                            {a.mimeType === 'application/pdf' ? (
                              <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                            ) : (
                              <ImageIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{a.name}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {msg.status === 'pending_approval' && (
                      <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        pending_approval
                      </span>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="me-auto flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
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
            {attachments.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-1" aria-label="Files to send">
                {attachments.map((a) => (
                  <li
                    key={a.fileId}
                    className="flex max-w-full items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-[10px]"
                  >
                    {a.mimeType === 'application/pdf' ? (
                      <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <ImageIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                    )}
                    <span className="max-w-[140px] truncate">{a.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => setAttachments((prev) => prev.filter((p) => p.fileId !== a.fileId))}
                      className="rounded p-0.5 hover:bg-background"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-end gap-2">
              {openMediaPicker && (
                <button
                  type="button"
                  aria-label="Attach an image or PDF from the media library"
                  title="Attach from media library"
                  disabled={!canAttachMore}
                  onClick={() => void pickFromLibrary()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                aria-label="Upload an image or PDF and attach it"
                title="Upload and attach"
                disabled={!canAttachMore}
                onClick={() => uploadInputRef.current?.click()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_MIME_TYPES.join(',')}
                className="hidden"
                data-testid="ai-attachment-upload"
                onChange={(e) => void uploadAndAttach(e.target.files)}
              />
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
