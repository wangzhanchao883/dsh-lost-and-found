/**
 * 文件快速寻回 · 子进程入口（扫描 + 每周校验 + 野文件巡查）
 *
 * 为什么独立进程：扫描要遍历几万个文件、还要抽文档正文（P1），
 * 放在 DSH 主进程里会拖慢界面。这里只做 IO，算完写库就退出。
 * 同一时间只允许一个实例（PID 锁文件）。
 *
 * 用法：node core/run-scan.mjs [--trigger=auto|manual|settings] [--no-patrol]
 * 运行快照来自 ~/.dsh-lost-and-found/run.json（由 host 在派生前写入）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  openDb, upsertFile, startScanRun, finishScanRun, syncRoots,
  setMeta, backupDb, counts, verifyBatch, lastScanMs, markRootScanned,
} from "../db.mjs";
import { dataDir, readRunSnapshot, ensureDataDir, resolveDbPath, DEFAULT_CONFIG, mergeDeep } from "../config.mjs";
import { scanRoots, patrolDrives } from "./scan.mjs";
import { computeSinceMs, verifyDue, rootSinceMs } from "./schedule.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

function log(msg) {
  try { process.stdout.write(`[lost-and-found] ${msg}\n`); } catch { /* ignore */ }
}

// ---------- 单实例锁 ----------
const lockPath = join(dataDir(), "scan.lock");
ensureDataDir();
try {
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // 还活着
        log(`已有扫描在进行中(pid=${pid})，本次跳过`);
        process.exit(0);
      } catch {
        rmSync(lockPath, { force: true }); // 陈旧锁
      }
    }
  }
} catch { /* ignore */ }
writeFileSync(lockPath, String(process.pid), "utf8");

let exitCode = 0;
let db = null;
let runId = null;
try {
  const snap = (args.snapshot ? JSON.parse(readFileSync(String(args.snapshot), "utf8")) : readRunSnapshot()) || {};
  const config = mergeDeep(structuredClone(DEFAULT_CONFIG), snap.config || {});
  const dbPath = snap.dbPath || resolveDbPath(config);
  const trigger = args.trigger || snap.trigger || "manual";
  const roots = Array.isArray(snap.roots) ? snap.roots : [];
  const excludes = snap.excludes || { dirs: [], patterns: [] };
  const now = Date.now();

  db = openDb(dbPath);
  syncRoots(db, roots);
  setMeta(db, "db_path", dbPath);
  runId = startScanRun(db, trigger, roots.map((r) => r.path));
  setMeta(db, "run_state", "running");
  setMeta(db, "run_started_ms", String(now));
  setMeta(db, "run_trigger", String(trigger));
  setMeta(db, "run_files", "0");

  if (!roots.length) {
    finishScanRun(db, runId, { note: "未配置扫描目录" });
    setMeta(db, "run_state", "idle");
    setMeta(db, "run_note", "还没设置要扫描的文件夹（请在设置页添加，或点「一键扫描」）");
    log("未配置扫描目录，已退出");
    rmSync(lockPath, { force: true });
    process.exit(0);
  }

  // ---- 逐目录收录起点（修「按扫描按钮却收不全」的核心）----
  // 绝不能用单一全局 sinceMs：那会让「后加入的目录」只收到全局锚点之后 6 小时的文件，
  // 该目录更早的历史文件永久漏收。这里给每个目录算它自己的起点。
  const forceFull = args.full === true || snap.forceFull === true;
  const globalSince = Number(snap.sinceMs) || 0;
  const scanList = roots.map((r) => {
    let own;
    try {
      own = rootSinceMs({ db, root: r, config, now, forceFull });
    } catch (e) {
      log(`目录锚点计算失败，退回全局窗口 ${r.path}: ${e && e.message ? e.message : e}`);
      own = globalSince || computeSinceMs(db, config, now);
    }
    return { ...r, sinceMs: own };
  });
  const sinceMs = scanList.length ? Math.min(...scanList.map((r) => Number(r.sinceMs) || 0)) : computeSinceMs(db, config, now);
  log(`开始扫描 ${scanList.length} 个文件夹（逐目录锚点${forceFull ? "｜本次强制全量" : ""}）`);
  for (const r of scanList) {
    log(`  · ${r.path} → ${r.sinceMs > 0 ? `收录 ${new Date(r.sinceMs).toLocaleString()} 之后` : "收录全部历史文件"}`);
  }

  const stats = { added: 0, updated: 0, errors: 0, skippedDirs: 0, candidates: 0 };
  let sinceFlush = 0;
  const result = await scanRoots({
    roots: scanList,
    excludes,
    sinceMs,
    logger: log,
    onCandidate(rec) {
      try {
        const r = upsertFile(db, rec);
        if (r === "added") stats.added++; else stats.updated++;
      } catch (e) {
        stats.errors++;
        log(`入库失败 ${rec.path}: ${e && e.message ? e.message : e}`);
      }
      if (++sinceFlush >= 200) {
        sinceFlush = 0;
        setMeta(db, "run_files", String(stats.added + stats.updated));
      }
    },
  });
  stats.errors += result.errors;
  stats.skippedDirs = result.skippedDirs;
  stats.candidates = result.candidates;

  // ---- 只给「真的走完」的目录推进锚点 ----
  // 中断/根目录不可读的目录保持原锚点（first_scan_done 仍为 0），下次扫描会继续补，
  // 不会再出现「扫了一半却把锚点推到最新、剩余文件永久漏收」。
  const rootsDone = [];
  const rootsSkipped = [];
  for (const r of result.roots || []) {
    if (!r.completed) {
      rootsSkipped.push(r.path);
      log(`  ! 未扫完，本次不推进锚点：${r.path}`);
      continue;
    }
    if (markRootScanned(db, r.path, now)) rootsDone.push(r.path);
  }
  log(`锚点已推进 ${rootsDone.length} 个目录${rootsSkipped.length ? `，保留 ${rootsSkipped.length} 个（未扫完）` : ""}`);

  // ---- 每周一次的存在性校验（首次扫描不校验，那时还没有旧记录） ----
  const isFirstScan = lastScanMs(db) === 0;
  if (args.verify !== "false" && !isFirstScan && verifyDue(db, now)) {
    const v = verifyBatch(db, Number(args.verifyLimit) || 800);
    log(`校验扫描：检查 ${v.checked} 个已记录文件，其中 ${v.missing} 个已不在此处`);
  }

  // ---- 野文件巡查（白名单外的新目录） ----
  if (config.patrolEnabled && args.patrol !== "false") {
    const drives = (snap.drives && snap.drives.length ? snap.drives : ["C:", "D:"]).map((d) => (d.endsWith(":") ? d + "\\" : d));
    const patrolSince = Number(snap.patrolSinceMs) || now - 86400000;
    const { suggestions, stats: pstats } = await patrolDrives({
      drives,
      excludes,
      sinceMs: patrolSince,
      coveredRoots: roots.map((r) => r.path),
      maxDepth: Number(args.patrolDepth) || 4,
      minFiles: 3,
    });
    const stmt = db.prepare(`INSERT INTO patrol (dir, files, sample, first_seen_ms, last_seen_ms, status)
      VALUES (?, ?, ?, ?, ?, 'new')
      ON CONFLICT(dir) DO UPDATE SET files = excluded.files, sample = excluded.sample,
        last_seen_ms = excluded.last_seen_ms, status = 'new'`);
    for (const s of suggestions) {
      try { stmt.run(s.dir, s.files, s.sample ?? null, now, now); } catch { /* ignore */ }
    }
    log(`野文件巡查：看了 ${pstats.scannedDirs} 个目录，发现 ${suggestions.length} 个白名单外有新文件的目录`);
  }

  finishScanRun(db, runId, {
    added: stats.added, updated: stats.updated, missing: 0,
    skippedDirs: stats.skippedDirs, errors: stats.errors,
    note: `扫描 ${result.total} 个文件，命中新增 ${result.candidates} 个；锚点推进 ${rootsDone.length} 个目录`
      + (rootsSkipped.length ? `，${rootsSkipped.length} 个未扫完` : ""),
  });
  setMeta(db, "last_scan_ms", String(Date.now()));
  setMeta(db, "run_state", "idle");
  setMeta(db, "run_note", null);
  setMeta(db, "run_files", String(stats.added + stats.updated));

  if (Number(config.backupKeep) > 0) {
    const b = backupDb(dbPath, Number(config.backupKeep));
    if (b) log(`已备份索引库到 ${b}`);
  }

  const c = counts(db);
  log(`完成：新增 ${stats.added}，更新 ${stats.updated}，库内共 ${c.total} 个文件`);
  console.log("===LAF_RUN_RESULT===");
  console.log(JSON.stringify({
    ok: true, trigger, scannedFiles: result.total, candidates: result.candidates,
    added: stats.added, updated: stats.updated, skippedDirs: stats.skippedDirs,
    errors: stats.errors, sinceMs, total: c.total, runId,
    forceFull, rootsDone, rootsSkipped, roots: result.roots || [],
  }, null, 2));
} catch (e) {
  exitCode = 1;
  const msg = e && e.stack ? e.stack : String(e);
  log(`扫描失败：${msg}`);
  try {
    if (db) {
      setMeta(db, "run_state", "error");
      setMeta(db, "run_note", msg.slice(0, 500));
      if (runId) finishScanRun(db, runId, { errors: 1, note: msg.slice(0, 300) });
    }
  } catch { /* ignore */ }
  console.log("===LAF_RUN_RESULT===");
  console.log(JSON.stringify({ ok: false, error: msg.slice(0, 500) }, null, 2));
} finally {
  try { if (db) db.close(); } catch { /* ignore */ }
  try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
}
process.exit(exitCode);
