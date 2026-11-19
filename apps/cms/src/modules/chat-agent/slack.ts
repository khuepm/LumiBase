/**
 * Slack Web API calls and message formatting (#711).
 *
 * Replies are posted with the integration's bot token (`chat.postMessage`, in
 * the thread of the mention) or through the `response_url` Slack hands to a
 * slash command or a button click. The model's text is posted as plain
 * `mrkdwn`; a turn that parked for approval gets Approve / Reject buttons whose
 * value is the approval id — clicking one is verified and decided as the
 * clicking user's linked LumiBase account, never as the requester's.
 */

export const SLACK_API = 'https://slack.com/api';
export const APPROVE_ACTION = 'lumibase_approve';
export const REJECT_ACTION = 'lumibase_reject';

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

/** A Copilot result as a Slack message. */
export function copilotReply(result: {
  status?: unknown;
  message?: unknown;
  approvalId?: unknown;
}): SlackMessage {
  const message = typeof result.message === 'string' && result.message.trim() ? result.message.trim() : 'Done.';
  // Slack treats `<…>` as links/mentions and `&` as an entity; never let model
  // output ping a channel or forge a link.
  const safe = escapeMrkdwn(message).slice(0, 2900);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: safe } }];
  if (result.status === 'pending_approval' && typeof result.approvalId === 'string') {
    blocks.push(
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'This action needs approval. A linked admin can decide here or in Studio.' }] },
      {
        type: 'actions',
        block_id: 'lumibase_approval',
        elements: [
          { type: 'button', action_id: APPROVE_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: result.approvalId },
          { type: 'button', action_id: REJECT_ACTION, style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: result.approvalId },
        ],
      },
    );
  }
  return { text: safe, blocks };
}

export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function postMessage(
  botToken: string,
  input: { channel: string; threadTs?: string; message: SlackMessage },
): Promise<boolean> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${botToken}` },
    body: JSON.stringify({
      channel: input.channel,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      text: input.message.text,
      ...(input.message.blocks ? { blocks: input.message.blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
  return res.ok && body?.ok === true;
}

/** Only Slack's own hooks host may receive a `response_url` post. */
export function isSlackResponseUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

export async function respond(
  responseUrl: string,
  message: SlackMessage & { replaceOriginal?: boolean; ephemeral?: boolean },
): Promise<boolean> {
  if (!isSlackResponseUrl(responseUrl)) return false;
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
      response_type: message.ephemeral ? 'ephemeral' : 'in_channel',
      ...(message.replaceOriginal ? { replace_original: true } : { replace_original: false }),
    }),
  });
  return res.ok;
}

/** Strips the bot mention(s) from an `app_mention` text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim();
}
