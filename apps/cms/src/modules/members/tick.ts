/**
 * Members background tick (epic #672): one minute-cadence entry for both
 * runtimes (Docker `serve.ts` node-cron under a leader lock, Workers
 * `cloudflare.ts` minute trigger). It runs, in order and within one budget:
 *
 *   1. newsletter sends whose lease is free (resume after the creating
 *      request, a restart or a crash);
 *   2. segment-triggered sequence enrolment (members who entered a segment);
 *   3. due sequence steps;
 *   4. sending-domain rotation (pending switches, due rotations).
 *
 * Runs on the SYSTEM connection: it claims work across sites, and every
 * write it makes is keyed by the `site_id` of the row it claimed (each
 * service call takes that row's site), never a request's site.
 */

import type { Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../../env';
import { EmailService } from '../../services/email/email-service';
import { MemberMailer } from './mailer';
import { runNewsletterTick } from './newsletters';
import { DohResolver, runSendingDomainTick, transportProvider, type DnsResolver } from './sending-domains';
import { enrollSegmentSequences, runSequenceTick } from './sequences';

export interface MembersTickDeps {
  db: Database;
  emailService: EmailService | null;
  secret: string | null;
  keys?: KeyProvider;
  linkBase: string | null;
  resolver?: DnsResolver;
  now?: () => Date;
}

function readEnv(env: AppEnv['Bindings'], key: string): string | null {
  const v = (env as unknown as Record<string, unknown>)[key];
  if (typeof v === 'string' && v.length > 0) return v;
  const p = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  return p && p.length > 0 ? p : null;
}

export function membersTickDeps(db: Database, env: AppEnv['Bindings'], keys?: KeyProvider): MembersTickDeps {
  return {
    db,
    emailService: EmailService.fromEnv(env),
    secret: readEnv(env, 'JWT_SECRET'),
    keys,
    linkBase: readEnv(env, 'LUMIBASE_PUBLIC_URL'),
  };
}

export function mailerFactory(deps: Pick<MembersTickDeps, 'db' | 'emailService' | 'secret' | 'keys'>) {
  return (siteId: string): MemberMailer | null => {
    if (!deps.emailService || !deps.secret) return null;
    return new MemberMailer({ db: deps.db, siteId, emailService: deps.emailService, secret: deps.secret, keys: deps.keys });
  };
}

export async function runMembersTick(deps: MembersTickDeps, opts: { budgetMs: number }) {
  const started = Date.now();
  const left = () => Math.max(0, opts.budgetMs - (Date.now() - started));
  const mailerFor = mailerFactory(deps);
  const summary: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (left() <= 0) return;
    try {
      summary[name] = await fn();
    } catch (err) {
      console.error(`[members] ${name} failed`, formatSafeError(err));
    }
  };
  await step('newsletters', () => runNewsletterTick({ db: deps.db, mailerFor, ...(deps.now ? { now: deps.now } : {}) }, { budgetMs: Math.floor(left() * 0.6) }));
  await step('segmentEnrolment', () => enrollSegmentSequences(deps.db, deps.now?.() ?? new Date()));
  await step('sequences', () =>
    runSequenceTick({ db: deps.db, mailerFor, linkBase: deps.linkBase }, { now: deps.now?.() ?? new Date(), budgetMs: Math.floor(left() * 0.8) }),
  );
  await step('sendingDomains', () =>
    runSendingDomainTick(deps.db, deps.keys, deps.resolver ?? new DohResolver(), transportProvider(deps.emailService?.transportKind), deps.now?.() ?? new Date()),
  );
  return summary;
}
