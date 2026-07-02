/**
 * EmailModuleService — business logic for the email module.
 *
 * Owns the CRUD over `email_layouts` / `email_templates` (all site-scoped,
 * Strict Rule #2) plus the render+send path that the Studio UI and extensions
 * drive through `/api/v1/email/*`. The actual transport lives in
 * `services/email/EmailService`; this service stitches stored templates +
 * layouts to the render engine and hands the rendered message to it.
 *
 * Send attempts are audit-logged (`email_sent` / `email_send_failed`) so an
 * operator can trace delivery, mirroring the notifications dispatcher posture.
 */

import type { Database } from '@lumibase/database';
import { emailLayouts, emailTemplates } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { DeliveryResult } from '../notifications/types';
import { EmailService, type OutboundEmail } from '../../services/email/email-service';
import { renderTemplate, type RenderedEmail, type TemplateVars } from '../../services/email/render';
import { SuppressionService } from './suppression';

export interface EmailModuleDeps {
  db: Database;
  siteId: string;
  /** Resolved per-request from EmailService.fromEnv(c.env); null = degraded. */
  emailService: EmailService | null;
}

export class TemplateNotFoundError extends Error {
  constructor(key: string) {
    super(`email template not found: ${key}`);
    this.name = 'TemplateNotFoundError';
  }
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('email service is not configured on this runtime');
    this.name = 'EmailNotConfiguredError';
  }
}

export class AllRecipientsSuppressedError extends Error {
  constructor() {
    super('all recipients are on the suppression list');
    this.name = 'AllRecipientsSuppressedError';
  }
}

export class EmailModuleService {
  constructor(private readonly deps: EmailModuleDeps) {}

  // ── Capabilities ──────────────────────────────────────────────────────

  capabilities(): { configured: boolean; transport: string | null; from: string | null } {
    const svc = this.deps.emailService;
    return {
      configured: svc !== null,
      transport: svc?.transportKind ?? null,
      from: svc?.defaultFrom ?? null,
    };
  }

  // ── Layouts ───────────────────────────────────────────────────────────

  listLayouts() {
    const { db, siteId } = this.deps;
    return db.select().from(emailLayouts).where(eq(emailLayouts.siteId, siteId));
  }

  async createLayout(input: { key: string; name: string; html: string }) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .insert(emailLayouts)
      .values({ ...input, siteId })
      .returning();
    return row;
  }

  async updateLayout(id: string, patch: Partial<{ key: string; name: string; html: string }>) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .update(emailLayouts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(emailLayouts.siteId, siteId), eq(emailLayouts.id, id)))
      .returning();
    return row ?? null;
  }

  async deleteLayout(id: string) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .delete(emailLayouts)
      .where(and(eq(emailLayouts.siteId, siteId), eq(emailLayouts.id, id)))
      .returning();
    return row ?? null;
  }

  // ── Templates ─────────────────────────────────────────────────────────

  listTemplates() {
    const { db, siteId } = this.deps;
    return db.select().from(emailTemplates).where(eq(emailTemplates.siteId, siteId));
  }

  async createTemplate(input: {
    key: string;
    name: string;
    layoutId?: string | null;
    subject: string;
    bodyHtml: string;
    bodyText?: string | null;
    variables: string[];
    enabled: boolean;
  }) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .insert(emailTemplates)
      .values({ ...input, siteId })
      .returning();
    return row;
  }

  async updateTemplate(
    id: string,
    patch: Partial<{
      key: string;
      name: string;
      layoutId: string | null;
      subject: string;
      bodyHtml: string;
      bodyText: string | null;
      variables: string[];
      enabled: boolean;
    }>,
  ) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .update(emailTemplates)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(emailTemplates.siteId, siteId), eq(emailTemplates.id, id)))
      .returning();
    return row ?? null;
  }

  async deleteTemplate(id: string) {
    const { db, siteId } = this.deps;
    const [row] = await db
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.siteId, siteId), eq(emailTemplates.id, id)))
      .returning();
    return row ?? null;
  }

  // ── Render + send ─────────────────────────────────────────────────────

  /** Render a stored template (with its layout) against `vars`. No send. */
  async render(templateKey: string, vars: TemplateVars): Promise<RenderedEmail> {
    const { db, siteId } = this.deps;
    const [tpl] = await db
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.siteId, siteId), eq(emailTemplates.key, templateKey)))
      .limit(1);
    if (!tpl) throw new TemplateNotFoundError(templateKey);

    let layout = null;
    if (tpl.layoutId) {
      const [l] = await db
        .select()
        .from(emailLayouts)
        .where(and(eq(emailLayouts.siteId, siteId), eq(emailLayouts.id, tpl.layoutId)))
        .limit(1);
      layout = l ? { html: l.html } : null;
    }

    return renderTemplate(
      { subject: tpl.subject, bodyHtml: tpl.bodyHtml, bodyText: tpl.bodyText },
      layout,
      vars,
    );
  }

  /**
   * Render (if `templateKey`) and send. Returns the delivery result and the
   * rendered preview so callers can surface what was sent. Throws
   * {@link EmailNotConfiguredError} in degraded mode and
   * {@link TemplateNotFoundError} for an unknown key.
   */
  async send(input: {
    to: readonly string[];
    cc?: readonly string[];
    replyTo?: string;
    templateKey?: string;
    inline?: { subject: string; html?: string; text?: string };
    variables: TemplateVars;
    /**
     * `marketing` sends are filtered against the suppression list (CAN-SPAM);
     * `transactional` (default) are always delivered.
     */
    category?: 'transactional' | 'marketing';
  }): Promise<{ result: DeliveryResult; rendered: { subject: string; html?: string; text?: string } }> {
    const svc = this.deps.emailService;
    if (!svc) throw new EmailNotConfiguredError();

    // Commercial mail must skip suppressed (unsubscribed) recipients.
    let recipients: readonly string[] = input.to;
    if (input.category === 'marketing') {
      recipients = await new SuppressionService({ db: this.deps.db }).filter({
        siteId: this.deps.siteId,
        emails: input.to,
      });
      if (recipients.length === 0) throw new AllRecipientsSuppressedError();
    }

    let message: OutboundEmail;
    let rendered: { subject: string; html?: string; text?: string };

    if (input.templateKey) {
      const r = await this.render(input.templateKey, input.variables);
      rendered = { subject: r.subject, html: r.html, text: r.text };
      message = {
        to: recipients,
        cc: input.cc,
        replyTo: input.replyTo,
        subject: r.subject,
        html: r.html,
        text: r.text,
      };
    } else {
      const inline = input.inline!;
      rendered = { subject: inline.subject, html: inline.html, text: inline.text };
      message = {
        to: recipients,
        cc: input.cc,
        replyTo: input.replyTo,
        subject: inline.subject,
        html: inline.html,
        text: inline.text,
      };
    }

    const result = await svc.send(message);
    return { result, rendered };
  }
}
