import type { ApiKeySecretResult } from '@lumibase/sdk';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check, Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { getActiveSite, getApiClient } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import {
  MCP_PROMPT_ACCESS_LABEL,
  MCP_PROMPT_CATEGORIES,
  MCP_PROMPTS,
  type McpPromptCategory,
} from './mcp-prompts';

type ClientFormat = 'cursor' | 'vscode';

export function buildMcpConfig(format: ClientFormat, url: string, siteId: string, token: string) {
  const server = {
    command: 'npx',
    args: ['-y', '@lumibase/mcp-server'],
    env: { LUMIBASE_URL: url, LUMIBASE_SITE_ID: siteId, LUMIBASE_TOKEN: token },
  };
  return JSON.stringify(
    format === 'vscode'
      ? { servers: { lumibase: { type: 'stdio', ...server } } }
      : { mcpServers: { lumibase: server } },
    null,
    2,
  );
}

const ACCESS_BADGE_CLASS = {
  read: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  write: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  admin: 'border-destructive/40 text-destructive',
} as const;

/** Copy-ready prompts to try once the IDE is connected. */
export function McpStarterPrompts({ roleHasAdminAccess }: { roleHasAdminAccess?: boolean }) {
  const [category, setCategory] = useState<McpPromptCategory>('explore');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const prompts = MCP_PROMPTS.filter((p) => p.category === category);

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border p-5" aria-labelledby="mcp-starter-prompts">
      <h2 id="mcp-starter-prompts" className="font-medium">Try these prompts</h2>
      <p className="text-sm text-muted-foreground">
        Paste one into your IDE’s AI chat once LumiBase is connected. Replace the values in quotes or angle brackets with your own collections and IDs.
      </p>
      <div role="tablist" aria-label="Prompt categories" className="flex flex-wrap gap-2">
        {MCP_PROMPT_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={`rounded-md border px-3 py-1.5 text-sm ${category === c.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <ul className="space-y-3">
        {prompts.map((p) => {
          const needsAdmin = p.access === 'admin' && roleHasAdminAccess === false;
          return (
            <li key={p.id} className={`space-y-2 rounded-md border p-3 ${needsAdmin ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.title}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${ACCESS_BADGE_CLASS[p.access]}`}>{MCP_PROMPT_ACCESS_LABEL[p.access]}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void copy(p.id, p.prompt)}
                  aria-label={`Copy prompt: ${p.title}`}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                >
                  {copiedId === p.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedId === p.id ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs"><code>{p.prompt}</code></pre>
              <p className="text-[11px] text-muted-foreground">
                Tools: {p.tools.map((t) => <code key={t} className="mr-1">{t}</code>)}
              </p>
              {needsAdmin && <p className="text-xs text-destructive">The selected role has no admin access, so this prompt will be refused.</p>}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        The assistant acts with this key’s role only. Prefer asking it to preview changes before applying them; deletes and schema changes cannot be undone from the IDE.
      </p>
    </section>
  );
}

/** Guided setup for the standalone MCP server used by local IDEs. */
export function McpSetupPage() {
  const client = getApiClient();
  const [roleId, setRoleId] = useState('');
  const [keyName, setKeyName] = useState('IDE MCP');
  const [format, setFormat] = useState<ClientFormat>('cursor');
  const [secret, setSecret] = useState<ApiKeySecretResult | null>(null);
  const [attached, setAttached] = useState(false);
  const [attachError, setAttachError] = useState('');
  const [copied, setCopied] = useState(false);

  const rolesQuery = useQuery({
    queryKey: ['access', 'roles'],
    queryFn: async () => (await client.roles.list()).data,
  });
  const permissionsQuery = useQuery({
    queryKey: ['me', 'permissions'],
    queryFn: async () => (await client.permissions.me()).data,
  });
  const createKey = useMutation({
    mutationFn: async () => {
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      return (await client.apiKeys.create({
        name: keyName.trim(),
        description: 'Dedicated MCP token for an IDE',
        expiresAt,
      })).data;
    },
    onSuccess: (key) => {
      setSecret(key);
      void attachSelectedRole(key.id);
    },
  });

  async function attachSelectedRole(keyId: string) {
    setAttachError('');
    try {
      await client.apiKeys.attachRole(keyId, { roleId });
      setAttached(true);
    } catch (error) {
      setAttached(false);
      setAttachError(error instanceof Error ? error.message : 'Could not attach the selected role.');
    }
  }

  const apiUrl = getApiBaseUrl() || window.location.origin;
  const siteId = getActiveSite();
  const selectedRole = (rolesQuery.data ?? []).find((role) => role.id === roleId);
  const config = secret ? buildMcpConfig(format, apiUrl, siteId, secret.token) : '';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/data-model" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Data model
      </Link>
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Sparkles className="h-6 w-6" /> Set up MCP for your IDE</h1>
        <p className="text-sm text-muted-foreground">
          Give an AI assistant access to this site through a dedicated API key. Its permissions come from the role you select below.
        </p>
      </header>

      <section className="space-y-4 rounded-xl border p-5">
        <h2 className="font-medium">1. Create a scoped key</h2>
        <p className="text-sm text-muted-foreground">
          Choose a role with only the permissions your IDE needs. Schema changes require an admin-capable role. The key expires after 90 days and can be rotated or revoked in Access → API keys.
        </p>
        <label className="block space-y-1 text-sm">
          <span>Key name</span>
          <input value={keyName} onChange={(event) => setKeyName(event.target.value)} disabled={!!secret} className="w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Role for the AI assistant</span>
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)} disabled={!!secret} className="w-full rounded-md border bg-background px-3 py-2">
            <option value="">Select a role…</option>
            {(rolesQuery.data ?? []).map((role) => <option key={role.id} value={role.id}>{role.name}{role.adminAccess ? ' (admin access)' : ''}</option>)}
          </select>
        </label>
        {rolesQuery.isError && <p className="text-sm text-destructive">Could not load roles.</p>}
        {permissionsQuery.isError && <p className="text-sm text-destructive">Could not verify admin access.</p>}
        {permissionsQuery.data && !permissionsQuery.data.admin && <p className="text-sm text-destructive">An admin account is required to create an MCP key.</p>}
        {!secret && (
          <button type="button" disabled={!keyName.trim() || !roleId || createKey.isPending || permissionsQuery.data?.admin !== true} onClick={() => createKey.mutate()} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {createKey.isPending ? 'Creating…' : 'Create MCP key'}
          </button>
        )}
        {createKey.isError && <p className="text-sm text-destructive">{createKey.error instanceof Error ? createKey.error.message : 'Could not create key.'}</p>}
        {attachError && secret && (
          <div className="space-y-2 text-sm text-destructive">
            <p>Key created, but its role was not attached: {attachError}</p>
            <button type="button" onClick={() => void attachSelectedRole(secret.id)} className="rounded-md border px-3 py-1.5">Retry attaching role</button>
          </div>
        )}
      </section>

      {secret && attached && (
        <section className="space-y-4 rounded-xl border p-5">
          <h2 className="font-medium">2. Add LumiBase to your IDE</h2>
          <p className="text-sm text-muted-foreground">This secret is shown once. Store the config in your IDE’s MCP settings and keep it out of source control.</p>
          <label className="block space-y-1 text-sm">
            <span>Config format</span>
            <select value={format} onChange={(event) => { setFormat(event.target.value as ClientFormat); setCopied(false); }} className="rounded-md border bg-background px-3 py-2">
              <option value="cursor">Cursor / Claude Desktop</option>
              <option value="vscode">VS Code</option>
            </select>
          </label>
          <pre className="overflow-x-auto rounded-md border bg-muted/30 p-4 text-xs"><code>{config}</code></pre>
          <button type="button" onClick={async () => { await navigator.clipboard.writeText(config); setCopied(true); }} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Copy className="h-4 w-4" /> {copied ? 'Copied' : 'Copy config'}
          </button>
          <p className="text-sm text-muted-foreground">Cursor: save as <code>.cursor/mcp.json</code>. VS Code: save as <code>.vscode/mcp.json</code>. Restart the MCP client, then try one of the prompts below.</p>
        </section>
      )}

      <McpStarterPrompts roleHasAdminAccess={selectedRole ? selectedRole.adminAccess : undefined} />

      <p className="text-sm text-muted-foreground">
        This uses the local stdio MCP server. The governed HTTP endpoint at <code>/api/v1/mcp</code> is a separate feature, controlled in Mission Control rollout flags.
      </p>
      <Link to="/access/api-keys" className="text-sm text-primary underline">Manage API keys</Link>
    </div>
  );
}
