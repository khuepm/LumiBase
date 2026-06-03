"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient, type PresenceEntry, type RealtimeEvent } from "@lumibase/sdk";

type RealtimeTesterProps = {
  baseUrl: string;
  siteId: string;
  token: string;
  collection?: string;
};

type LogEntry = {
  at: string;
  message: string;
};

const now = () => new Date().toLocaleTimeString();

export function RealtimeTester({
  baseUrl,
  siteId,
  token,
  collection = "posts",
}: RealtimeTesterProps) {
  const clientRef = useRef<RealtimeClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const presenceUnsubscribeRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "disconnected">("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const wsUrl = useMemo(() => {
    const url = new URL(`${baseUrl.replace(/^http/, "ws")}/api/v1/realtime`);
    url.searchParams.set("token", token);
    url.searchParams.set("site", siteId);
    url.searchParams.set("siteId", siteId);
    return url.toString();
  }, [baseUrl, siteId, token]);

  const appendLog = (message: string) => {
    setLogs((current) => [{ at: now(), message }, ...current].slice(0, 12));
  };

  const connect = () => {
    if (clientRef.current?.isConnected) return;

    setStatus("connecting");
    appendLog(`Connecting to ${collection}`);

    const client = new RealtimeClient({
      baseUrl,
      siteId,
      token,
      userId: "nextjs-consumer",
      initialBackoffMs: 1000,
      maxBackoffMs: 5000,
    });

    unsubscribeRef.current = client.subscribe(collection, (event) => {
      setEvents((current) => [event, ...current].slice(0, 10));
      appendLog(`Event ${event.action} ${event.collection}/${event.itemId}`);
    });

    presenceUnsubscribeRef.current = client.onPresence((users) => {
      setPresence(users);
      appendLog(`Presence update: ${users.length} session(s)`);
    });

    client.connect();
    clientRef.current = client;

    const id = window.setInterval(() => {
      const connected = client.isConnected;
      setStatus(connected ? "connected" : "connecting");
      setSessionId(client.session);
      if (client.session) window.clearInterval(id);
    }, 300);
  };

  const sendPresence = () => {
    const client = clientRef.current;
    if (!client) return;
    client.presence({
      collection,
      itemId: "client-test",
      meta: { view: "consumer-nextjs" },
    });
    appendLog("Presence sent");
  };

  const disconnect = () => {
    unsubscribeRef.current?.();
    presenceUnsubscribeRef.current?.();
    clientRef.current?.disconnect();
    clientRef.current = null;
    unsubscribeRef.current = null;
    presenceUnsubscribeRef.current = null;
    setStatus("disconnected");
    setSessionId(null);
    appendLog("Disconnected");
  };

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      presenceUnsubscribeRef.current?.();
      clientRef.current?.disconnect();
    };
  }, []);

  return (
    <section className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Realtime client test
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight">WebSocket subscription</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">
            Tests the browser SDK against <code className="font-mono">{collection}</code> using
            the same Next.js consumer app.
          </p>
        </div>
        <span className="inline-flex w-fit rounded-full border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700">
          {status}
        </span>
      </div>

      <dl className="mt-6 grid gap-3 text-sm md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 p-3">
          <dt className="text-slate-500">CMS</dt>
          <dd className="mt-1 break-all font-mono text-xs text-slate-900">{baseUrl}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 p-3">
          <dt className="text-slate-500">Site</dt>
          <dd className="mt-1 font-mono text-xs text-slate-900">{siteId}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 p-3">
          <dt className="text-slate-500">Session</dt>
          <dd className="mt-1 font-mono text-xs text-slate-900">{sessionId ?? "not connected"}</dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={connect}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={status === "connected" || status === "connecting"}
        >
          Connect
        </button>
        <button
          type="button"
          onClick={sendPresence}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800"
        >
          Send presence
        </button>
        <button
          type="button"
          onClick={disconnect}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800"
        >
          Disconnect
        </button>
      </div>

      <div className="mt-6 rounded-lg bg-slate-950 p-4 text-xs text-slate-100">
        <p className="break-all font-mono text-slate-400">{wsUrl}</p>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div>
            <h3 className="font-semibold text-white">Logs</h3>
            <ul className="mt-2 space-y-1">
              {logs.length === 0 ? <li className="text-slate-500">No logs yet</li> : null}
              {logs.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <span className="text-slate-500">{entry.at}</span> {entry.message}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-white">Events</h3>
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap text-slate-300">
              {events.length ? JSON.stringify(events, null, 2) : "[]"}
            </pre>
          </div>
          <div>
            <h3 className="font-semibold text-white">Presence</h3>
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap text-slate-300">
              {presence.length ? JSON.stringify(presence, null, 2) : "[]"}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
