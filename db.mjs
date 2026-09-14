/**
 * 文件快速寻回 · SQLite 存储层（node:sqlite，零外部原生依赖）
 *
 * 说明：
 *  - 存储用 Node 内置 node:sqlite（零外部原生依赖）。
 *  - FTS5 可用性随 Node 版本而变（实测 v22.14.0 无、QClaw 自带 v22.22.3 有），
 *    因此检索层不依赖 FTS5，统一走 LIKE + 命中位置加权。
 *  - 索引是派生数据，可随时重建；绝不在库里保存「唯一真相」以外的用户资产。
 *  - 本模块只读用户文件（stat），只写自己的库文件。
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  root           TEXT,
  name           TEXT NOT NULL,
  ext            TEXT,
  size           INTEGER DEFAULT 0,
  birth_ms       INTEGER,
  mtime_ms       INTEGER,
  atime_ms       INTEGER,
  appeared_ms    INTEGER,
  category       TEXT,
  origin         TEXT,
  policy         TEXT DEFAULT 'full',
  summary        TEXT,
  excerpt        TEXT,
  image_desc     TEXT,
  tags           TEXT,
  enrich         TEXT DEFAULT 'none',
  retry_count    INTEGER DEFAULT 0,
  state          TEXT DEFAULT 'ok',
  missing_streak INTEGER DEFAULT 0,
  hash           TEXT,
  noise          INTEGER DEFAULT 0,
  first_seen_ms  INTEGER,
  last_seen_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_appeared ON files(appeared_ms);
CREATE INDEX IF NOT EXISTS idx_files_ext      ON files(ext);
CREATE INDEX IF NOT EXISTS idx_files_root     ON files(root);
CREATE INDEX IF NOT EXISTS idx_files_name     ON files(name);
CREATE INDEX IF NOT EXISTS idx_files_queue    ON files(state, enrich);

CREATE TABLE IF NOT EXISTS scan_runs (
  id           INTEGER PRIMARY KEY,
  started_ms   INTEGER,
  finished_ms  INTEGER,
  trigger      TEXT,
  roots_json   TEXT,
  added        INTEGER DEFAULT 0,
  updated      INTEGER DEFAULT 0,
  missing      INTEGER DEFAULT 0,
  skipped_dirs INTEGER DEFAULT 0,
  errors       INTEGER DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON scan_runs(started_ms);

-- 扫描目录（与设置页同步，并保存「每个目录各自的增量锚点」）
-- 为什么锚点必须逐目录存：全局锚点会让「后加入的目录」只收到锚点之后 6 小时内的文件，
-- 该目录里更早的历史文件永远不会入库（实测 D:\读书 570 个文件只进了 13 个）。
CREATE TABLE IF NOT EXISTS roots (
  path            TEXT PRIMARY KEY,
  policy          TEXT,
  added_ms        INTEGER,
  last_scan_ms    INTEGER DEFAULT 0,  -- 该目录上次「完整扫完」的起始时刻；0 = 从未扫完
  first_scan_done INTEGER DEFAULT 0   -- 是否完成过首扫（老库升级后为 0 → 触发一次全量回填）
);

-- 白名单外的新目录巡查结果（每天提示一次）
CREATE TABLE IF NOT EXISTS patrol (
  dir           TEXT PRIMARY KEY,
  files         INTEGER DEFAULT 0,
  sample        TEXT,
  first_seen_ms INTEGER,
  last_seen_ms  INTEGER,
  status        TEXT DEFAULT 'new'
);

-- 改名/移动识别预留（P2 补逻辑，不动表结构）
CREATE TABLE IF NOT EXISTS path_history (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER,
  old_path   TEXT,
  new_path   TEXT,
  changed_ms INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  } catch {
    /* 非致命：部分环境不允许切 WAL */
  }
  db.exec(DDL);
  migrate(db);
  const cur = getMeta(db, "schema_version");
  if (cur !== String(SCHEMA_VERSION)) {
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
  }
  return db;
}

/** 轻量迁移：老库补列（索引是可重建的派生数据，迁移失败也不致命） */
function migrate(db) {
  try {
    const cols = new Set(db.prepare("PRAGMA table_info(files)").all().map((r) => r.name));
    if (!cols.has("noise")) db.exec("ALTER TABLE files ADD COLUMN noise INTEGER DEFAULT 0");
    if (!cols.has("first_seen_ms")) db.exec("ALTER TABLE files ADD COLUMN first_seen_ms INTEGER");
    if (!cols.has("last_seen_ms")) db.exec("ALTER TABLE files ADD COLUMN last_seen_ms INTEGER");
  } catch {
    /* ignore */
  }
  // roots 逐目录锚点（v3）：老库补列，补出来的默认值 0 会让下次扫描对该目录做一次全量回填
  try {
    const rcols = new Set(db.prepare("PRAGMA table_info(roots)").all().map((r) => r.name));
    if (!rcols.has("last_scan_ms")) db.exec("ALTER TABLE roots ADD COLUMN last_scan_ms INTEGER DEFAULT 0");
    if (!rcols.has("first_scan_done")) db.exec("ALTER TABLE roots ADD COLUMN first_scan_done INTEGER DEFAULT 0");
  } catch {
    /* ignore */
  }
}

export function getMeta(db, k) {
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
    return row ? row.v : null;
  } catch {
    return null;
  }
}

export function setMeta(db, k, v) {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v === null || v === undefined ? null : String(v));
}

export function lastScanMs(db) {
  const v = getMeta(db, "last_scan_ms");
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** 插入或更新一个文件记录；返回 'added' | 'updated' */
export function upsertFile(db, rec) {
  const stmt = db.prepare(`
    INSERT INTO files (path, root, name, ext, size, birth_ms, mtime_ms, atime_ms, appeared_ms,
                       category, origin, policy, state, missing_streak, noise, first_seen_ms, last_seen_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      root = excluded.root,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      atime_ms = excluded.atime_ms,
      appeared_ms = excluded.appeared_ms,
      category = excluded.category,
      origin = excluded.origin,
      policy = excluded.policy,
      noise = excluded.noise,
      state = 'ok',
      missing_streak = 0,
      last_seen_ms = excluded.last_seen_ms
  `);
  const existed = db.prepare("SELECT id FROM files WHERE path = ?").get(rec.path);
  stmt.run(
    rec.path, rec.root ?? null, rec.name, rec.ext ?? null, rec.size ?? 0,
    rec.birth_ms ?? null, rec.mtime_ms ?? null, rec.atime_ms ?? null, rec.appeared_ms ?? null,
    rec.category ?? null, rec.origin ?? null, rec.policy ?? "full", rec.noise ?? 0,
    rec.first_seen_ms ?? Date.now(), Date.now(),
  );
  return existed ? "updated" : "added";
}

export function startScanRun(db, trigger, roots) {
  const r = db.prepare("INSERT INTO scan_runs (started_ms, trigger, roots_json) VALUES (?, ?, ?)")
    .run(Date.now(), trigger ?? "manual", JSON.stringify(roots ?? []));
  return Number(r.lastInsertRowid);
}

export function finishScanRun(db, runId, stats) {
  db.prepare(`UPDATE scan_runs SET finished_ms = ?, added = ?, updated = ?, missing = ?,
              skipped_dirs = ?, errors = ?, note = ? WHERE id = ?`)
    .run(Date.now(), stats.added ?? 0, stats.updated ?? 0, stats.missing ?? 0,
      stats.skippedDirs ?? 0, stats.errors ?? 0, stats.note ?? null, runId);
}

/**
 * 同步扫描目录表。
 * 关键：绝不能整表重建——那会抹掉每个目录的增量锚点，等价于"每次都当新目录"或"永远不重扫"。
 * 这里只做两件事：补/更新配置里的目录（保留其锚点），删掉配置里已移除的目录。
 */
export function syncRoots(db, roots) {
  const list = (roots || []).filter((r) => r && r.path);
  const keep = new Set(list.map((r) => String(r.path).toLowerCase()));
  let existing = [];
  try {
    existing = db.prepare("SELECT path FROM roots").all();
  } catch {
    existing = [];
  }
  const del = db.prepare("DELETE FROM roots WHERE path = ?");
  for (const row of existing) {
    if (!keep.has(String(row.path).toLowerCase())) del.run(row.path);
  }
  const upsert = db.prepare(`
    INSERT INTO roots (path, policy, added_ms, last_scan_ms, first_scan_done)
    VALUES (?, ?, ?, 0, 0)
    ON CONFLICT(path) DO UPDATE SET policy = excluded.policy`);
  for (const r of list) upsert.run(r.path, r.policy ?? "full", Date.now());
}

/** 读某个扫描目录的锚点状态；没有该目录时返回 {last_scan_ms:0, first_scan_done:0}（视为从未扫过） */
export function rootState(db, path) {
  try {
    const row = db.prepare("SELECT last_scan_ms, first_scan_done FROM roots WHERE path = ?").get(String(path));
    return {
      last_scan_ms: row && row.last_scan_ms ? Number(row.last_scan_ms) : 0,
      first_scan_done: row && row.first_scan_done ? 1 : 0,
    };
  } catch {
    return { last_scan_ms: 0, first_scan_done: 0 };
  }
}

/** 只有「完整走完」的目录才允许推进锚点，中断/不可读的目录保持原锚点，下次继续补 */
export function markRootScanned(db, path, at = Date.now()) {
  try {
    db.prepare("UPDATE roots SET last_scan_ms = ?, first_scan_done = 1 WHERE path = ?")
      .run(Number(at) || Date.now(), String(path));
    return true;
  } catch {
    return false;
  }
}

export function counts(db) {
  const one = (sql, ...p) => {
    const row = db.prepare(sql).get(...p);
    return row ? Number(Object.values(row)[0]) : 0;
  };
  return {
    total: one("SELECT COUNT(*) FROM files"),
    missing: one("SELECT COUNT(*) FROM files WHERE state = 'missing'"),
    noise: one("SELECT COUNT(*) FROM files WHERE noise = 1"),
    enrichPending: one("SELECT COUNT(*) FROM files WHERE noise = 0 AND (enrich = 'none' OR enrich = 'text_done')"),
    enrichFailed: one("SELECT COUNT(*) FROM files WHERE enrich = 'failed'"),
  };
}

export function rootCounts(db) {
  return db.prepare("SELECT root, COUNT(*) AS n, SUM(state = 'missing') AS missing FROM files GROUP BY root ORDER BY n DESC").all();
}

/** 只删索引记录，绝不删用户文件 */
export function forgetPaths(db, paths) {
  const stmt = db.prepare("DELETE FROM files WHERE path = ?");
  let n = 0;
  for (const p of paths || []) n += Number(stmt.run(String(p)).changes || 0);
  return n;
}

/**
 * 每周校验：抽查一批已索引文件是否还在（stat）。
 * 连续 2 次不见才标 missing，避免网盘/移动盘未挂载造成误判。
 */
export function verifyBatch(db, limit = 500) {
  const rows = db.prepare("SELECT id, path FROM files WHERE state = 'ok' ORDER BY last_seen_ms ASC LIMIT ?").all(limit);
  const bump = db.prepare("UPDATE files SET missing_streak = missing_streak + 1, state = CASE WHEN missing_streak + 1 >= 2 THEN 'missing' ELSE state END WHERE id = ?");
  const touch = db.prepare("UPDATE files SET missing_streak = 0, last_seen_ms = ? WHERE id = ?");
  let checked = 0;
  let missing = 0;
  for (const row of rows) {
    checked++;
    try {
      statSync(row.path);
      touch.run(Date.now(), row.id);
    } catch {
      bump.run(row.id);
      missing++;
    }
  }
  setMeta(db, "last_verify_ms", String(Date.now()));
  return { checked, missing };
}

/** 每日备份轮转（库损坏时可回滚，索引属可重建数据，备份只为省去重新富化） */
export function backupDb(dbPath, keep = 7) {
  if (!keep || keep < 1) return null;
  if (!existsSync(dbPath)) return null;
  const dir = join(dirname(dbPath), "backup");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const target = join(dir, `index-${stamp}.db`);
  try {
    copyFileSync(dbPath, target);
  } catch {
    return null;
  }
  try {
    const olds = readdirSync(dir).filter((f) => /^index-\d{8}\.db$/.test(f)).sort();
    while (olds.length > keep) {
      const victim = olds.shift();
      try { rmSync(join(dir, victim), { force: true }); } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
  return target;
}

export function dbFileSize(dbPath) {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

export function recentRuns(db, limit = 5) {
  return db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?").all(limit);
}
