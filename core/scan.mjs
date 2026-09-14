/**
 * 文件快速寻回 · 扫描器（遍历 + 剪枝 + 增量）
 *
 * 铁律：
 *  - 只读。stat/readdir 之外不碰用户文件；不写 ADS、不生成缩略图、不改时间戳。
 *  - 目录级剪枝：命中排除目录名或排除路径片段，整棵子树不下钻（不是逐文件过滤）。
 *  - 不跟随符号链接/junction（避免跨盘递归与死循环，也避免把 junction 后的数据重复计数）。
 */
import { opendir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { SKIP_FILE_RE } from "../config.mjs";
import { categoryOf, originOf, isNoise } from "./classify.mjs";

const MAX_DEPTH = 40;

/** 组装剪枝判定器；patterns 里 "re:" 前缀表示正则，其余为路径片段包含匹配 */
export function makeMatcher(excludes) {
  const dirs = excludes?.dirs instanceof Set ? excludes.dirs : new Set(excludes?.dirs || []);
  const raw = (excludes?.patterns || []).map((p) => String(p));
  const plain = raw.filter((p) => !p.startsWith("re:")).map((p) => p.toLowerCase());
  const regexes = raw.filter((p) => p.startsWith("re:"))
    .map((p) => { try { return new RegExp(p.slice(3), "i"); } catch { return null; } })
    .filter(Boolean);
  return {
    pruneDir(name, fullPathLower, isRoot) {
      if (isRoot) return false;
      if (dirs.has(String(name).toLowerCase())) return true;
      for (const p of plain) if (fullPathLower.includes(p)) return true;
      for (const re of regexes) if (re.test(fullPathLower)) return true;
      return false;
    },
    skipFile(name) {
      for (const re of SKIP_FILE_RE) if (re.test(name)) return true;
      return false;
    },
  };
}

function isInside(childLower, parentLower) {
  if (!parentLower) return false;
  const a = childLower.replace(/[\\/]+$/, "");
  const b = parentLower.replace(/[\\/]+$/, "");
  if (a === b) return true;
  return a.startsWith(b + sep) || a.startsWith(b + "/");
}

/**
 * 遍历扫描目录，回调每个符合「出现时间 >= 该目录自己的 sinceMs」的文件。
 *
 * 两个关键点（都是修 BUG 的核心）：
 *  1. 每个目录带自己的 sinceMs（root.sinceMs），不再共用一个全局窗口——
 *     否则后加入的目录只能看到全局锚点之后 6 小时的文件，历史文件永久漏收。
 *  2. 逐目录回报 completed：只有真的走完的目录才允许推进锚点；
 *     被中断/根目录读不到的目录保持原锚点，下次继续补。
 *
 * @returns {{total:number, candidates:number, skippedDirs:number, errors:number, roots:Array}}
 */
export async function scanRoots({ roots, excludes, sinceMs, onCandidate, signal, logger }) {
  const m = makeMatcher(excludes);
  const stats = { total: 0, candidates: 0, skippedDirs: 0, errors: 0, roots: [] };
  for (const root of roots || []) {
    if (signal?.aborted) break;
    const own = Number(root && root.sinceMs);
    const since = Number.isFinite(own) ? own : (Number(sinceMs) || 0);
    const rs = { total: 0, candidates: 0, skippedDirs: 0, errors: 0, readable: true };
    await walk(root.path, root, 0, since, rs);
    if (signal?.aborted || !rs.readable) rs.completed = false;
    stats.total += rs.total;
    stats.candidates += rs.candidates;
    stats.skippedDirs += rs.skippedDirs;
    stats.errors += rs.errors;
    stats.roots.push({
      path: root.path, sinceMs: since, total: rs.total, candidates: rs.candidates,
      errors: rs.errors, completed: rs.completed !== false,
    });
  }
  return stats;

  async function walk(dir, root, depth, since, rs) {
    if (signal?.aborted || depth > MAX_DEPTH) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      rs.errors++;
      if (dir === root.path) rs.readable = false; // 根目录都打不开 → 不算扫完，别推进锚点
      return;
    }
    try {
      for await (const ent of handle) {
        if (signal?.aborted) return;
        const full = join(dir, ent.name);
        const lower = full.toLowerCase();
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (m.pruneDir(ent.name, lower, full === root.path)) {
            rs.skippedDirs++;
            continue;
          }
          await walk(full, root, depth + 1, since, rs);
        } else if (ent.isFile()) {
          if (m.skipFile(ent.name)) continue;
          let st;
          try {
            st = await stat(full);
          } catch {
            rs.errors++;
            continue;
          }
          rs.total++;
          const birth = st.birthtimeMs || st.mtimeMs;
          const appeared = Math.max(birth, st.mtimeMs);
          if (appeared < since) continue;
          rs.candidates++;
          const dot = ent.name.lastIndexOf(".");
          const ext = dot > 0 ? ent.name.slice(dot).toLowerCase() : "";
          onCandidate({
            path: full,
            root: root.path,
            name: ent.name,
            ext,
            size: st.size,
            birth_ms: Math.round(birth),
            mtime_ms: Math.round(st.mtimeMs),
            atime_ms: Math.round(st.atimeMs || 0),
            appeared_ms: Math.round(appeared),
            category: categoryOf(ext),
            origin: originOf(full),
            noise: isNoise({ ext, name: ent.name }),
            policy: root.policy || "full",
            first_seen_ms: Date.now(),
          });
        }
      }
    } catch (e) {
      rs.errors++;
      logger?.(`遍历出错 ${dir}: ${e && e.message ? e.message : e}`);
    }
  }
}

/**
 * 野文件巡查：在白名单之外，找出「最近有新文件出现」的目录，供用户决定是否纳入扫描。
 * 只统计不索引；限制深度以控制开销。
 */
export async function patrolDrives({ drives, excludes, sinceMs, coveredRoots, maxDepth = 4, minFiles = 3, signal }) {
  const m = makeMatcher(excludes);
  const covered = (coveredRoots || []).map((p) => String(p).toLowerCase());
  const found = new Map();
  const stats = { scannedDirs: 0, skippedDirs: 0, errors: 0 };

  for (const drive of drives) {
    if (signal?.aborted) break;
    await walk(drive, 0);
  }

  async function walk(dir, depth) {
    if (signal?.aborted || depth > maxDepth) return;
    const dirLower = dir.toLowerCase();
    if (covered.some((c) => isInside(dirLower, c))) return; // 已在白名单内，不再巡查
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      stats.errors++;
      return;
    }
    stats.scannedDirs++;
    let localCount = 0;
    let sample = null;
    try {
      for await (const ent of handle) {
        if (signal?.aborted) return;
        const full = join(dir, ent.name);
        const lower = full.toLowerCase();
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (m.pruneDir(ent.name, lower, false)) {
            stats.skippedDirs++;
            continue;
          }
          await walk(full, depth + 1);
        } else if (ent.isFile()) {
          if (m.skipFile(ent.name)) continue;
          let st;
          try {
            st = await stat(full);
          } catch {
            stats.errors++;
            continue;
          }
          const appeared = Math.max(st.birthtimeMs || st.mtimeMs, st.mtimeMs);
          if (appeared >= sinceMs) {
            localCount++;
            if (!sample) sample = ent.name;
          }
        }
      }
    } catch {
      stats.errors++;
    }
    if (localCount >= minFiles && depth > 0) {
      found.set(dir, { dir, files: localCount, sample });
    }
  }

  return { suggestions: [...found.values()].sort((a, b) => b.files - a.files), stats };
}
