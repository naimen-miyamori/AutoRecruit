import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createBossRejectionEmailDispatcher,
  type BossRejectionEmailDispatcherDependencies,
} from '../reporting/boss-rejection-email-dispatcher.js';
import { MailDeliveryError } from '../reporting/mailer.js';
import { BossRejectionEmailDispatchBusyError, JobStore } from '../storage/job-store.js';
import type {
  BossCandidateRoutingArtifact,
  BossRejectionEmailOutboxEntry,
} from '../types/job.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function makeRoutingArtifact(candidateId: string, deliveryId: string): BossCandidateRoutingArtifact {
  return {
    routingDecisionId: `decision-${deliveryId}`,
    candidateId,
    fetchedAt: '2026-08-12T01:00:00.000Z',
    scoredAt: '2026-08-12T01:01:00.000Z',
    decidedAt: '2026-08-12T01:02:00.000Z',
    policyHash: 'policy-v2',
    scoreStatus: 'success',
    classification: 'rejected',
    audience: 'secondary',
    requirementEvaluations: [],
    matchedRequirementIds: [],
    unknownRequirementIds: [],
    reason: 'fixture rejection',
    deliveryKind: 'rejection-email',
  };
}

function makeEntry(candidateId: string, deliveryId: string, createdOffsetMs: number): BossRejectionEmailOutboxEntry {
  const markdown = `fixture body ${deliveryId}`;
  const routingArtifact = makeRoutingArtifact(candidateId, deliveryId);
  const createdAt = new Date(Date.parse('2026-08-12T01:03:00.000Z') + createdOffsetMs).toISOString();
  return {
    version: 1,
    deliveryId,
    candidateId,
    routingDecisionId: routingArtifact.routingDecisionId!,
    routingArtifact,
    policyHash: routingArtifact.policyHash,
    recipientEmail: 'review@company.cn',
    ccEmails: [],
    messageId: `<${deliveryId}@autorecruit.local>`,
    subject: `fixture ${deliveryId}`,
    markdown,
    contentHash: createHash('sha256').update(markdown).digest('hex'),
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    detailClosedAt: createdAt,
  };
}

async function persistEntry(store: JobStore, jobKey: string, entry: BossRejectionEmailOutboxEntry): Promise<void> {
  await store.saveBossRejectionEmailOutboxEntry('boss', jobKey, entry);
  await store.saveBossCandidateRoutingArtifact('boss', jobKey, entry.routingArtifact);
}

test('rejection email dispatcher has no browser or platform action capability', async () => {
  const source = await readFile(
    new URL('../reporting/boss-rejection-email-dispatcher.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"](?:\.\.\/)?browser\//u);
  assert.doesNotMatch(source, /from ['"](?:\.\.\/)?platforms\//u);
  assert.doesNotMatch(source, /playwright/iu);
});

test('progressive rejection dispatcher is non-blocking, serial, and cadence-bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-dispatcher-'));
  const store = new JobStore(root);
  const jobKey = 'progressive-job';
  const first = makeEntry('candidate-a', 'delivery-a', 0);
  const second = makeEntry('candidate-b', 'delivery-b', 1);
  await persistEntry(store, jobKey, first);
  await persistEntry(store, jobKey, second);

  let nowMs = Date.parse('2026-08-12T02:00:00.000Z');
  const firstSend = deferred<{ recipient: string; subject: string }>();
  const starts: number[] = [];
  let activeSends = 0;
  let maxActiveSends = 0;
  const dependencies: BossRejectionEmailDispatcherDependencies = {
    now: () => new Date(nowMs),
    delay: async (delayMs) => { nowMs += delayMs; },
    minimumAttemptGapMs: 3_000,
    assertSmtpConfigurationReady: () => undefined,
    sendMail: async ({ recipient, subject }) => {
      starts.push(nowMs);
      activeSends += 1;
      maxActiveSends = Math.max(maxActiveSends, activeSends);
      try {
        if (starts.length === 1) return await firstSend.promise;
        return { recipient, subject };
      } finally {
        activeSends -= 1;
      }
    },
  };
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies,
  });

  dispatcher.enqueueLive(first);
  await waitFor(() => starts.length === 1, 'first SMTP attempt did not start');
  let browserAdvanced = false;
  dispatcher.enqueueLive(second);
  browserAdvanced = true;
  assert.equal(browserAdvanced, true, 'enqueue must not await the first SMTP result');
  assert.equal(starts.length, 1, 'second SMTP attempt must not overlap the first');

  firstSend.resolve({ recipient: first.recipientEmail, subject: first.subject });
  const summary = await dispatcher.closeAndDrain();
  assert.equal(summary.pause, undefined);
  assert.equal(summary.smtpAttemptCount, 2);
  assert.deepEqual(summary.entries.map((entry) => entry.status), ['sent', 'sent']);
  assert.equal(maxActiveSends, 1);
  assert.equal(starts[1]! - starts[0]!, 3_000);
});

test('progressive rejection dispatcher opens a circuit after known-not-sent and preserves later pending work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-circuit-'));
  const store = new JobStore(root);
  const jobKey = 'circuit-job';
  const first = makeEntry('candidate-a', 'delivery-a', 0);
  const second = makeEntry('candidate-b', 'delivery-b', 1);
  await persistEntry(store, jobKey, first);
  await persistEntry(store, jobKey, second);
  let sendCalls = 0;
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async () => {
        sendCalls += 1;
        throw new MailDeliveryError('fixture auth failure', {
          phase: 'auth',
          retrySafety: 'known-not-sent',
          retryDisposition: 'deferred-once',
          code: 'EAUTH',
          command: 'AUTH',
          responseCode: 535,
        });
      },
    },
  });
  dispatcher.enqueueLive(first);
  dispatcher.enqueueLive(second);
  const summary = await dispatcher.closeAndDrain();

  assert.equal(sendCalls, 1);
  assert.equal(summary.smtpAttemptCount, 1);
  assert.equal(summary.pause?.code, 'known-not-sent');
  assert.deepEqual(summary.entries.map((entry) => [entry.status, entry.attemptCount ?? 0]), [
    ['retryable-failed', 1],
    ['pending', 0],
  ]);
});

test('progressive rejection dispatcher refuses missing close proof without SMTP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-close-proof-'));
  const store = new JobStore(root);
  const jobKey = 'close-proof-job';
  const entry = { ...makeEntry('candidate-a', 'delivery-a', 0), detailClosedAt: undefined };
  await persistEntry(store, jobKey, entry);
  let sendCalls = 0;
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async ({ recipient, subject }) => {
        sendCalls += 1;
        return { recipient, subject };
      },
    },
  });
  dispatcher.enqueueLive(entry);
  const summary = await dispatcher.closeAndDrain();
  assert.equal(sendCalls, 0);
  assert.equal(summary.smtpAttemptCount, 0);
  assert.equal(summary.pause?.code, 'delivery-not-executable');
  assert.equal((await store.readBossRejectionEmailOutboxEntry('boss', jobKey, entry.deliveryId))?.status, 'pending');
});

test('progressive rejection dispatcher deduplicates a delivery within one run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-deduplicate-'));
  const store = new JobStore(root);
  const jobKey = 'deduplicate-job';
  const entry = makeEntry('candidate-a', 'delivery-a', 0);
  await persistEntry(store, jobKey, entry);
  let sendCalls = 0;
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async ({ recipient, subject }) => {
        sendCalls += 1;
        return { recipient, subject };
      },
    },
  });
  assert.equal(dispatcher.enqueueLive(entry), 'accepted');
  assert.equal(dispatcher.enqueueLive(entry), 'duplicate');
  const summary = await dispatcher.closeAndDrain();
  assert.equal(sendCalls, 1);
  assert.equal(summary.entries.length, 1);
  assert.equal(summary.entries[0]?.status, 'sent');
});

test('progressive rejection dispatcher prioritizes newly closed live work over untouched recovery work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-live-priority-'));
  const store = new JobStore(root);
  const jobKey = 'live-priority-job';
  const firstRecovery = makeEntry('candidate-recovery-a', 'delivery-recovery-a', 0);
  const secondRecovery = makeEntry('candidate-recovery-b', 'delivery-recovery-b', 1);
  const live = makeEntry('candidate-live', 'delivery-live', 2);
  await persistEntry(store, jobKey, firstRecovery);
  await persistEntry(store, jobKey, secondRecovery);
  await persistEntry(store, jobKey, live);
  const firstSend = deferred<{ recipient: string; subject: string }>();
  const subjects: string[] = [];
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    recoveryEntries: [firstRecovery, secondRecovery],
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 0,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async ({ recipient, subject }) => {
        subjects.push(subject);
        if (subjects.length === 1) return firstSend.promise;
        return { recipient, subject };
      },
    },
  });
  await waitFor(() => subjects.length === 1, 'first recovery SMTP attempt did not start');
  dispatcher.enqueueLive(live);
  firstSend.resolve({ recipient: firstRecovery.recipientEmail, subject: firstRecovery.subject });
  const summary = await dispatcher.closeAndDrain();

  assert.deepEqual(subjects, [firstRecovery.subject, live.subject, secondRecovery.subject]);
  assert.equal(summary.smtpAttemptCount, 3);
  assert.equal(summary.pause, undefined);
});

test('progressive rejection dispatcher reconciles inherited sending to uncertain and stops later work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-inherited-sending-'));
  const store = new JobStore(root);
  const jobKey = 'inherited-sending-job';
  const sending = {
    ...makeEntry('candidate-sending', 'delivery-sending', 0),
    status: 'sending' as const,
    attemptCount: 1,
    attemptedAt: '2026-08-12T01:04:00.000Z',
  };
  const secondSending = {
    ...makeEntry('candidate-sending-b', 'delivery-sending-b', 1),
    status: 'sending' as const,
    attemptCount: 1,
    attemptedAt: '2026-08-12T01:04:01.000Z',
  };
  const pending = makeEntry('candidate-pending', 'delivery-pending', 2);
  await persistEntry(store, jobKey, sending);
  await persistEntry(store, jobKey, secondSending);
  await persistEntry(store, jobKey, pending);
  let sendCalls = 0;
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    recoveryEntries: [pending, secondSending, sending],
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async ({ recipient, subject }) => {
        sendCalls += 1;
        return { recipient, subject };
      },
    },
  });
  const summary = await dispatcher.closeAndDrain();

  assert.equal(sendCalls, 0);
  assert.equal(summary.smtpAttemptCount, 0);
  assert.equal(summary.pause?.code, 'uncertain');
  assert.deepEqual(summary.entries.map((entry) => [entry.deliveryId, entry.status]), [
    [sending.deliveryId, 'uncertain'],
    [secondSending.deliveryId, 'uncertain'],
    [pending.deliveryId, 'pending'],
  ]);
});

test('progressive rejection dispatcher rejects an enqueue snapshot that conflicts with durable immutable facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-immutable-conflict-'));
  const store = new JobStore(root);
  const jobKey = 'immutable-conflict-job';
  const persisted = makeEntry('candidate-a', 'delivery-a', 0);
  await persistEntry(store, jobKey, persisted);
  let sendCalls = 0;
  const dispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async ({ recipient, subject }) => {
        sendCalls += 1;
        return { recipient, subject };
      },
    },
  });
  dispatcher.enqueueLive({ ...persisted, subject: 'conflicting immutable subject' });
  const summary = await dispatcher.closeAndDrain();

  assert.equal(sendCalls, 0);
  assert.equal(summary.smtpAttemptCount, 0);
  assert.equal(summary.pause?.code, 'routing-conflict');
  assert.equal(summary.entries[0]?.status, 'pending');
});

test('two dispatchers cannot send different deliveries for the same Boss job concurrently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-cross-dispatcher-'));
  const firstStore = new JobStore(root);
  const secondStore = new JobStore(root);
  const jobKey = 'cross-dispatcher-job';
  const firstEntry = makeEntry('candidate-a', 'delivery-a', 0);
  const secondEntry = makeEntry('candidate-b', 'delivery-b', 1);
  await persistEntry(firstStore, jobKey, firstEntry);
  await persistEntry(firstStore, jobKey, secondEntry);
  const firstSend = deferred<{ recipient: string; subject: string }>();
  let firstSendStarted = false;
  let secondSendCalls = 0;
  const firstDispatcher = createBossRejectionEmailDispatcher({
    store: firstStore,
    jobKey,
    policyHash: 'policy-v2',
    dependencies: {
      now: () => new Date('2026-08-12T02:00:00.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async () => {
        firstSendStarted = true;
        return firstSend.promise;
      },
    },
  });
  firstDispatcher.enqueueLive(firstEntry);
  await waitFor(() => firstSendStarted, 'first dispatcher SMTP attempt did not start');
  const secondDispatcher = createBossRejectionEmailDispatcher({
    store: secondStore,
    jobKey,
    policyHash: 'policy-v2',
    dependencies: {
      now: () => new Date('2026-08-12T02:00:01.000Z'),
      delay: async () => undefined,
      minimumAttemptGapMs: 3_000,
      assertSmtpConfigurationReady: () => undefined,
      sendMail: async ({ recipient, subject }) => {
        secondSendCalls += 1;
        return { recipient, subject };
      },
    },
  });
  secondDispatcher.enqueueLive(secondEntry);
  const secondSummary = await secondDispatcher.closeAndDrain();
  assert.equal(secondSendCalls, 0);
  assert.equal(secondSummary.pause?.code, 'dispatch-busy');
  assert.equal(secondSummary.entries[0]?.status, 'pending');

  firstSend.resolve({ recipient: firstEntry.recipientEmail, subject: firstEntry.subject });
  const firstSummary = await firstDispatcher.closeAndDrain();
  assert.equal(firstSummary.entries[0]?.status, 'sent');
});

test('dispatch cadence survives dispatcher replacement for the same Boss job', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-persisted-cadence-'));
  const store = new JobStore(root);
  const jobKey = 'persisted-cadence-job';
  const first = makeEntry('candidate-a', 'delivery-a', 0);
  const second = makeEntry('candidate-b', 'delivery-b', 1);
  await persistEntry(store, jobKey, first);
  await persistEntry(store, jobKey, second);
  let nowMs = Date.parse('2026-08-12T02:00:00.000Z');
  const starts: number[] = [];
  const delays: number[] = [];
  const dependencies: BossRejectionEmailDispatcherDependencies = {
    now: () => new Date(nowMs),
    delay: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    },
    minimumAttemptGapMs: 3_000,
    assertSmtpConfigurationReady: () => undefined,
    sendMail: async ({ recipient, subject }) => {
      starts.push(nowMs);
      return { recipient, subject };
    },
  };
  const firstDispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies,
  });
  firstDispatcher.enqueueLive(first);
  await firstDispatcher.closeAndDrain();

  nowMs += 1_000;
  const secondDispatcher = createBossRejectionEmailDispatcher({
    store,
    jobKey,
    policyHash: 'policy-v2',
    dependencies,
  });
  secondDispatcher.enqueueLive(second);
  await secondDispatcher.closeAndDrain();

  assert.deepEqual(delays, [2_000]);
  assert.equal(starts[1]! - starts[0]!, 3_000);
});

test('Boss rejection dispatch lease excludes another store for the same job', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boss-rejection-dispatch-lock-'));
  const firstStore = new JobStore(root);
  const secondStore = new JobStore(root);
  const release = deferred<void>();
  const acquired = deferred<void>();
  const first = firstStore.withBossRejectionEmailDispatchLock('boss', 'locked-job', async () => {
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  await assert.rejects(
    secondStore.withBossRejectionEmailDispatchLock('boss', 'locked-job', async () => undefined),
    (error: unknown) => error instanceof BossRejectionEmailDispatchBusyError,
  );
  release.resolve();
  await first;
});
