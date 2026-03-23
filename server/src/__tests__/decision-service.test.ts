/**
 * Tests for DecisionService
 *
 * Covers: create, list, getById, getChain, updateAssumption, edge cases
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('DecisionService', () => {
  let tempDir: string;
  const originalEnv = process.env.DATA_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-decision-'));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.DATA_DIR = originalEnv;
    } else {
      delete process.env.DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function getService() {
    const mod = await import('../services/decision-service.js');
    return new mod.DecisionService();
  }

  // ─── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a decision record and persists it', async () => {
      const svc = await getService();

      const decision = await svc.create({
        inputContext: 'Should we use Redis or in-memory?',
        outputAction: 'Use Redis for persistence',
        confidenceLevel: 0.85,
        riskScore: 0.3,
        agentId: 'veritas',
        taskId: 'task-100',
      });

      expect(decision.id).toMatch(/^decision_/);
      expect(decision.inputContext).toBe('Should we use Redis or in-memory?');
      expect(decision.outputAction).toBe('Use Redis for persistence');
      expect(decision.confidenceLevel).toBe(0.85);
      expect(decision.riskScore).toBe(0.3);
      expect(decision.agentId).toBe('veritas');
      expect(decision.taskId).toBe('task-100');
      expect(decision.timestamp).toBeDefined();
    });

    it('normalizes string assumptions to objects', async () => {
      const svc = await getService();

      const decision = await svc.create({
        inputContext: 'Context',
        outputAction: 'Action',
        confidenceLevel: 0.9,
        riskScore: 0.1,
        assumptions: ['Assumption 1', 'Assumption 2'],
      });

      expect(decision.assumptions).toHaveLength(2);
      expect(decision.assumptions[0].text).toBe('Assumption 1');
      expect(decision.assumptions[0].status).toBe('pending');
    });

    it('normalizes object assumptions', async () => {
      const svc = await getService();

      const decision = await svc.create({
        inputContext: 'Context',
        outputAction: 'Action',
        confidenceLevel: 0.9,
        riskScore: 0.1,
        assumptions: [{ text: 'Object assumption' }],
      });

      expect(decision.assumptions[0].text).toBe('Object assumption');
      expect(decision.assumptions[0].status).toBe('pending');
    });

    it('uses provided timestamp', async () => {
      const svc = await getService();
      const ts = '2025-01-15T10:00:00.000Z';

      const decision = await svc.create({
        inputContext: 'Ctx',
        outputAction: 'Act',
        confidenceLevel: 0.8,
        riskScore: 0.2,
        timestamp: ts,
      });

      expect(decision.timestamp).toBe(ts);
    });

    it('creates decision with parentDecisionId when parent exists', async () => {
      const svc = await getService();

      const parent = await svc.create({
        inputContext: 'Parent context',
        outputAction: 'Parent action',
        confidenceLevel: 0.9,
        riskScore: 0.1,
      });

      const child = await svc.create({
        inputContext: 'Child context',
        outputAction: 'Child action',
        confidenceLevel: 0.8,
        riskScore: 0.2,
        parentDecisionId: parent.id,
      });

      expect(child.parentDecisionId).toBe(parent.id);
    });

    it('throws BadRequestError when parentDecisionId not found', async () => {
      const svc = await getService();

      await expect(
        svc.create({
          inputContext: 'Ctx',
          outputAction: 'Act',
          confidenceLevel: 0.8,
          riskScore: 0.2,
          parentDecisionId: 'decision_nonexistent',
        })
      ).rejects.toThrow(/Parent decision not found/);
    });

    it('creates decision with no assumptions (defaults to empty)', async () => {
      const svc = await getService();
      const decision = await svc.create({
        inputContext: 'Ctx',
        outputAction: 'Act',
        confidenceLevel: 0.5,
        riskScore: 0.5,
      });

      expect(decision.assumptions).toEqual([]);
    });
  });

  // ─── list ────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty array when no decisions exist', async () => {
      const svc = await getService();
      const list = await svc.list();
      expect(list).toEqual([]);
    });

    it('returns all decisions sorted newest first', async () => {
      const svc = await getService();

      await svc.create({
        inputContext: 'Old',
        outputAction: 'Act',
        confidenceLevel: 0.8,
        riskScore: 0.2,
        timestamp: '2025-01-01T10:00:00.000Z',
      });

      await svc.create({
        inputContext: 'New',
        outputAction: 'Act',
        confidenceLevel: 0.9,
        riskScore: 0.1,
        timestamp: '2025-06-01T10:00:00.000Z',
      });

      const list = await svc.list();
      expect(list).toHaveLength(2);
      expect(list[0].inputContext).toBe('New');
      expect(list[1].inputContext).toBe('Old');
    });

    it('filters by agent', async () => {
      const svc = await getService();

      await svc.create({
        inputContext: 'By veritas',
        outputAction: 'Act',
        confidenceLevel: 0.9,
        riskScore: 0.1,
        agentId: 'veritas',
      });

      await svc.create({
        inputContext: 'By codex',
        outputAction: 'Act',
        confidenceLevel: 0.9,
        riskScore: 0.1,
        agentId: 'codex',
      });

      const list = await svc.list({ agent: 'veritas' });
      expect(list).toHaveLength(1);
      expect(list[0].agentId).toBe('veritas');
    });

    it('filters by minConfidence', async () => {
      const svc = await getService();

      await svc.create({
        inputContext: 'Low conf',
        outputAction: 'Act',
        confidenceLevel: 0.3,
        riskScore: 0.5,
      });

      await svc.create({
        inputContext: 'High conf',
        outputAction: 'Act',
        confidenceLevel: 0.9,
        riskScore: 0.1,
      });

      const list = await svc.list({ minConfidence: 0.8 });
      expect(list).toHaveLength(1);
      expect(list[0].inputContext).toBe('High conf');
    });

    it('filters by maxRisk', async () => {
      const svc = await getService();

      await svc.create({
        inputContext: 'High risk',
        outputAction: 'Act',
        confidenceLevel: 0.5,
        riskScore: 0.9,
      });

      await svc.create({
        inputContext: 'Low risk',
        outputAction: 'Act',
        confidenceLevel: 0.8,
        riskScore: 0.1,
      });

      const list = await svc.list({ maxRisk: 0.5 });
      expect(list).toHaveLength(1);
      expect(list[0].inputContext).toBe('Low risk');
    });

    it('filters by startTime and endTime', async () => {
      const svc = await getService();

      await svc.create({
        inputContext: 'Before',
        outputAction: 'Act',
        confidenceLevel: 0.5,
        riskScore: 0.5,
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      await svc.create({
        inputContext: 'In window',
        outputAction: 'Act',
        confidenceLevel: 0.5,
        riskScore: 0.5,
        timestamp: '2025-06-15T00:00:00.000Z',
      });

      await svc.create({
        inputContext: 'After',
        outputAction: 'Act',
        confidenceLevel: 0.5,
        riskScore: 0.5,
        timestamp: '2025-12-31T00:00:00.000Z',
      });

      const list = await svc.list({
        startTime: '2025-02-01T00:00:00.000Z',
        endTime: '2025-11-01T00:00:00.000Z',
      });

      expect(list).toHaveLength(1);
      expect(list[0].inputContext).toBe('In window');
    });
  });

  // ─── getById ─────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns null for non-existent decision', async () => {
      const svc = await getService();
      const result = await svc.getById('decision_nonexistent');
      expect(result).toBeNull();
    });

    it('returns decision by ID', async () => {
      const svc = await getService();
      const created = await svc.create({
        inputContext: 'Find me',
        outputAction: 'Act',
        confidenceLevel: 0.7,
        riskScore: 0.3,
      });

      const found = await svc.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.inputContext).toBe('Find me');
    });
  });

  // ─── getChain ─────────────────────────────────────────────────────────────

  describe('getChain', () => {
    it('returns single-item chain for root decision', async () => {
      const svc = await getService();
      const root = await svc.create({
        inputContext: 'Root',
        outputAction: 'Act',
        confidenceLevel: 0.9,
        riskScore: 0.1,
      });

      const chain = await svc.getChain(root.id);
      expect(chain).toHaveLength(1);
      expect(chain[0].id).toBe(root.id);
    });

    it('returns full parent chain in order root → leaf', async () => {
      const svc = await getService();

      const root = await svc.create({
        inputContext: 'Root',
        outputAction: 'Act1',
        confidenceLevel: 0.9,
        riskScore: 0.1,
      });

      const mid = await svc.create({
        inputContext: 'Mid',
        outputAction: 'Act2',
        confidenceLevel: 0.8,
        riskScore: 0.2,
        parentDecisionId: root.id,
      });

      const leaf = await svc.create({
        inputContext: 'Leaf',
        outputAction: 'Act3',
        confidenceLevel: 0.7,
        riskScore: 0.3,
        parentDecisionId: mid.id,
      });

      const chain = await svc.getChain(leaf.id);
      expect(chain).toHaveLength(3);
      expect(chain[0].id).toBe(root.id);
      expect(chain[1].id).toBe(mid.id);
      expect(chain[2].id).toBe(leaf.id);
    });

    it('returns empty-ish chain when decision not found', async () => {
      const svc = await getService();
      const chain = await svc.getChain('decision_nonexistent_99');
      expect(chain).toEqual([]);
    });
  });

  // ─── updateAssumption ─────────────────────────────────────────────────────

  describe('updateAssumption', () => {
    it('updates an assumption status and note', async () => {
      const svc = await getService();
      const decision = await svc.create({
        inputContext: 'Ctx',
        outputAction: 'Act',
        confidenceLevel: 0.8,
        riskScore: 0.2,
        assumptions: ['Will succeed'],
      });

      const updated = await svc.updateAssumption(decision.id, 0, {
        status: 'confirmed',
        note: 'Verified in production',
      });

      expect(updated.assumptions[0].status).toBe('confirmed');
      expect(updated.assumptions[0].note).toBe('Verified in production');
      expect(updated.assumptions[0].updatedAt).toBeDefined();
    });

    it('throws NotFoundError for non-existent decision', async () => {
      const svc = await getService();
      await expect(
        svc.updateAssumption('decision_nonexistent', 0, { status: 'confirmed' })
      ).rejects.toThrow(/not found/i);
    });

    it('throws NotFoundError for out-of-bounds assumption index', async () => {
      const svc = await getService();
      const decision = await svc.create({
        inputContext: 'Ctx',
        outputAction: 'Act',
        confidenceLevel: 0.8,
        riskScore: 0.2,
        assumptions: ['One assumption'],
      });

      await expect(svc.updateAssumption(decision.id, 99, { status: 'failed' })).rejects.toThrow(
        /not found/i
      );
    });

    it('persists assumption update to disk', async () => {
      const svc = await getService();
      const decision = await svc.create({
        inputContext: 'Persist check',
        outputAction: 'Act',
        confidenceLevel: 0.9,
        riskScore: 0.1,
        assumptions: ['To be updated'],
      });

      await svc.updateAssumption(decision.id, 0, { status: 'failed', note: 'Did not hold' });

      // Re-read from disk
      const reloaded = await svc.getById(decision.id);
      expect(reloaded!.assumptions[0].status).toBe('failed');
      expect(reloaded!.assumptions[0].note).toBe('Did not hold');
    });
  });
});
