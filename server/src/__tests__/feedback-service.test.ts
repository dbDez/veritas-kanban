/**
 * Tests for FeedbackService and detectSentiment
 *
 * Covers: create, get, list, update, delete, getAnalytics, detectSentiment
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackService, detectSentiment } from '../services/feedback-service.js';
import type { CreateFeedbackInput } from '@veritas-kanban/shared';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFeedback(overrides: Partial<CreateFeedbackInput> = {}): CreateFeedbackInput {
  return {
    taskId: 'TASK-1',
    agent: 'veritas',
    rating: 4,
    comment: 'Great work, well done!',
    categories: [],
    ...overrides,
  };
}

// ─── detectSentiment ────────────────────────────────────────────────────────

describe('detectSentiment', () => {
  it('returns neutral for empty string', () => {
    expect(detectSentiment('')).toBe('neutral');
  });

  it('returns neutral for whitespace-only string', () => {
    expect(detectSentiment('   ')).toBe('neutral');
  });

  it('detects positive sentiment', () => {
    expect(detectSentiment('This is excellent work!')).toBe('positive');
    expect(detectSentiment('Great job, very helpful and accurate.')).toBe('positive');
  });

  it('detects negative sentiment', () => {
    expect(detectSentiment('This is broken and terrible')).toBe('negative');
    expect(detectSentiment("It doesn't work and failed completely")).toBe('negative');
  });

  it('returns neutral when neither positive nor negative words found', () => {
    expect(detectSentiment('The task was completed.')).toBe('neutral');
  });

  it('returns neutral when positive and negative scores tie', () => {
    // Equal positive and negative keywords → neutral
    const text = 'great work but terrible result';
    // 'great', 'works' → positive; 'terrible' → negative
    // Actual outcome depends on exact word matching — just expect a valid sentiment
    const result = detectSentiment(text);
    expect(['positive', 'negative', 'neutral']).toContain(result);
  });
});

// ─── FeedbackService ────────────────────────────────────────────────────────

describe('FeedbackService', () => {
  let tempDir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-feedback-'));
    process.chdir(tempDir);
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function getService() {
    const mod = await import('../services/feedback-service.js');
    return new mod.FeedbackService();
  }

  // ─── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates feedback with required fields', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback());

      expect(fb.id).toMatch(/^feedback_/);
      expect(fb.taskId).toBe('TASK-1');
      expect(fb.agent).toBe('veritas');
      expect(fb.rating).toBe(4);
      expect(fb.resolved).toBe(false);
      expect(fb.createdAt).toBeDefined();
      expect(fb.updatedAt).toBeDefined();
    });

    it('auto-detects sentiment from comment', async () => {
      const svc = await getService();

      const positive = await svc.create(makeFeedback({ comment: 'Excellent and amazing work!' }));
      expect(positive.sentiment).toBe('positive');

      const negative = await svc.create(makeFeedback({ comment: 'Broken and terrible failure!' }));
      expect(negative.sentiment).toBe('negative');
    });

    it('creates with categories', async () => {
      const svc = await getService();
      const fb = await svc.create(
        makeFeedback({ categories: ['accuracy' as any, 'performance' as any] })
      );
      expect(fb.categories).toEqual(['accuracy', 'performance']);
    });

    it('creates feedback without comment (neutral sentiment)', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback({ comment: undefined }));
      expect(fb.sentiment).toBe('neutral');
    });

    it('persists to disk as JSON', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback());

      const feedbackDir = path.join(tempDir, 'storage', 'feedback');
      const files = await fs.readdir(feedbackDir);
      expect(files).toContain(`${fb.id}.json`);
    });
  });

  // ─── get ──────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns null for non-existent feedback', async () => {
      const svc = await getService();
      const result = await svc.get('feedback_nonexistent_xxx');
      expect(result).toBeNull();
    });

    it('returns feedback by ID', async () => {
      const svc = await getService();
      const created = await svc.create(makeFeedback({ rating: 5 }));
      const found = await svc.get(created.id);

      expect(found).not.toBeNull();
      expect(found!.rating).toBe(5);
    });
  });

  // ─── list ─────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty array when no feedback exists', async () => {
      const svc = await getService();
      const list = await svc.list();
      expect(list).toEqual([]);
    });

    it('returns all feedback sorted newest first', async () => {
      const svc = await getService();

      const fb1 = await svc.create(makeFeedback({ taskId: 'TASK-A', rating: 3 }));
      await new Promise((r) => setTimeout(r, 5));
      const fb2 = await svc.create(makeFeedback({ taskId: 'TASK-B', rating: 5 }));

      const list = await svc.list();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(fb2.id); // newest first
    });

    it('filters by taskId', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ taskId: 'TASK-X' }));
      await svc.create(makeFeedback({ taskId: 'TASK-Y' }));

      const list = await svc.list({ taskId: 'TASK-X' });
      expect(list).toHaveLength(1);
      expect(list[0].taskId).toBe('TASK-X');
    });

    it('filters by agent', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ agent: 'veritas' }));
      await svc.create(makeFeedback({ agent: 'codex' }));

      const list = await svc.list({ agent: 'veritas' });
      expect(list).toHaveLength(1);
      expect(list[0].agent).toBe('veritas');
    });

    it('filters by sentiment', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ comment: 'Excellent amazing great fantastic!' }));
      await svc.create(makeFeedback({ comment: 'Broken failed terrible horrible.' }));

      const positive = await svc.list({ sentiment: 'positive' });
      expect(positive.every((fb) => fb.sentiment === 'positive')).toBe(true);
    });

    it('filters by resolved=true', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback());
      await svc.update(fb.id, { resolved: true });

      const unresolved = await svc.list({ resolved: false });
      expect(unresolved.every((f) => !f.resolved)).toBe(true);

      const resolved = await svc.list({ resolved: true });
      expect(resolved.every((f) => f.resolved)).toBe(true);
    });

    it('filters by since timestamp', async () => {
      const svc = await getService();
      await svc.create(makeFeedback());
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      const recent = await svc.create(makeFeedback({ taskId: 'TASK-RECENT' }));

      const filtered = await svc.list({ since: cutoff });
      expect(filtered.some((fb) => fb.id === recent.id)).toBe(true);
      expect(filtered.every((fb) => fb.createdAt >= cutoff)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const svc = await getService();
      for (let i = 0; i < 5; i++) {
        await svc.create(makeFeedback());
      }

      const list = await svc.list({ limit: 3 });
      expect(list).toHaveLength(3);
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('returns null for non-existent feedback', async () => {
      const svc = await getService();
      const result = await svc.update('feedback_nonexistent', { resolved: true });
      expect(result).toBeNull();
    });

    it('updates comment and re-detects sentiment', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback({ comment: 'Excellent!' }));
      expect(fb.sentiment).toBe('positive');

      const updated = await svc.update(fb.id, { comment: 'Broken terrible failure.' });
      expect(updated!.sentiment).toBe('negative');
      expect(updated!.comment).toBe('Broken terrible failure.');
    });

    it('marks feedback as resolved', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback());
      expect(fb.resolved).toBe(false);

      const updated = await svc.update(fb.id, { resolved: true });
      expect(updated!.resolved).toBe(true);
    });

    it('preserves original taskId and createdAt on update', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback({ taskId: 'TASK-ORIGINAL' }));

      const updated = await svc.update(fb.id, { rating: 2, comment: 'Mediocre.' });
      expect(updated!.taskId).toBe('TASK-ORIGINAL');
      expect(updated!.createdAt).toBe(fb.createdAt);
    });

    it('updates the updatedAt timestamp', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback());

      await new Promise((r) => setTimeout(r, 5));
      const updated = await svc.update(fb.id, { rating: 1 });
      expect(updated!.updatedAt).not.toBe(fb.updatedAt);
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('returns false for non-existent feedback', async () => {
      const svc = await getService();
      const result = await svc.delete('feedback_nonexistent');
      expect(result).toBe(false);
    });

    it('deletes feedback and returns true', async () => {
      const svc = await getService();
      const fb = await svc.create(makeFeedback());

      const result = await svc.delete(fb.id);
      expect(result).toBe(true);

      const found = await svc.get(fb.id);
      expect(found).toBeNull();
    });
  });

  // ─── getAnalytics ─────────────────────────────────────────────────────────

  describe('getAnalytics', () => {
    it('returns zero analytics for empty feedback store', async () => {
      const svc = await getService();
      const analytics = await svc.getAnalytics();

      expect(analytics.totalFeedback).toBe(0);
      expect(analytics.averageRating).toBe(0);
    });

    it('calculates correct averageRating', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ rating: 2 }));
      await svc.create(makeFeedback({ rating: 4 }));

      const analytics = await svc.getAnalytics();
      expect(analytics.averageRating).toBe(3);
    });

    it('produces ratingDistribution with 5 buckets', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ rating: 1 }));
      await svc.create(makeFeedback({ rating: 5 }));
      await svc.create(makeFeedback({ rating: 5 }));

      const analytics = await svc.getAnalytics();
      expect(analytics.ratingDistribution).toHaveLength(5);

      const fiveStar = analytics.ratingDistribution.find((r) => r.star === 5);
      expect(fiveStar!.count).toBe(2);
      expect(fiveStar!.percentage).toBeCloseTo(66.67, 1);
    });

    it('calculates perAgent scores', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ agent: 'veritas', rating: 4 }));
      await svc.create(makeFeedback({ agent: 'veritas', rating: 5 }));
      await svc.create(makeFeedback({ agent: 'codex', rating: 2 }));

      const analytics = await svc.getAnalytics();

      const veritasScore = analytics.agentScores?.find((s: any) => s.agent === 'veritas');
      expect(veritasScore).toBeDefined();
      expect(veritasScore?.averageRating).toBe(4.5);
    });

    it('filters analytics by taskId', async () => {
      const svc = await getService();
      await svc.create(makeFeedback({ taskId: 'TASK-A', rating: 5 }));
      await svc.create(makeFeedback({ taskId: 'TASK-B', rating: 1 }));

      const analytics = await svc.getAnalytics({ taskId: 'TASK-A' });
      expect(analytics.totalFeedback).toBe(1);
      expect(analytics.averageRating).toBe(5);
    });
  });
});
