// src/store.mjs
// Transactional, namespace-sharded storage for claims and compaction events.
//
// Anti-deadlock rule: ALL mutation goes through private, lock-free `_*` helpers.
// The only lock-acquiring entry point is `transaction()`. Public convenience
// methods (addClaim, updateClaim, ...) are thin wrappers that open their own
// single-statement transaction — they must never be called from inside an
// already-open transaction callback. Code that needs several ops atomically
// must call `store.transaction(async tx => { tx.addClaim(...); tx.updateClaim(...) })`
// and use the `tx` handle (lock-free) instead of the public `store.*` methods.
//
// Anti full-rescan-explosion rule: the in-memory index is patched incrementally
// as records are appended; nothing re-reads the whole JSONL on every write.
// A full replay only happens in verifyIndexConsistency() (diagnostic) or on
// cold load (process start).

import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildClaim } from './schema.mjs';

function nowIso() {
  return new Date().toISOString();
}

function nsDir(dataDir, namespace) {
  return path.join(dataDir, 'namespaces', namespace);
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function atomicWriteFile(filePath, content) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

/**
 * Read a JSONL file tolerating a truncated/corrupt trailing line — the
 * classic crash-mid-write scenario (process killed between the write()
 * syscall landing partial bytes and the newline). Every line except
 * possibly the LAST one must still parse; a bad line anywhere else is a
 * real corruption and is reported in `corruptLines` rather than silently
 * dropped, so callers can decide whether to alarm. Returns
 * { records, corruptLines, truncatedTailDropped }.
 */
async function readJsonlTolerant(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], corruptLines: [], truncatedTailDropped: false };
    throw err;
  }

  const rawLines = raw.split('\n');
  // split('\n') on a file ending in '\n' yields a trailing '' element; that
  // is normal (not corruption). Only a non-empty last line that fails to
  // parse counts as a truncated tail.
  const hasTrailingNewline = rawLines.length > 0 && rawLines[rawLines.length - 1] === '';
  const lines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;

  const records = [];
  const corruptLines = [];
  let truncatedTailDropped = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      const isLastLine = i === lines.length - 1;
      if (isLastLine && !hasTrailingNewline) {
        // Most likely a crash mid-write: the last line never got its
        // closing newline AND doesn't parse. Drop it, keep everything else.
        truncatedTailDropped = true;
      } else {
        corruptLines.push({ lineNumber: i + 1, raw: line, error: err.message });
      }
    }
  }

  return { records, corruptLines, truncatedTailDropped };
}

async function readJsonlIfExists(filePath) {
  const { records } = await readJsonlTolerant(filePath);
  return records;
}

/**
 * A simple async mutex. One critical section at a time per Store instance.
 */
class AsyncLock {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise((resolve) => this._queue.push(resolve));
    this._locked = true;
  }

  release() {
    this._locked = false;
    const next = this._queue.shift();
    if (next) next();
  }
}

/**
 * In-memory index for one namespace: Map<block_id, claim record (latest version)>.
 * The index always reflects the latest committed state; it is patched
 * incrementally inside a transaction and only persisted (claim_index.json) at
 * commit time.
 */
class NamespaceState {
  constructor() {
    this.claimsById = new Map(); // block_id -> claim object
    this.claimLog = []; // append-only full history (for replay/audit), in-memory mirror of claims.jsonl
    this.compactions = []; // in-memory mirror of compactions.jsonl
    this.loaded = false;
    this.loadDiagnostics = null; // set by _loadNamespace: crash-recovery / index-repair report
  }
}

export class Store {
  constructor({ dataDir }) {
    if (!dataDir) throw new Error('Store requires dataDir');
    this.dataDir = dataDir;
    this._lock = new AsyncLock();
    this._ns = new Map(); // namespace -> NamespaceState
  }

  async _getState(namespace) {
    let st = this._ns.get(namespace);
    if (!st) {
      st = new NamespaceState();
      this._ns.set(namespace, st);
    }
    if (!st.loaded) {
      await this._loadNamespace(namespace, st);
      st.loaded = true;
      if (st.loadDiagnostics && st.loadDiagnostics.index_repaired_from_log) {
        // Persist the repaired index (and tail-trimmed logs) back to disk
        // immediately, so a second crash before any new write still finds a
        // consistent claim_index.json instead of repeating the repair scan
        // forever. This is a self-contained atomic rewrite, not a nested
        // transaction (we are not inside the lock here).
        await this._persistNamespace(namespace, st);
      }
    }
    return st;
  }

  /** Returns the most recent cold-load diagnostics for a namespace, or null if never loaded. */
  getLoadDiagnostics(namespace) {
    const st = this._ns.get(namespace);
    return st ? st.loadDiagnostics : null;
  }

  /**
   * Cold-load a namespace from disk. Tolerates a truncated/corrupt trailing
   * JSONL line (mid-write crash) by dropping only that line. The index
   * (claim_index.json) is treated as a pure cache: if it is missing,
   * unreadable, or its claim count disagrees with what claims.jsonl replays
   * to, we ignore it entirely and rebuild claimsById from the JSONL replay
   * instead — the log is the source of truth, the index file is never
   * trusted blindly. This guarantees a claim once durably appended to the
   * log is never lost even if the index snapshot never made it to disk.
   */
  async _loadNamespace(namespace, st) {
    const dir = nsDir(this.dataDir, namespace);
    const claimsPath = path.join(dir, 'claims.jsonl');
    const compactionsPath = path.join(dir, 'compactions.jsonl');
    const indexPath = path.join(dir, 'claim_index.json');

    const claimsResult = await readJsonlTolerant(claimsPath);
    const compactionsResult = await readJsonlTolerant(compactionsPath);

    const claimLog = claimsResult.records;
    const compactions = compactionsResult.records;
    const replayedIndex = replayClaimsById(claimLog);

    let indexRepaired = false;
    let indexLoadError = null;
    try {
      const indexRaw = await readFile(indexPath, 'utf8');
      const parsedIndex = JSON.parse(indexRaw);
      const indexCount = Array.isArray(parsedIndex.claims) ? parsedIndex.claims.length : -1;
      if (indexCount !== replayedIndex.size) {
        // Index is stale/behind (or ahead, which should never legitimately
        // happen) relative to the durable log — rebuild from the log.
        indexRepaired = true;
      }
    } catch (err) {
      // Missing or corrupt index.json: always rebuild from the log, never fail cold-load.
      indexLoadError = err.code === 'ENOENT' ? 'missing' : `corrupt: ${err.message}`;
      indexRepaired = true;
    }

    st.claimLog = claimLog;
    st.compactions = compactions;
    st.claimsById = replayedIndex; // always derived from the log, never from the cached index file
    st.loadDiagnostics = {
      namespace,
      claims_corrupt_lines: claimsResult.corruptLines,
      claims_truncated_tail_dropped: claimsResult.truncatedTailDropped,
      compactions_corrupt_lines: compactionsResult.corruptLines,
      compactions_truncated_tail_dropped: compactionsResult.truncatedTailDropped,
      index_repaired_from_log: indexRepaired,
      index_load_error: indexLoadError,
      recovered_claim_count: replayedIndex.size,
    };
  }

  /**
   * Public transaction entry point — the ONLY place that acquires the lock.
   * The callback receives a `tx` handle exposing lock-free mutation methods
   * scoped to a single namespace-aware working set. Multiple namespaces can
   * be touched in one transaction; each namespace's index + files are
   * patched in memory and flushed atomically at commit.
   */
  async transaction(fn) {
    await this._lock.acquire();
    const touched = new Set();
    const tx = this._makeTxHandle(touched);
    try {
      const result = await fn(tx);
      await this._commit(touched);
      return result;
    } finally {
      this._lock.release();
    }
  }

  _makeTxHandle(touchedSet) {
    const self = this;
    return {
      addClaim: (input) => self._txAddClaim(touchedSet, input),
      updateClaim: (blockId, patch, ledgerEntry) =>
        self._txUpdateClaim(touchedSet, blockId, patch, ledgerEntry),
      getClaim: (namespace, blockId) => self._txGetClaim(namespace, blockId),
      listClaims: (namespace, filterFn) => self._txListClaims(namespace, filterFn),
      addCompactionEvent: (namespace, event) => self._txAddCompactionEvent(touchedSet, namespace, event),
      listCompactions: (namespace) => self._txListCompactions(namespace),
      appendRegret: (namespace, eventId, regretEntry) =>
        self._txAppendRegret(touchedSet, namespace, eventId, regretEntry),
    };
  }

  // ---- lock-free internal helpers (must only run while the tx lock is held) ----

  async _ensureLoadedSync(namespace) {
    // Within a transaction, namespace state must already be resolvable.
    // We allow lazy synchronous-ish loading via a pre-await cache primed in getState.
    let st = this._ns.get(namespace);
    if (!st) {
      st = new NamespaceState();
      this._ns.set(namespace, st);
    }
    if (!st.loaded) {
      await this._loadNamespace(namespace, st);
      st.loaded = true;
    }
    return st;
  }

  async _txAddClaim(touchedSet, input) {
    const claim = buildClaim(input);
    const st = await this._ensureLoadedSync(claim.namespace);
    st.claimLog.push(claim);
    st.claimsById.set(claim.block_id, claim);
    touchedSet.add(claim.namespace);
    return claim;
  }

  _txUpdateClaim(touchedSet, blockId, patch, ledgerEntry) {
    // Synchronous by design: this is a pure in-memory patch (the lock-free
    // contract for tx.* helpers), so callers can use its return value
    // immediately without awaiting. Namespace state must already be loaded
    // by the time a transaction runs (addClaim/getClaim/listClaims load it
    // lazily beforehand); blockId may be namespaced-ambiguous only if the
    // caller mixes namespaces, so we search all loaded namespaces.
    for (const [namespace, st] of this._ns.entries()) {
      if (st.claimsById.has(blockId)) {
        const current = st.claimsById.get(blockId);
        const updated = {
          ...current,
          ...patch,
          block_id: current.block_id,
          namespace: current.namespace,
          updated_at: nowIso(),
        };
        if (ledgerEntry) {
          updated.weight_ledger = [...current.weight_ledger, ledgerEntry];
        }
        st.claimLog.push(updated);
        st.claimsById.set(blockId, updated);
        touchedSet.add(namespace);
        return updated;
      }
    }
    throw new Error(`updateClaim: block_id not found: ${blockId}`);
  }

  _txGetClaim(namespace, blockId) {
    const st = this._ns.get(namespace);
    if (!st) return null;
    return st.claimsById.get(blockId) || null;
  }

  _txListClaims(namespace, filterFn) {
    const st = this._ns.get(namespace);
    if (!st) return [];
    const all = Array.from(st.claimsById.values());
    return filterFn ? all.filter(filterFn) : all;
  }

  async _txAddCompactionEvent(touchedSet, namespace, event) {
    const st = await this._ensureLoadedSync(namespace);
    const record = { ...event, namespace, recorded_at: nowIso(), event_id: event.event_id || `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` };
    st.compactions.push(record);
    touchedSet.add(namespace);
    return record;
  }

  _txListCompactions(namespace) {
    const st = this._ns.get(namespace);
    if (!st) return [];
    return st.compactions.slice();
  }

  /**
   * Append a regret entry to an existing compaction event by event_id, inside
   * a transaction. This is the one sanctioned mutation path for compaction
   * records (they are otherwise treated as append-only log rows).
   */
  async _txAppendRegret(touchedSet, namespace, eventId, regretEntry) {
    const st = await this._ensureLoadedSync(namespace);
    const idx = st.compactions.findIndex((c) => c.event_id === eventId);
    if (idx === -1) throw new Error(`appendRegret: compaction event_id not found: ${eventId}`);
    const current = st.compactions[idx];
    const updated = { ...current, regrets: [...(current.regrets || []), regretEntry] };
    st.compactions[idx] = updated;
    touchedSet.add(namespace);
    return updated;
  }

  // ---- commit: one atomic write per touched namespace ----

  async _commit(touchedSet) {
    for (const namespace of touchedSet) {
      const st = this._ns.get(namespace);
      await this._persistNamespace(namespace, st);
    }
  }

  /** One atomic write pass (claims.jsonl + compactions.jsonl + claim_index.json) for one namespace. */
  async _persistNamespace(namespace, st) {
    const dir = nsDir(this.dataDir, namespace);
    await ensureDir(dir);
    const claimsPath = path.join(dir, 'claims.jsonl');
    const compactionsPath = path.join(dir, 'compactions.jsonl');
    const indexPath = path.join(dir, 'claim_index.json');

    const claimsContent = st.claimLog.map((c) => JSON.stringify(c)).join('\n') + (st.claimLog.length ? '\n' : '');
    const compactionsContent =
      st.compactions.map((c) => JSON.stringify(c)).join('\n') + (st.compactions.length ? '\n' : '');
    const indexContent = JSON.stringify(
      {
        namespace,
        updated_at: nowIso(),
        claims: Array.from(st.claimsById.values()),
      },
      null,
      2
    );

    await atomicWriteFile(claimsPath, claimsContent);
    await atomicWriteFile(compactionsPath, compactionsContent);
    await atomicWriteFile(indexPath, indexContent);
  }

  /**
   * Diagnostic: replay claims.jsonl + compactions.jsonl from disk for a
   * namespace and compare against the live in-memory index. Returns a
   * report; throws nothing — callers decide what to do with mismatches.
   * Does NOT hold the lock for long: it snapshots in-memory state first,
   * then reads disk, so it is safe to call between transactions.
   */
  async verifyIndexConsistency(namespace) {
    const st = this._ns.get(namespace);
    const memClaims = st ? Array.from(st.claimsById.values()) : [];
    const dir = nsDir(this.dataDir, namespace);
    const claimsPath = path.join(dir, 'claims.jsonl');
    const diskLog = await readJsonlIfExists(claimsPath);
    const replayed = replayClaimsById(diskLog);

    const mismatches = [];
    const memIds = new Set(memClaims.map((c) => c.block_id));
    const diskIds = new Set(replayed.keys());

    for (const id of memIds) {
      if (!diskIds.has(id)) {
        mismatches.push({ block_id: id, issue: 'missing_on_disk' });
        continue;
      }
      const a = st.claimsById.get(id);
      const b = replayed.get(id);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        mismatches.push({ block_id: id, issue: 'content_mismatch' });
      }
    }
    for (const id of diskIds) {
      if (!memIds.has(id)) {
        mismatches.push({ block_id: id, issue: 'missing_in_memory' });
      }
    }

    return {
      namespace,
      consistent: mismatches.length === 0,
      mem_count: memClaims.length,
      disk_count: replayed.size,
      mismatches,
    };
  }

  async listNamespaces() {
    const nsRoot = path.join(this.dataDir, 'namespaces');
    try {
      const entries = await readdir(nsRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---- public convenience wrappers (each opens its own transaction) ----

  async addClaim(input) {
    return this.transaction(async (tx) => tx.addClaim(input));
  }

  async updateClaim(blockId, patch, ledgerEntry) {
    return this.transaction(async (tx) => tx.updateClaim(blockId, patch, ledgerEntry));
  }

  async getClaim(namespace, blockId) {
    await this._getState(namespace);
    return this._txGetClaim(namespace, blockId);
  }

  async listClaims(namespace, filterFn) {
    await this._getState(namespace);
    return this._txListClaims(namespace, filterFn);
  }

  async addCompactionEvent(namespace, event) {
    return this.transaction(async (tx) => tx.addCompactionEvent(namespace, event));
  }

  async listCompactions(namespace) {
    await this._getState(namespace);
    return this._txListCompactions(namespace);
  }

  async appendRegret(namespace, eventId, regretEntry) {
    return this.transaction(async (tx) => tx.appendRegret(namespace, eventId, regretEntry));
  }

  /** Test/ops helper: wipe a namespace's on-disk + in-memory state. */
  async _wipeNamespace(namespace) {
    const dir = nsDir(this.dataDir, namespace);
    await rm(dir, { recursive: true, force: true });
    this._ns.delete(namespace);
  }
}

function replayClaimsById(claimLog) {
  const map = new Map();
  for (const c of claimLog) {
    map.set(c.block_id, c);
  }
  return map;
}

export function createStore(opts) {
  return new Store(opts);
}
