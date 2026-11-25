// test/claim_memory.test.mjs
// 0 API-call unit tests. Uses os.tmpdir() for full isolation; every test
// removes its own tmp dir in a finally block so the project's data/ stays
// empty after a run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';

import { readFile, appendFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.mjs';
import { createAdjudicator } from '../src/adjudicator.mjs';
import { recallClaims } from '../src/recall.mjs';
import { compilePromptInjection } from '../src/injector.mjs';
import { auditCompaction, evaluateCompactionFlow } from '../src/compaction_flow.mjs';
import { getVerdict } from '../src/stream_verdict.mjs';
import { createClaimMemory } from '../src/memory_sdk.mjs';
import { runDemoScenario } from '../src/demo.mjs';

async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-claim-memory-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function src(ref, kind = 'user') {
  return { kind, ref, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 1) Lock-free-inside, no-deadlock concurrent transactions + verifyIndexConsistency
// ---------------------------------------------------------------------------
test('1) concurrent transactions do not deadlock and index stays 100% consistent', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });

    const jobs = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(
        store.transaction(async (tx) => {
          const claim = await tx.addClaim({
            block_id: `decision_concurrent_${i}`,
            namespace: 'default',
            kind: 'decision',
            claim: `concurrent decision number ${i}`,
            scope: { files: [`src/file${i}.mjs`], modules: [], tags: [] },
            source: src(`test:${i}`),
            authority: 'user_explicit',
            confidence: 0.9,
          });
          // second mutation inside the SAME transaction, using the lock-free tx handle
          tx.updateClaim(claim.block_id, { utility: 1.2 }, {
            at: new Date().toISOString(),
            actor: 'test',
            action: 'bump_utility',
            delta: 0,
            reason: 'same-tx follow-up mutation',
            evidence_ref: null,
          });
        })
      );
    }

    // Race them all; if transaction() ever reentered its own lock this would hang/throw.
    await Promise.all(jobs);

    const all = await store.listClaims('default', () => true);
    assert.equal(all.length, 20);
    assert.ok(all.every((c) => c.utility === 1.2));

    const report = await store.verifyIndexConsistency('default');
    assert.equal(report.consistent, true, JSON.stringify(report.mismatches));
    assert.equal(report.mem_count, 20);
    assert.equal(report.disk_count, 20);
  });
});

// ---------------------------------------------------------------------------
// 2) 90-day-old active architecture decision is still precisely recalled (no time decay)
// ---------------------------------------------------------------------------
test('2) a 90-day-old active decision is still recalled with full relevance (no time-based forgetting)', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

    await store.addClaim({
      block_id: 'decision_old_arch',
      namespace: 'default',
      kind: 'decision',
      claim: 'use event-sourced store with append-only jsonl for claims persistence',
      scope: { files: ['src/store.mjs'], modules: ['store'], tags: ['architecture'] },
      source: { kind: 'user', ref: 'chat:90-days-ago', timestamp: ninetyDaysAgo },
      authority: 'user_explicit',
      confidence: 0.95,
      status: 'active',
      created_at: ninetyDaysAgo,
    });

    // noise claim, unrelated scope, recent
    await store.addClaim({
      block_id: 'decision_noise',
      namespace: 'default',
      kind: 'decision',
      claim: 'unrelated recent decision about logging format',
      scope: { files: ['src/logger.mjs'], modules: ['logger'], tags: [] },
      source: src('chat:today'),
      authority: 'user_explicit',
      confidence: 0.95,
    });

    const result = await recallClaims(
      { taskText: 'event-sourced store append-only jsonl', activeFiles: ['src/store.mjs'], activeModules: ['store'] },
      { store, namespace: 'default', topK: 5 }
    );

    assert.ok(result.results.length > 0);
    assert.equal(result.results[0].claim.block_id, 'decision_old_arch');
    assert.ok(result.results[0].score > 0);
  });
});

// ---------------------------------------------------------------------------
// 3) scope.files hard filter + three-channel compiled injection + token savings
// ---------------------------------------------------------------------------
test('3) scope.files hard-filters recall and three-channel injection reports token savings', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });

    await store.addClaim({
      block_id: 'constraint_lock',
      namespace: 'default',
      kind: 'constraint',
      claim: 'never reenter store.transaction lock from inside a transaction',
      scope: { files: ['src/store.mjs'], modules: [], tags: [] },
      source: src('chat:1', 'user'),
      authority: 'user_explicit',
      confidence: 0.9,
      status: 'active',
    });
    await store.addClaim({
      block_id: 'pitfall_rescan',
      namespace: 'default',
      kind: 'pitfall',
      claim: 'full rescans on every write caused severe slowdowns before',
      scope: { files: ['src/store.mjs'], modules: [], tags: [] },
      source: src('tool:run42', 'tool'),
      authority: 'tool_verified',
      confidence: 0.8,
      status: 'active',
    });
    await store.addClaim({
      block_id: 'decision_unrelated',
      namespace: 'default',
      kind: 'decision',
      claim: 'unrelated module uses a totally different pattern for networking',
      scope: { files: ['src/network.mjs'], modules: [], tags: [] },
      source: src('chat:2'),
      authority: 'user_explicit',
      confidence: 0.9,
      status: 'active',
    });

    const compiled = await compilePromptInjection(
      { taskText: 'editing store transaction lock', activeFiles: ['src/store.mjs'] },
      { store, namespace: 'default' }
    );

    const allIds = [
      ...compiled.debugTrace.channel_assignment.compiled_constraints,
      ...compiled.debugTrace.channel_assignment.context_claims,
      ...compiled.debugTrace.channel_assignment.pitfall_warnings,
    ];
    assert.ok(!allIds.includes('decision_unrelated'), 'unrelated scope must be hard-filtered out');
    assert.ok(allIds.includes('constraint_lock'));
    assert.ok(allIds.includes('pitfall_rescan'));

    assert.ok(compiled.compiled_constraints.length <= 3);
    assert.ok(compiled.compiled_constraints.every((c) => c.length <= 30));
    assert.ok(compiled.pitfall_warnings.length >= 1);

    const savings = compiled.debugTrace.savings;
    assert.ok(typeof savings.token_savings_ratio === 'number');
    assert.ok(savings.token_savings_ratio > 0, 'compiled injection should be smaller than full dump');
  });
});

// ---------------------------------------------------------------------------
// 4) superseded supersession with evidence; disjoint scopes coexist, no false-kill
// ---------------------------------------------------------------------------
test('4) checkAndSupersede supersedes same-scope conflicts with evidence, leaves disjoint scopes untouched', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const adjudicator = createAdjudicator({ store });

    const old = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use polling for file watch',
      scope: { files: ['src/watcher.mjs'], modules: [], tags: [] },
      source: src('chat:old'),
      authority: 'user_explicit',
      confidence: 0.8,
      status: 'active',
    });

    const unrelated = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use streaming parser for logs',
      scope: { files: ['src/logparser.mjs'], modules: [], tags: [] },
      source: src('chat:unrelated'),
      authority: 'user_explicit',
      confidence: 0.8,
      status: 'active',
    });

    const pitfallA = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'pitfall',
      claim: 'polling file watch misses rapid rename sequences on network drives',
      scope: { files: ['src/watcher.mjs'], modules: [], tags: [] },
      source: src('tool:repro1', 'tool'),
      authority: 'tool_verified',
      confidence: 0.8,
      status: 'active',
    });

    const fresh = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use native fs.watch with debounce for file watch',
      scope: { files: ['src/watcher.mjs'], modules: [], tags: [] },
      source: src('chat:new', 'user'),
      authority: 'user_explicit',
      confidence: 0.9,
      evidence: 'benchmarked native fs.watch, 5x faster and catches renames',
    });

    const oldAfter = await store.getClaim('default', old.block_id);
    assert.equal(oldAfter.status, 'superseded');
    assert.equal(oldAfter.superseded_by, fresh.block_id);
    assert.ok(oldAfter.evidence && oldAfter.evidence.length > 0);

    const unrelatedAfter = await store.getClaim('default', unrelated.block_id);
    assert.equal(unrelatedAfter.status, 'active', 'disjoint-scope claim must not be superseded');

    const pitfallAfter = await store.getClaim('default', pitfallA.block_id);
    assert.equal(pitfallAfter.status, 'active', 'pitfall in same scope must coexist, not be auto-superseded');
  });
});

// ---------------------------------------------------------------------------
// 5) restore anti-double-active: mark_disputed and replace_current
// ---------------------------------------------------------------------------
test('5) restoreClaim never leaves two mutually exclusive claims both active', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const adjudicator = createAdjudicator({ store });

    const original = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'persist index as sqlite file',
      scope: { files: ['src/store.mjs'], modules: [], tags: [] },
      source: src('chat:orig'),
      authority: 'user_explicit',
      confidence: 0.8,
      status: 'active',
    });

    const replacement = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'persist index as plain json file',
      scope: { files: ['src/store.mjs'], modules: [], tags: [] },
      source: src('chat:replacement'),
      authority: 'user_explicit',
      confidence: 0.85,
      evidence: 'sqlite dependency violates zero-heavy-deps constraint',
    });

    let originalAfter = await store.getClaim('default', original.block_id);
    assert.equal(originalAfter.status, 'superseded');

    // -- mark_disputed path: both sides must end up disputed, never one active alone
    await adjudicator.restoreClaim(original.block_id, { mode: 'mark_disputed', reason: 'user disagrees with replacement' });
    let a = await store.getClaim('default', original.block_id);
    let b = await store.getClaim('default', replacement.block_id);
    assert.equal(a.status, 'disputed');
    assert.equal(b.status, 'disputed');
    assert.ok(!(a.status === 'active' && b.status === 'active'));

    // Re-set up a fresh pair for the replace_current path
    const o2 = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use yaml config format',
      scope: { files: ['config.mjs'], modules: [], tags: [] },
      source: src('chat:o2'),
      authority: 'user_explicit',
      confidence: 0.8,
    });
    const r2 = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use json config format',
      scope: { files: ['config.mjs'], modules: [], tags: [] },
      source: src('chat:r2'),
      authority: 'user_explicit',
      confidence: 0.85,
      evidence: 'yaml parser adds a dependency we want to avoid',
    });

    await adjudicator.restoreClaim(o2.block_id, { mode: 'replace_current', reason: 'yaml actually fine, no new dep needed' });
    const o2After = await store.getClaim('default', o2.block_id);
    const r2After = await store.getClaim('default', r2.block_id);
    assert.equal(o2After.status, 'active');
    assert.equal(r2After.status, 'superseded');
    assert.notEqual(o2After.status === 'active' && r2After.status === 'active', true);

    // restoreClaim on a 'superseded' claim WITHOUT mode must throw (never silently double-activate)
    const o3 = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use tabs for indentation',
      scope: { files: ['src/style.mjs'], modules: [], tags: [] },
      source: src('chat:o3'),
      authority: 'user_explicit',
      confidence: 0.8,
    });
    await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'decision',
      claim: 'use spaces for indentation',
      scope: { files: ['src/style.mjs'], modules: [], tags: [] },
      source: src('chat:o3b'),
      authority: 'user_explicit',
      confidence: 0.85,
      evidence: 'style guide requires spaces',
    });
    await assert.rejects(() => adjudicator.restoreClaim(o3.block_id, {}));
  });
});

// ---------------------------------------------------------------------------
// 6) verifyClaim positive/negative feedback updates confidence/utility + weight_ledger
// ---------------------------------------------------------------------------
test('6) verifyClaim updates confidence/utility and appends to weight_ledger on both success and failure', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const adjudicator = createAdjudicator({ store });

    const claim = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'hypothesis',
      claim: 'the race condition is in the debounce timer',
      scope: { files: ['src/watcher.mjs'], modules: [], tags: [] },
      source: src('infer:agent-1', 'infer'),
      authority: 'agent_inferred',
      confidence: 0.4,
      status: 'unverified',
    });
    const baseConfidence = claim.confidence;

    const afterOk = await adjudicator.verifyClaim(claim.block_id, { ok: true, evidenceRef: 'test-run-1', note: 'repro confirmed fix' });
    assert.ok(afterOk.confidence > baseConfidence);
    assert.equal(afterOk.status, 'active');
    assert.ok(afterOk.weight_ledger.length >= 2);
    assert.equal(afterOk.weight_ledger[afterOk.weight_ledger.length - 1].action, 'verify_ok');

    const afterFail1 = await adjudicator.verifyClaim(claim.block_id, { ok: false, evidenceRef: 'test-run-2', note: 'still happens' });
    assert.ok(afterFail1.confidence < afterOk.confidence);
    assert.notEqual(afterFail1.status, 'disputed'); // only 1 consecutive failure so far

    const afterFail2 = await adjudicator.verifyClaim(claim.block_id, { ok: false, evidenceRef: 'test-run-3', note: 'confirmed wrong hypothesis' });
    assert.equal(afterFail2.status, 'disputed', 'two consecutive failures should flip to disputed');
    assert.ok(afterFail2.weight_ledger.length >= 4);
  });
});

// ---------------------------------------------------------------------------
// 7) auditCompaction detects lost_claims, triggers compaction_regret, four-metric eval shows low trust
// ---------------------------------------------------------------------------
test('7) auditCompaction finds lost_claims, a later failure triggers compaction_regret, flow eval shows low trust', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const adjudicator = createAdjudicator({ store });

    const critical = await adjudicator.proposeClaim({
      namespace: 'default',
      kind: 'constraint',
      claim: 'always close the db handle before process exit to avoid file lock corruption',
      scope: { files: ['src/db.mjs'], modules: ['db'], tags: [] },
      source: src('chat:critical'),
      authority: 'user_explicit',
      confidence: 0.9,
      status: 'active',
    });

    const summaryThatMissesIt = 'This round we refactored the HTTP router and added new endpoints for the console UI.';

    const auditResult = await auditCompaction(
      summaryThatMissesIt,
      { sessionRef: 'session-1', roundAt: 5, activeFiles: ['src/db.mjs'] },
      { store, namespace: 'default' }
    );

    assert.ok(auditResult.lost_claims.some((lc) => lc.block_id === critical.block_id));

    // Later, a real failure happens in the same scope within the regret window.
    const failedClaim = await adjudicator.verifyClaim(critical.block_id, {
      ok: false,
      evidenceRef: 'test-crash-log',
      note: 'db file got corrupted because handle was never closed',
      currentRound: 8,
    });
    assert.ok(failedClaim.confidence < 0.9);

    const compactions = await store.listCompactions('default');
    const withRegret = compactions.find((c) => c.type === 'compaction' && (c.regrets || []).length > 0);
    assert.ok(withRegret, 'a compaction_regret entry should have been attached to the compaction event');
    assert.equal(withRegret.regrets[0].failed_claim_id, critical.block_id);

    const flow = await evaluateCompactionFlow({ store, namespace: 'default' });
    assert.ok(flow.regret_count >= 1);
    assert.ok(flow.trust_score < 1, 'trust_score should be diagnosed as degraded after a regret');
  });
});

// ---------------------------------------------------------------------------
// 8) stream_verdict produces regret_alert / ready_to_promote correctly
// ---------------------------------------------------------------------------
test('8) stream_verdict.getVerdict surfaces regret_alert and ready_to_promote from the underlying flow', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const adjudicator = createAdjudicator({ store });

    // --- scenario A: regret_alert ---
    const claimA = await adjudicator.proposeClaim({
      namespace: 'ns-regret',
      kind: 'constraint',
      claim: 'retry network calls with exponential backoff, max 3 attempts',
      scope: { files: ['src/net.mjs'], modules: [], tags: [] },
      source: src('chat:a'),
      authority: 'user_explicit',
      confidence: 0.9,
      status: 'active',
    });
    await auditCompaction(
      'Nothing about retries mentioned here, just UI tweaks.',
      { sessionRef: 's1', roundAt: 2, activeFiles: ['src/net.mjs'] },
      { store, namespace: 'ns-regret' }
    );
    await adjudicator.verifyClaim(claimA.block_id, { ok: false, note: 'no backoff happened, server got hammered', currentRound: 4 });

    const verdictA = await getVerdict({ store, namespace: 'ns-regret' });
    assert.equal(verdictA.state, 'regret_alert');
    assert.ok(verdictA.headline.length > 0);

    // --- scenario B: ready_to_promote ---
    const claimB = await adjudicator.proposeClaim({
      namespace: 'ns-promote',
      kind: 'decision',
      claim: 'use exponential backoff retry wrapper for all outbound http calls',
      scope: { files: ['src/http.mjs'], modules: [], tags: [] },
      source: src('infer:agent', 'infer'),
      authority: 'agent_inferred',
      confidence: 0.6,
      status: 'unverified',
    });
    await adjudicator.verifyClaim(claimB.block_id, { ok: true, note: 'verified in staging' });
    await adjudicator.verifyClaim(claimB.block_id, { ok: true, note: 'verified in prod incident drill' });
    await adjudicator.verifyClaim(claimB.block_id, { ok: true, note: 'verified again after refactor' });

    const verdictB = await getVerdict({ store, namespace: 'ns-promote' });
    assert.equal(verdictB.state, 'ready_to_promote');
    assert.ok(verdictB.suggested_actions.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 9) memory_sdk.mjs multi-namespace physical isolation
// ---------------------------------------------------------------------------
test('9) createClaimMemory enforces physical namespace isolation on disk and in queries', async () => {
  await withTmpDir(async (dir) => {
    const memA = createClaimMemory({ dataDir: dir, namespace: 'project-a' });
    const memB = createClaimMemory({ dataDir: dir, namespace: 'project-b' });

    await memA.propose({
      kind: 'decision',
      claim: 'project A uses postgres',
      scope: { files: ['a/db.mjs'], modules: [], tags: [] },
      source: src('chat:a'),
      authority: 'user_explicit',
      confidence: 0.9,
      status: 'active',
    });
    await memB.propose({
      kind: 'decision',
      claim: 'project B uses sqlite-free flat files',
      scope: { files: ['b/db.mjs'], modules: [], tags: [] },
      source: src('chat:b'),
      authority: 'user_explicit',
      confidence: 0.9,
      status: 'active',
    });

    const inspectA = await memA.inspect();
    const inspectB = await memB.inspect();
    assert.equal(inspectA.claims.length, 1);
    assert.equal(inspectB.claims.length, 1);
    assert.notEqual(inspectA.claims[0].claim, inspectB.claims[0].claim);

    const dirsA = await readdir(path.join(dir, 'namespaces', 'project-a'));
    const dirsB = await readdir(path.join(dir, 'namespaces', 'project-b'));
    assert.ok(dirsA.includes('claims.jsonl'));
    assert.ok(dirsB.includes('claims.jsonl'));

    const recallFromA = await memA.recall({ taskText: 'postgres', activeFiles: ['a/db.mjs'] });
    assert.ok(recallFromA.results.every((r) => r.claim.namespace === 'project-a'));
  });
});

// ---------------------------------------------------------------------------
// 10) crash-mid-write self-healing: truncated tail line + missing index.json
// ---------------------------------------------------------------------------
test('10) store self-heals from a truncated trailing JSONL line and a missing/corrupt claim_index.json', async () => {
  await withTmpDir(async (dir) => {
    const store1 = createStore({ dataDir: dir });
    await store1.addClaim({
      block_id: 'c1',
      namespace: 'default',
      kind: 'decision',
      claim: 'first durable claim',
      scope: { files: ['a.mjs'], modules: [], tags: [] },
      source: src('chat:1'),
      authority: 'user_explicit',
      confidence: 0.8,
    });
    await store1.addClaim({
      block_id: 'c2',
      namespace: 'default',
      kind: 'decision',
      claim: 'second durable claim',
      scope: { files: ['b.mjs'], modules: [], tags: [] },
      source: src('chat:2'),
      authority: 'user_explicit',
      confidence: 0.8,
    });

    const claimsPath = path.join(dir, 'namespaces', 'default', 'claims.jsonl');
    const indexPath = path.join(dir, 'namespaces', 'default', 'claim_index.json');

    // Simulate a crash mid-write: append a half-written JSON line with NO
    // trailing newline (the hallmark of a process killed between write()
    // and the final fsync/newline).
    await appendFile(claimsPath, '{"block_id":"c3_never_finished","namespace":"def');

    // Simulate the index cache never having been flushed (or corrupted).
    await unlink(indexPath);

    // Cold-load a brand-new Store instance pointed at the same dataDir.
    const store2 = createStore({ dataDir: dir });
    const claims = await store2.listClaims('default', () => true);

    assert.equal(claims.length, 2, 'the two valid claims must survive; the truncated tail must be dropped, not crash loading');
    assert.ok(claims.some((c) => c.block_id === 'c1'));
    assert.ok(claims.some((c) => c.block_id === 'c2'));
    assert.ok(!claims.some((c) => c.block_id === 'c3_never_finished'));

    const diagnostics = store2.getLoadDiagnostics('default');
    assert.equal(diagnostics.claims_truncated_tail_dropped, true);
    assert.equal(diagnostics.index_repaired_from_log, true);

    // The repaired index should have been persisted back to disk immediately.
    const rewrittenIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(rewrittenIndex.claims.length, 2);

    const consistency = await store2.verifyIndexConsistency('default');
    assert.equal(consistency.consistent, true);
  });
});

// ---------------------------------------------------------------------------
// 11) cold-restart block_id lookup: brand-new instance, no prior recall/propose
// ---------------------------------------------------------------------------
test('11) a brand-new createClaimMemory instance can verifyClaim/restoreClaim by bare block_id after a cold restart', async () => {
  await withTmpDir(async (dir) => {
    const memSession1 = createClaimMemory({ dataDir: dir, namespace: 'proj' });
    const original = await memSession1.propose({
      kind: 'decision',
      claim: 'use webpack for bundling',
      scope: { files: ['build.mjs'], modules: [], tags: [] },
      source: src('chat:orig'),
      authority: 'user_explicit',
      confidence: 0.8,
      status: 'active',
    });
    const replacement = await memSession1.propose({
      kind: 'decision',
      claim: 'use esbuild for bundling',
      scope: { files: ['build.mjs'], modules: [], tags: [] },
      source: src('chat:faster'),
      authority: 'user_explicit',
      confidence: 0.85,
      evidence: 'esbuild benchmarks 10x faster cold build',
    });
    const hypothesis = await memSession1.propose({
      kind: 'hypothesis',
      claim: 'suspect esbuild plugin ordering causes the warning',
      scope: { files: ['build.mjs'], modules: [], tags: [] },
      source: src('infer:a', 'infer'),
      authority: 'agent_inferred',
      confidence: 0.4,
      status: 'unverified',
    });

    // Brand-new process simulation: a fresh Store/Adjudicator/SDK instance,
    // same dataDir, with ZERO prior recall()/propose() calls to warm any
    // in-memory cache. Directly operate on bare block_ids.
    const memSession2 = createClaimMemory({ dataDir: dir, namespace: 'proj' });

    const verified = await memSession2.verify(hypothesis.block_id, { ok: true, note: 'confirmed after cold restart' });
    assert.equal(verified.status, 'active');
    assert.ok(verified.confidence > 0.4);

    const restored = await memSession2.restore(original.block_id, { mode: 'mark_disputed', reason: 'cold restart arbitration' });
    assert.equal(restored.status, 'disputed');
    const replacementAfter = await memSession2.store.getClaim('proj', replacement.block_id);
    assert.equal(replacementAfter.status, 'disputed');

    const ledger = await memSession2.getLedger(hypothesis.block_id);
    assert.ok(ledger.weight_ledger.length >= 2);

    // Also test the case with NO namespace hint at all (auto-scan path):
    // use a fresh Adjudicator over the same store from yet another cold SDK instance.
    const memSession3 = createClaimMemory({ dataDir: dir, namespace: 'some-other-ns' });
    const verifiedNoNsHint = await memSession3.adjudicator.verifyClaim(hypothesis.block_id, { ok: true, note: 'verified again via auto-scan' });
    assert.equal(verifiedNoNsHint.block_id, hypothesis.block_id);
  });
});

// ---------------------------------------------------------------------------
// 12) repeated propose -> supersede -> restore -> verify -> supersede churn,
//     index must still match a full replay exactly
// ---------------------------------------------------------------------------
test('12) repeated state-machine churn across many rounds keeps the index byte-for-byte consistent with a full replay', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });
    const adjudicator = createAdjudicator({ store });

    let current = await adjudicator.proposeClaim({
      namespace: 'churn',
      kind: 'decision',
      claim: 'iteration 0 decision about caching strategy',
      scope: { files: ['cache.mjs'], modules: [], tags: [] },
      source: src('chat:iter0'),
      authority: 'user_explicit',
      confidence: 0.8,
    });

    for (let i = 1; i <= 8; i++) {
      const currentBefore = await store.getClaim('churn', current.block_id);

      const next = await adjudicator.proposeClaim({
        namespace: 'churn',
        kind: 'decision',
        claim: `iteration ${i} decision about caching strategy, revision ${i}`,
        scope: { files: ['cache.mjs'], modules: [], tags: [] },
        source: src(`chat:iter${i}`),
        authority: 'user_explicit',
        confidence: 0.8,
        evidence: `revision ${i} supersedes revision ${i - 1}`,
      });

      // next supersedes current ONLY if current was still 'active' at propose
      // time (checkAndSupersede only targets active same-scope claims; a
      // claim already 'disputed' from a prior round's arbitration is left
      // alone on purpose — disputes don't get silently auto-resolved).
      const currentAfter = await store.getClaim('churn', current.block_id);
      if (currentBefore.status === 'active') {
        assert.equal(currentAfter.status, 'superseded');
      } else {
        assert.equal(currentAfter.status, currentBefore.status);
      }

      if (i % 3 === 0) {
        // Occasionally restore-and-dispute the old one, then re-verify the new one.
        await adjudicator.restoreClaim(current.block_id, { mode: 'mark_disputed', reason: `periodic arbitration at iter ${i}` });
        await adjudicator.verifyClaim(next.block_id, { ok: true, note: `spot check at iter ${i}` });
      }

      current = next;
    }

    // Final consistency check: incremental index vs full cold replay.
    const report = await store.verifyIndexConsistency('churn');
    assert.equal(report.consistent, true, JSON.stringify(report.mismatches));

    // Cross-check against an entirely independent fresh Store instance that
    // only ever replays from disk (never touched the incremental path).
    const freshStore = createStore({ dataDir: dir });
    const freshClaims = await freshStore.listClaims('churn', () => true);
    const liveClaims = await store.listClaims('churn', () => true);
    assert.equal(freshClaims.length, liveClaims.length);

    const freshById = new Map(freshClaims.map((c) => [c.block_id, c]));
    for (const liveClaim of liveClaims) {
      assert.deepEqual(freshById.get(liveClaim.block_id), liveClaim, `mismatch on ${liveClaim.block_id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 13) IDF resists high-frequency filler words and ranks the rare, specific
//     error-code claim first
// ---------------------------------------------------------------------------
test('13) real IDF-weighted BM25 ranks a rare specific error code above 10 generic filler-word claims', async () => {
  await withTmpDir(async (dir) => {
    const store = createStore({ dataDir: dir });

    for (let i = 0; i < 10; i++) {
      await store.addClaim({
        block_id: `filler_${i}`,
        namespace: 'default',
        kind: 'decision',
        claim: `修改文件 ${i} 的时候要先备份文件再修改文件内容`,
        scope: { files: [`src/filler${i}.mjs`], modules: [], tags: [] },
        source: src(`chat:filler${i}`),
        authority: 'user_explicit',
        confidence: 0.8,
        status: 'active',
      });
    }

    await store.addClaim({
      block_id: 'specific_error',
      namespace: 'default',
      kind: 'pitfall',
      claim: '修改文件路径后如果忘记同步 import 会遇到 ERR_MODULE_NOT_FOUND 报错',
      scope: { files: ['src/filler0.mjs'], modules: [], tags: [] },
      source: src('tool:repro', 'tool'),
      authority: 'tool_verified',
      confidence: 0.85,
      status: 'active',
    });

    const result = await recallClaims(
      { taskText: '修改文件遇到 ERR_MODULE_NOT_FOUND', activeFiles: ['src/filler0.mjs'] },
      { store, namespace: 'default', topK: 11 }
    );

    assert.ok(result.results.length > 0);
    assert.equal(result.results[0].claim.block_id, 'specific_error', 'the rare, specific error-code claim must rank first, not a generic filler-word claim');
  });
});

// ---------------------------------------------------------------------------
// 14) end-to-end demo scenario replay: token savings, regret detection,
//     verdict accuracy, and clean teardown
// ---------------------------------------------------------------------------
test('14) the full 20-round demo scenario replay hits >40% token savings, catches compaction_regret, and leaves data/ clean', async () => {
  await withTmpDir(async (dir) => {
    const mem = createClaimMemory({ dataDir: dir, namespace: 'demo-test' });
    const report = await runDemoScenario(mem, { log: () => {} });

    assert.ok(
      report.measurements.round7_token_savings_ratio > 0.4,
      `expected >40% token savings, got ${report.measurements.round7_token_savings_ratio}`
    );
    assert.equal(report.measurements.round8_verdict_state, 'healthy');
    assert.ok(report.measurements.round13_rescued_lost_claims.length > 0, 'at least one lost claim should be rescued by scope-based recall');
    assert.equal(report.measurements.round15_verdict_state, 'regret_alert');
    assert.equal(report.measurements.index_consistent, true);
    assert.ok(report.measurements.flow.regret_count >= 1);
  });

  // withTmpDir's finally already removed the tmp dir; this test adds no
  // files anywhere under the project itself, so no extra cleanup is needed
  // here. The assertion below documents that expectation explicitly.
  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  const projectDataDir = path.join(testFileDir, '..', 'data');
  let projectDataExists = true;
  try {
    await readFile(path.join(projectDataDir, 'namespaces'));
    projectDataExists = true;
  } catch (err) {
    projectDataExists = err.code !== 'ENOENT';
  }
  assert.equal(projectDataExists, false, 'project data/ directory must not exist after this test run');
});
