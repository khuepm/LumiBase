import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_TOLERANCE_SECONDS,
  signSlackRequest,
  signWebhookRequest,
  timingSafeEqual,
  verifySlackSignature,
  verifyWebhookSignature,
} from '../signatures';
import { copilotReply, escapeMrkdwn, isSlackResponseUrl, stripMentions } from '../slack';

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const NOW = 1_795_000_000;

describe('Slack request signatures (#711)', () => {
  it('matches Slack\'s published example', async () => {
    // https://api.slack.com/authentication/verifying-requests-from-slack
    const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    const verdict = await verifySlackSignature({
      secret: SECRET,
      rawBody: body,
      timestamp: '1531420618',
      signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
      now: 1531420618,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('refuses a missing, stale, future or forged signature', async () => {
    const body = '{"type":"event_callback"}';
    const sig = await signSlackRequest(SECRET, body, NOW);
    expect(await verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: String(NOW), signature: sig, now: NOW })).toEqual({ ok: true });
    expect(await verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: undefined, signature: sig, now: NOW })).toMatchObject({ reason: 'missing' });
    expect(await verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: String(NOW), signature: sig, now: NOW + SIGNATURE_TOLERANCE_SECONDS + 1 })).toMatchObject({ reason: 'stale_timestamp' });
    expect(await verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: String(NOW), signature: sig, now: NOW - SIGNATURE_TOLERANCE_SECONDS - 1 })).toMatchObject({ reason: 'stale_timestamp' });
    expect(await verifySlackSignature({ secret: SECRET, rawBody: `${body} `, timestamp: String(NOW), signature: sig, now: NOW })).toMatchObject({ reason: 'mismatch' });
    expect(await verifySlackSignature({ secret: 'other-secret-000000', rawBody: body, timestamp: String(NOW), signature: sig, now: NOW })).toMatchObject({ reason: 'mismatch' });
    expect(await verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: '1e9', signature: sig, now: NOW })).toMatchObject({ reason: 'stale_timestamp' });
  });

  it('webhook scheme binds the timestamp too, and is not interchangeable with Slack\'s', async () => {
    const body = '{"userId":"u1","text":"hi"}';
    const sig = await signWebhookRequest(SECRET, body, NOW);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: body, timestamp: String(NOW), signature: sig, now: NOW })).toEqual({ ok: true });
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: body, timestamp: String(NOW + 1), signature: sig, now: NOW })).toMatchObject({ reason: 'mismatch' });
    const slack = await signSlackRequest(SECRET, body, NOW);
    expect(await verifyWebhookSignature({ secret: SECRET, rawBody: body, timestamp: String(NOW), signature: slack, now: NOW })).toMatchObject({ reason: 'mismatch' });
  });

  it('compares in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Slack formatting', () => {
  it('escapes model output so it cannot mention a channel or forge a link', () => {
    expect(escapeMrkdwn('<!channel> & <https://evil.example|bank>')).toBe('&lt;!channel&gt; &amp; &lt;https://evil.example|bank&gt;');
    const reply = copilotReply({ status: 'executed', message: 'Hi <!here>' });
    expect(reply.text).toBe('Hi &lt;!here&gt;');
    expect(reply.blocks).toHaveLength(1);
  });

  it('adds Approve / Reject buttons only to a parked turn', () => {
    const reply = copilotReply({ status: 'pending_approval', message: 'Needs approval', approvalId: 'apr_1' });
    const actions = reply.blocks!.at(-1) as { elements: Array<{ action_id: string; value: string }> };
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([
      ['lumibase_approve', 'apr_1'],
      ['lumibase_reject', 'apr_1'],
    ]);
  });

  it('strips bot mentions and only posts response URLs to Slack', () => {
    expect(stripMentions('<@U0BOT> draft a post about <@U0BOT|lumi> spring')).toBe('draft a post about spring');
    expect(isSlackResponseUrl('https://hooks.slack.com/commands/T1/2/3')).toBe(true);
    expect(isSlackResponseUrl('https://hooks.slack.com.evil.example/x')).toBe(false);
    expect(isSlackResponseUrl('http://hooks.slack.com/x')).toBe(false);
    expect(isSlackResponseUrl('https://169.254.169.254/latest')).toBe(false);
  });
});
