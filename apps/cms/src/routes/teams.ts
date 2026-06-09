import { teams, teamMembers } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';

export const teamsRouter = new Hono<AppEnv>();
teamsRouter.use('*', requireSiteAdmin());

// List teams in the active site
teamsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const data = await db
    .select()
    .from(teams)
    .where(eq(teams.siteId, siteId));

  return c.json({ data });
});

// Get a single team
teamsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.siteId, siteId), eq(teams.id, id)))
    .limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

const teamSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().nullable().optional(),
});

// Create team
teamsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = teamSchema.parse(body);

  const [row] = await db
    .insert(teams)
    .values({
      siteId,
      name: input.name,
      description: input.description,
    })
    .returning();

  return c.json({ data: row });
});

// Update team
teamsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = teamSchema.partial().parse(body);

  const [row] = await db
    .update(teams)
    .set({
      name: input.name,
      description: input.description,
    })
    .where(and(eq(teams.siteId, siteId), eq(teams.id, id)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

// Delete team
teamsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(teams)
    .where(and(eq(teams.siteId, siteId), eq(teams.id, id)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: null });
});

// --- Team Members ---

// List members of a team
teamsRouter.get('/:id/members', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  // Verify team belongs to site
  const [teamRow] = await db.select().from(teams).where(and(eq(teams.siteId, siteId), eq(teams.id, id))).limit(1);
  if (!teamRow) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  const data = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.teamId, id));

  return c.json({ data });
});

// Add member to team
teamsRouter.post('/:id/members', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const body = await c.req.json();
  const input = z.object({ userId: z.string() }).parse(body);

  const [teamRow] = await db.select().from(teams).where(and(eq(teams.siteId, siteId), eq(teams.id, id))).limit(1);
  if (!teamRow) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  const [row] = await db
    .insert(teamMembers)
    .values({
      teamId: id,
      userId: input.userId,
    })
    .onConflictDoNothing()
    .returning();

  return c.json({ data: row ?? { teamId: id, userId: input.userId } });
});

// Remove member from team
teamsRouter.delete('/:id/members/:userId', async (c) => {
  const id = c.req.param('id');
  const userId = c.req.param('userId');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [teamRow] = await db.select().from(teams).where(and(eq(teams.siteId, siteId), eq(teams.id, id))).limit(1);
  if (!teamRow) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  const [row] = await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: null });
});
