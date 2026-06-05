import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import type { Database } from '@lumibase/database';

/**
 * Unit tests for AISecureHarness: evaluateRisk, execute, and runSkill methods.
 * Validates: Requirements 2.5, 2.6, 2.7, 2.8, 2.9
 */

// Mock database that captures insert calls
function createMockDb() {
  const insertedValues: unknown[] = [];
  const returningResult = [{ id: 'test-approval-id-12345' }];

  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returningResult),
      }),
    }),
    _insertedValues: insertedValues,
  };

  return db as unknown as Database & { insert: ReturnType<typeof vi.fn> };
}

describe('AISecureHarness - evaluateRisk', () => {
  const harness = new AISecureHarness({
    db: {} as Database,
    siteId: 'test-site',
  });

  it('should classify skill as dangerous when it requires a mutating schema capability', () => {
    const skill = CORE_SKILLS['createCollection']!;
    expect(harness.evaluateRisk(skill, 'createCollection')).toBe(true);
  });

  it('should classify skill as dangerous when name starts with "delete"', () => {
    const skill = CORE_SKILLS['deleteItem']!;
    expect(harness.evaluateRisk(skill, 'deleteItem')).toBe(true);
  });

  it('should classify skill as safe when no mutating schema capability and name does not start with delete', () => {
    const skill = CORE_SKILLS['listCollections']!;
    expect(harness.evaluateRisk(skill, 'listCollections')).toBe(false);
  });

  it('should classify listItems as safe', () => {
    const skill = CORE_SKILLS['listItems']!;
    expect(harness.evaluateRisk(skill, 'listItems')).toBe(false);
  });

  it('should classify createItem as safe (items:write, not mutating schema capability)', () => {
    const skill = CORE_SKILLS['createItem']!;
    expect(harness.evaluateRisk(skill, 'createItem')).toBe(false);
  });
});

describe('AISecureHarness - execute', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let harness: AISecureHarness;

  beforeEach(() => {
    mockDb = createMockDb();
    harness = new AISecureHarness({
      db: mockDb as unknown as Database,
      siteId: 'site-123',
    });
  });

  it('should return denied for unknown skill', async () => {
    const result = await harness.execute('nonExistentSkill', {}, ['*']);
    expect(result.status).toBe('denied');
    expect(result.message).toBe('Unknown skill: nonExistentSkill');
  });

  it('should return denied when user lacks capabilities', async () => {
    const result = await harness.execute('listCollections', {}, ['items:read']);
    expect(result.status).toBe('denied');
    expect(result.message).toBe('Insufficient capabilities');
  });

  it('should return pending_approval for dangerous skill with sufficient capabilities', async () => {
    const result = await harness.execute(
      'createCollection',
      { name: 'posts' },
      ['schema:create'],
      'User wants to create a collection',
    );
    expect(result.status).toBe('pending_approval');
    expect(result.approvalId).toBe('test-approval-id-12345');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('should return executed for safe skill with sufficient capabilities', async () => {
    const result = await harness.execute('listItems', {}, ['items:read']);
    expect(result.status).toBe('executed');
    expect(result.data).toEqual({ items: [] });
  });

  it('should return executed for safe skill with wildcard capability', async () => {
    const result = await harness.execute('listItems', {}, ['*']);
    // listItems is safe (items:read, not mutating schema capability, not delete*)
    // But wait — with wildcard, capabilities pass. listItems is safe → executed
    expect(result.status).toBe('executed');
    expect(result.data).toEqual({ items: [] });
  });

  it('should return pending_approval for deleteItem with wildcard (dangerous by name)', async () => {
    const result = await harness.execute('deleteItem', {}, ['*']);
    expect(result.status).toBe('pending_approval');
    expect(result.approvalId).toBeDefined();
  });
});

describe('AISecureHarness - runSkill', () => {
  const harness = new AISecureHarness({
    db: {} as Database,
    siteId: 'test-site',
  });

  it('should return success with data for a valid skill', async () => {
    const result = await harness.runSkill('listItems', {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ items: [] });
    }
  });

  it('should return error for non-existent skill', async () => {
    const result = await harness.runSkill('unknownSkill', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Skill not found');
    }
  });

  it('should return error when skill handler throws', async () => {
    // Temporarily override a skill handler to throw
    const originalHandler = CORE_SKILLS['listItems']!.handler;
    CORE_SKILLS['listItems']!.handler = async () => {
      throw new Error('Database connection failed');
    };

    const result = await harness.runSkill('listItems', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Database connection failed');
    }

    // Restore original handler
    CORE_SKILLS['listItems']!.handler = originalHandler;
  });

  it('should return error when skill handler times out', async () => {
    // Override handler to simulate a long-running operation
    const originalHandler = CORE_SKILLS['listItems']!.handler;
    CORE_SKILLS['listItems']!.handler = async () => {
      return new Promise((resolve) => {
        setTimeout(resolve, 60_000); // 60s, exceeds 30s timeout
      });
    };

    // Use fake timers to avoid waiting 30s in tests
    vi.useFakeTimers();

    const resultPromise = harness.runSkill('listItems', {});

    // Advance time past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('timed out');
    }

    vi.useRealTimers();
    // Restore original handler
    CORE_SKILLS['listItems']!.handler = originalHandler;
  });
});
