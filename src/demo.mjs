// src/demo.mjs
// Realistic 20-round coding-agent workflow replay. Exercises every layer
// (propose / supersede / restore / recall / compile / audit / regret /
// verdict) against a scripted scenario that mirrors real pitfalls this
// project itself hit while being built: a wrong `stateRoot` path assumption,
// a Linux-only API call that breaks on Windows, a Minecraft-version ceiling
// (1.21.8), and the store.transaction() reentrancy ban.
//
// Two entry points:
//   - `node src/demo.mjs` (CLI): runs against an isolated temp dataDir,
//     prints a human-readable transcript + final numbers, and cleans up
//     after itself (no data/ footprint).
//   - `seedDemoScenario({ dataDir, namespace })` (library): used by
//     server.mjs's /api/demo/seed route to populate the live 'demo'
//     namespace for the console UI's "一键载入踩坑演示剧本" button. Does
//     NOT delete anything afterward — the console is meant to inspect it.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClaimMemory } from './memory_sdk.mjs';

function src(ref, kind = 'user') {
  return { kind, ref, timestamp: new Date().toISOString() };
}

/**
 * Runs the full 20-round scripted scenario against the given claim-memory
 * instance. Returns a structured report with every measurement the caller
 * (CLI or server route) might want to print/display.
 */
export async function runDemoScenario(mem, { log = () => {} } = {}) {
  const report = { rounds: [], measurements: {} };

  // --- Round 1-6: propose 6 mixed claims, the real scars this project hit ---
  log('--- 第 1-6 轮：录入 6 条混合类型结论（真实踩坑） ---');

  const cStateRoot = await mem.propose({
    kind: 'constraint',
    claim: 'stateRoot 必须是 bots/<name>/state 不是仓库根目录',
    scope: { files: ['src/agent.js'], modules: ['agent'], tags: ['stateRoot'] },
    source: src('chat:round1-user-correction'),
    authority: 'user_explicit',
    confidence: 0.95,
    status: 'active',
  });

  const pLinuxOnly = await mem.propose({
    kind: 'pitfall',
    claim: 'fs.copyFileSync 的 COPYFILE_FICLONE 在 Windows 上会抛 ENOTSUP',
    scope: { files: ['src/agent.js'], modules: ['agent'], tags: ['windows', 'fs'] },
    source: src('tool:ci-run-17', 'tool'),
    authority: 'tool_verified',
    confidence: 0.9,
    status: 'active',
  });

  const dMcVersion = await mem.propose({
    kind: 'decision',
    claim: '目标 Minecraft 版本锁定 1.21.8，不支持 1.21.9+',
    scope: { files: ['src/agent.js'], modules: ['agent'], tags: ['minecraft-version'] },
    source: src('chat:round3-user-decision'),
    authority: 'user_explicit',
    confidence: 0.9,
    status: 'active',
  });

  const cLockReentrancy = await mem.propose({
    kind: 'constraint',
    claim: 'store.transaction 内部禁止再次调用 store.transaction',
    scope: { files: ['src/store.mjs'], modules: ['store'], tags: ['lock', 'transaction'] },
    source: src('chat:round4-user-correction'),
    authority: 'user_explicit',
    confidence: 0.95,
    status: 'active',
  });

  const pModuleNotFound = await mem.propose({
    kind: 'pitfall',
    claim: '修改文件后忘记更新 import 路径会触发 ERR_MODULE_NOT_FOUND',
    scope: { files: ['src/agent.js'], modules: ['agent'], tags: ['import'] },
    source: src('tool:ci-run-22', 'tool'),
    authority: 'tool_verified',
    confidence: 0.85,
    status: 'active',
  });

  const hRaceCondition = await mem.propose({
    kind: 'hypothesis',
    claim: '怀疑 agent.js 里的竞态条件来自重复 attach 事件监听器',
    scope: { files: ['src/agent.js'], modules: ['agent'], tags: ['race-condition'] },
    source: src('infer:agent-session-5', 'infer'),
    authority: 'agent_inferred',
    confidence: 0.4,
    status: 'unverified',
  });

  report.rounds.push({ round: 1, action: 'propose x6', ids: [cStateRoot, pLinuxOnly, dMcVersion, cLockReentrancy, pModuleNotFound, hRaceCondition].map((c) => c.block_id) });

  // --- Round 7: measure full-dump vs 3-channel compiled injection on src/agent.js ---
  log('--- 第 7 轮：在 src/agent.js 上测三通道编译 Token 节省率 ---');
  const compiledBefore = await mem.compileInjection(
    { taskText: '修改 agent.js 处理 stateRoot 和事件监听器', activeFiles: ['src/agent.js'] },
    { topK: 10 }
  );
  const savingsBefore = compiledBefore.debugTrace.savings;
  report.measurements.round7_token_savings_ratio = savingsBefore.token_savings_ratio;
  report.measurements.round7_full_chars = savingsBefore.full_chars;
  report.measurements.round7_compiled_chars = savingsBefore.compiled_chars;
  log(`    全量注入字符数=${savingsBefore.full_chars}  三通道注入字符数=${savingsBefore.compiled_chars}  节省比例=${(savingsBefore.token_savings_ratio * 100).toFixed(1)}%`);

  // --- Round 8: first compaction — a GOOD one, nothing lost -> healthy ---
  log('--- 第 8 轮：第一次压缩（优质摘要，全部保留） ---');
  const goodSummary = [
    'This session covered: stateRoot must be bots/<name>/state not repo root;',
    'fs.copyFileSync COPYFILE_FICLONE throws ENOTSUP on Windows;',
    'Minecraft target version locked at 1.21.8, no 1.21.9+ support;',
    'store.transaction must never be reentered from inside itself;',
    'modifying files without updating import paths triggers ERR_MODULE_NOT_FOUND;',
    'hypothesis: race condition from duplicate event listener attachment.',
  ].join(' ');
  const audit1 = await mem.auditCompaction(goodSummary, { sessionRef: 'demo-session', roundAt: 8, activeFiles: ['src/agent.js', 'src/store.mjs'] });
  report.rounds.push({ round: 8, action: 'auditCompaction (good)', lost_claims: audit1.lost_claims.length });
  const verdict8 = await mem.getVerdict();
  report.measurements.round8_verdict_state = verdict8.state;
  log(`    lost_claims=${audit1.lost_claims.length}  verdict=${verdict8.state}`);

  // --- Round 9-11: normal work continues, verify the hypothesis negatively once (not yet disputed) ---
  log('--- 第 9-11 轮：继续工作，一次失败验证（尚不足以转 disputed） ---');
  await mem.verify(hRaceCondition.block_id, { ok: false, note: '复现失败，监听器数量正常', currentRound: 10 });

  // --- Round 12: SECOND compaction — a BAD one, drops 2 critical claims ---
  log('--- 第 12 轮：第二次压缩（拙劣摘要，压丢 2 条硬约束/避雷坑） ---');
  const badSummary = 'This round we polished the console UI styling and added a new button layout.';
  const audit2 = await mem.auditCompaction(badSummary, { sessionRef: 'demo-session', roundAt: 12, activeFiles: ['src/agent.js', 'src/store.mjs'] });
  const lostIds = audit2.lost_claims.map((lc) => lc.block_id);
  report.rounds.push({ round: 12, action: 'auditCompaction (bad)', lost_claims: audit2.lost_claims.length, lost_ids: lostIds });
  log(`    lost_claims=${audit2.lost_claims.length}  (${lostIds.join(', ')})`);

  // --- Round 13: recall after the bad compaction immediately rescues the lost claims back into scope ---
  log('--- 第 13 轮：压缩后立即在 src/agent.js 召回，验证被压丢结论是否救回 ---');
  const recallAfterBad = await mem.recall({ taskText: '继续修改 agent.js 的 stateRoot 和事件监听器', activeFiles: ['src/agent.js'] }, { topK: 10 });
  const recalledIds = recallAfterBad.results.map((r) => r.claim.block_id);
  const rescuedLostIds = lostIds.filter((id) => recalledIds.includes(id));
  report.measurements.round13_rescued_lost_claims = rescuedLostIds;
  log(`    被救回的结论: ${rescuedLostIds.join(', ') || '(none matched src/agent.js scope)'}`);

  // --- Round 14: the agent, unaware of the lost stateRoot constraint, breaks it -> verifyClaim(ok:false) ---
  log('--- 第 14 轮：踩坑发生！agent 因为丢了 stateRoot 约束而写错代码，触发打脸 ---');
  await mem.verify(cStateRoot.block_id, { ok: false, note: '又把 stateRoot 写成了仓库根目录，测试炸了', evidenceRef: 'ci-run-31', currentRound: 14 });

  // --- Round 15: stream_verdict should now surface regret_alert ---
  log('--- 第 15 轮：检查 stream_verdict 是否亮出 regret_alert ---');
  const verdict15 = await mem.getVerdict();
  report.measurements.round15_verdict_state = verdict15.state;
  report.measurements.round15_headline = verdict15.headline;
  log(`    verdict=${verdict15.state}`);
  log(`    headline=${verdict15.headline}`);

  // --- Round 16: a technical decision gets superseded (McVersion-adjacent: switch detection strategy) ---
  log('--- 第 16 轮：技术方案推翻（superseded） ---');
  const dNewApproach = await mem.propose({
    kind: 'decision',
    claim: '改用版本协议握手探测替代硬编码 1.21.8 上限',
    scope: { files: ['src/agent.js'], modules: ['agent'], tags: ['minecraft-version'] },
    source: src('chat:round16-user-revision'),
    authority: 'user_explicit',
    confidence: 0.85,
    evidence: '硬编码上限在协议升级后总是要手动改，握手探测更稳',
  });
  const dMcVersionAfter = (await mem.inspect()).claims.find((c) => c.block_id === dMcVersion.block_id);
  report.rounds.push({ round: 16, action: 'supersede', superseded_id: dMcVersion.block_id, by: dNewApproach.block_id, status_after: dMcVersionAfter.status });
  log(`    ${dMcVersion.block_id} status after supersede = ${dMcVersionAfter.status}`);

  // --- Round 17: human disagrees, restores the old decision as disputed (manual arbitration) ---
  log('--- 第 17 轮：人工翻案，标记双方 disputed ---');
  await mem.restore(dMcVersion.block_id, { mode: 'mark_disputed', reason: '用户认为握手探测在旧版服务端不稳定，先搁置争议' });
  const afterRestore = await mem.inspect();
  const dMcVersionFinal = afterRestore.claims.find((c) => c.block_id === dMcVersion.block_id);
  const dNewApproachFinal = afterRestore.claims.find((c) => c.block_id === dNewApproach.block_id);
  report.rounds.push({ round: 17, action: 'restore mark_disputed', a_status: dMcVersionFinal.status, b_status: dNewApproachFinal.status });
  log(`    ${dMcVersion.block_id}=${dMcVersionFinal.status}  ${dNewApproach.block_id}=${dNewApproachFinal.status}`);

  // --- Round 18: verify the constraint/pitfall claims positively a few times (promotion candidate path) ---
  log('--- 第 18 轮：多次正向验证 lock-reentrancy 约束，走向 ready_to_promote ---');
  await mem.verify(cLockReentrancy.block_id, { ok: true, note: '代码审查确认无重入', currentRound: 18 });
  await mem.verify(cLockReentrancy.block_id, { ok: true, note: '压力测试确认无死锁', currentRound: 19 });
  await mem.verify(cLockReentrancy.block_id, { ok: true, note: '第三次复查依然成立', currentRound: 19 });

  // --- Round 19: final ledger + index consistency check ---
  log('--- 第 19 轮：账本与索引一致性核对 ---');
  const consistency = await mem.verifyIndexConsistency();
  report.measurements.index_consistent = consistency.consistent;
  log(`    verifyIndexConsistency: consistent=${consistency.consistent}`);

  // --- Round 20: final verdict snapshot ---
  log('--- 第 20 轮：最终大结论快照 ---');
  const finalVerdict = await mem.getVerdict();
  report.measurements.final_verdict_state = finalVerdict.state;
  report.measurements.final_headline = finalVerdict.headline;
  log(`    最终 verdict=${finalVerdict.state}`);
  log(`    ${finalVerdict.headline}`);

  const flow = await mem.evaluateCompactionFlow();
  report.measurements.flow = flow;

  return report;
}

/**
 * Library entry point: seed the scripted scenario into a persistent
 * namespace (used by the console's "一键载入踩坑演示剧本" button). Returns
 * the same report shape as the CLI run. Does not clean up afterward.
 */
export async function seedDemoScenario({ dataDir, namespace = 'demo' } = {}) {
  const mem = createClaimMemory({ dataDir, namespace });
  const logs = [];
  const report = await runDemoScenario(mem, { log: (line) => logs.push(line) });
  return { ...report, namespace, logs };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agent-claim-memory-demo-'));
  console.log(`[demo] isolated temp dataDir: ${tmpDir}`);
  console.log('========================================================');
  console.log(' Agent Claim Memory — 20 轮真实工作流回放剧本');
  console.log('========================================================');

  try {
    const mem = createClaimMemory({ dataDir: tmpDir, namespace: 'demo-cli' });
    const report = await runDemoScenario(mem, { log: (line) => console.log(line) });

    console.log('');
    console.log('========================================================');
    console.log(' 回放结果摘要');
    console.log('========================================================');
    console.log(`Token 节省率 (round 7 三通道编译 vs 全量): ${(report.measurements.round7_token_savings_ratio * 100).toFixed(1)}%`);
    console.log(`第一次压缩 (优质) lost_claims: ${report.rounds.find((r) => r.round === 8).lost_claims}  -> verdict: ${report.measurements.round8_verdict_state}`);
    console.log(`第二次压缩 (拙劣) lost_claims: ${report.rounds.find((r) => r.round === 12).lost_claims}`);
    console.log(`压缩后立即召回救回的结论: ${report.measurements.round13_rescued_lost_claims.join(', ') || '(none)'}`);
    console.log(`踩坑后 stream_verdict: ${report.measurements.round15_verdict_state}`);
    console.log(`最终 stream_verdict: ${report.measurements.final_verdict_state}`);
    console.log(`索引一致性: ${report.measurements.index_consistent}`);
    console.log(`四定义压缩流评分: ${JSON.stringify(report.measurements.flow)}`);

    if (report.measurements.round15_verdict_state !== 'regret_alert') {
      throw new Error('demo scenario expected regret_alert after the bad compaction + failed verify, got: ' + report.measurements.round15_verdict_state);
    }
    if (!report.measurements.index_consistent) {
      throw new Error('demo scenario expected a consistent index at round 19');
    }

    console.log('');
    console.log('[demo] 全部断言通过。');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    console.log(`[demo] 已清理临时目录: ${tmpDir}`);
  }
}

if (isMain) {
  main().catch((err) => {
    console.error('[demo] FAILED:', err);
    process.exitCode = 1;
  });
}
