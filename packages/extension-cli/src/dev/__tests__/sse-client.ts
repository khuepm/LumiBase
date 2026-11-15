/**
 * Minimal SSE consumer standing in for the browser's EventSource in tests.
 * Reads the hub stream with fetch and hands every parsed event to `onEvent`.
 */
export interface SseHandle {
  close(): void;
  ready: Promise<void>;
}

export function openSse(
  url: string,
  init: { headers?: Record<string, string> },
  onEvent: (event: string, data: unknown) => void,
): SseHandle {
  const abort = new AbortController();
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  void (async () => {
    const res = await fetch(url, { headers: init.headers, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        if (event === 'hello') markReady();
        onEvent(event, JSON.parse(data));
      }
    }
  })().catch(() => undefined);

  return { close: () => abort.abort(), ready };
}
