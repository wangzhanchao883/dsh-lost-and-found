/** 文件快速寻回 · 排期与增量锚点 */
import { lastScanMs, getMeta, rootState } from "../db.mjs";

const DAY = 86400000;
/** 重叠窗口：防止时钟漂移/写入延迟造成边界漏收 */
const OVERLAP_MS = 6 * 3600 * 1000;

/** 本次扫描要看「从什么时候起出现」的文件（全局，仅作兼容兜底用） */
export function computeSinceMs(db, config, now = Date.now()) {
  const last = lastScanMs(db);
  if (last > 0) return Math.max(0, last - OVERLAP_MS);
  const windowDays = Number(config.firstRunWindowDays) || 0;
  return windowDays > 0 ? now - windowDays * DAY : now;
}

/**
 * 单个扫描目录的收录起点（逐目录锚点，这是修掉「按扫描按钮却收不全」的核心）。
 *
 * 为什么不能只用全局锚点：全局锚点 = 上次扫描时刻 − 6h，跟"哪个目录"无关。
 * 于是任何「后加入的目录」首扫只能看到锚点之后 6 小时的文件，它更早的历史全部漏收，
 * 而且这个漏收是永久的（下次锚点又往后推了）。实测 D:\读书 570 个文件只入库 13 个。
 *
 * @param {object} p
 * @param {object} p.db        已打开的库
 * @param {{path:string}} p.root 目录
 * @param {object} p.config    当前配置
 * @param {number} [p.now]
 * @param {boolean} [p.forceFull] 用户主动要求全量重扫
 * @returns {number} sinceMs（0 = 不限时间，全量）
 */
export function rootSinceMs({ db, root, config, now = Date.now(), forceFull = false }) {
  if (forceFull) return 0;
  const st = rootState(db, root.path);
  // 从未完整扫过（含老库升级后 first_scan_done 仍为 0）→ 按首扫策略回填
  if (!st.first_scan_done || !st.last_scan_ms) {
    const mode = String((config && config.firstScanMode) || "full").toLowerCase();
    if (mode === "none") return now;                       // 只收今后新增
    if (mode === "window") {
      const days = Number(config && config.firstRunWindowDays) || 0;
      return days > 0 ? now - days * DAY : now;
    }
    return 0;                                              // full：收录该目录全部历史
  }
  return Math.max(0, st.last_scan_ms - OVERLAP_MS);
}

/** 是否到了该自动扫描的时间 */
export function isDue(db, config, now = Date.now()) {
  const days = Number(config.intervalDays);
  if (!days || days <= 0) return false;
  const last = lastScanMs(db);
  if (!last) return true;
  return now - last >= days * DAY;
}

export function nextDueMs(db, config) {
  const days = Number(config.intervalDays);
  if (!days || days <= 0) return null;
  const last = lastScanMs(db);
  return (last || Date.now()) + days * DAY;
}

export function lastVerifyMs(db) {
  const v = getMeta(db, "last_verify_ms");
  return v ? Number(v) : 0;
}

/** 每周一次校验扫描 */
export function verifyDue(db, now = Date.now()) {
  return now - lastVerifyMs(db) >= 7 * DAY;
}
