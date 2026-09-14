/**
 * 文件快速寻回 · 配置与默认值
 *
 * 设计要点（与用户确认过的架构一致）：
 *  - 用户配置的唯一真相来源是 DSH 设置命名空间 dsh-lost-and-found（设置页可改）。
 *  - 扫描在独立子进程里跑，子进程读不到 DSH 设置，因此 host 在派生它之前
 *    会把一份「运行快照」写到 ~/.dsh-lost-and-found/run.json。
 *  - 用户数据目录只放运行快照/日志，索引库默认在 %LOCALAPPDATA%\dsh-lost-and-found\。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 每个扫描目录的内容深度策略 */
export const POLICY = Object.freeze({
  FULL: "full",       // 记元数据 + 抽正文 + 摘要 + 看图
  SUMMARY: "summary", // 记元数据 + 摘要，不保留正文原文
  META: "meta",       // 只记元数据（文件名/类型/大小/时间/位置）
});

export const POLICY_LABEL = Object.freeze({
  [POLICY.FULL]: "完整（正文+摘要+看图）",
  [POLICY.SUMMARY]: "只摘要（不留正文原文）",
  [POLICY.META]: "只记基本信息",
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** 空 = 用默认路径 %LOCALAPPDATA%\dsh-lost-and-found\index.db */
  dbPath: "",
  /** 自动扫描间隔（天）。0 = 关闭自动扫描，只能手动扫。 */
  intervalDays: 1,
  /** 首次安装时收录「最近 N 天」的文件。仅当 firstScanMode="window" 时生效。 */
  firstRunWindowDays: 7,
  /**
   * 一个扫描目录「第一次被扫」时收多久的文件：
   *   full   = 收录该目录里的全部历史文件（默认；否则后加入的目录会大面积漏收）
   *   window = 只收最近 firstRunWindowDays 天
   *   none   = 只收今后新增
   */
  firstScanMode: "full",
  /** 单个文件超过该体积(MB)只记元数据，不抽正文 */
  maxFileMB: 50,
  /** 巡查白名单外的新目录（每天提示一次） */
  patrolEnabled: true,
  /** 每次看图配额（供「待描述图片」流程使用） */
  imageQuotaPerRun: 20,
  /** 每日备份保留份数，0 = 不备份 */
  backupKeep: 7,
  /** 扫描目录列表：[{ path, policy }] */
  roots: [],
  /** 追加的排除目录名（小写比较） */
  extraExcludeDirs: [],
  /** 追加的排除路径片段（不区分大小写包含匹配） */
  extraExcludePatterns: [],
});

/** 默认剪枝目录名：命中则整棵子树不下钻 */
export const DEFAULT_PRUNE_DIRS = [
  "node_modules", ".git", ".svn", ".hg", ".pnpm-store", ".npm", ".cache", ".codex",
  ".gradle", ".m2", ".cargo", ".rustup", ".vscode-server", ".pnpm", ".backup", ".trash",
  "appcache", "cache", "caches", "temp", "tmp", "logs", "apm_record",
  "$recycle.bin", "system volume information",
  "appdata", "windows", "winsxs", "program files", "program files (x86)", "programdata",
  "__pycache__", ".venv", "venv", "site-packages", ".next", ".nuxt", "dist", "build", "obj",
];

/** 默认排除路径片段（包含匹配，不区分大小写）：主要针对聊天软件/网盘的缓存区 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  "\\msg\\attach\\",
  "\\msg\\media\\",
  "\\filestorage\\cache\\",
  "\\filestorage\\img\\",
  "\\filestorage\\video\\",
  "\\filestorage\\favorite\\",
  "\\$recycle.bin\\",
  "\\system volume information\\",
  // re: 前缀 = 正则（不区分大小写）。聊天软件的「内部数据区」整棵剪掉：
  // 这些目录里是会话数据库与缩略图缓存，会被反复改写，对「找回文件」毫无价值。
  "re:\\\\xwechat_files\\\\[^\\\\]+\\\\(db_storage|msg\\\\attach|msg\\\\media|temp|crash|global_config|emoticon|sns|favorite|apm_record|config|log)\\\\",
  "re:\\\\(wechat files|tencent files)\\\\[^\\\\]+\\\\(filecache|image|video|favorite|config|cache)\\\\",
  "re:\\\\appdata\\\\(local|roaming)\\\\[^\\\\]+\\\\(cache|caches|temp|logs?)\\\\",
];

/** 默认跳过的文件名/后缀（临时件、系统件、会话库日志） */
export const SKIP_FILE_RE = [
  /^desktop\.ini$/i,
  /^thumbs\.db$/i,
  /^\.ds_store$/i,
  /^~\$/,
  /\.tmp$/i,
  /\.crdownload$/i,
  /\.part$/i,
  /\.partial$/i,
  /\.download$/i,
  /\.db-(wal|shm|journal)$/i,
  /\.sqlite-(wal|shm|journal)$/i,
  // 聊天/网盘的缩略图与哈希命名缓存（真正收到的原图/原文件不在此列）
  /_thumb\.(jpg|jpeg|png|webp)$/i,
  /^[0-9a-f]{16,}\.(jpg|jpeg|png|dat|mp4|webp)$/i,
];

/** 用户数据目录（运行快照、日志） */
export function dataDir() {
  return join(homedir(), ".dsh-lost-and-found");
}

export function runSnapshotPath() {
  return join(dataDir(), "run.json");
}

export function ensureDataDir() {
  mkdirSync(dataDir(), { recursive: true });
  return dataDir();
}

/** 默认索引库路径（发布版默认；不硬编码盘符） */
export function defaultDbPath() {
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(base, "dsh-lost-and-found", "index.db");
}

export function resolveDbPath(config) {
  const p = (config && config.dbPath ? String(config.dbPath) : "").trim();
  return p || defaultDbPath();
}

/** 规整扫描目录列表：去空、去重、补默认策略 */
export function normalizeRoots(roots) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(roots) ? roots : []) {
    const path = typeof raw === "string" ? raw : raw && raw.path;
    if (!path || typeof path !== "string") continue;
    const clean = path.trim().replace(/[\\/]+$/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const policy = raw && raw.policy && POLICY[String(raw.policy).toUpperCase()]
      ? raw.policy
      : (raw && Object.values(POLICY).includes(raw.policy) ? raw.policy : POLICY.FULL);
    out.push({ path: clean, policy });
  }
  return out;
}

export function writeRunSnapshot(payload) {
  ensureDataDir();
  const p = runSnapshotPath();
  writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
  return p;
}

export function readRunSnapshot() {
  try {
    const p = runSnapshotPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 递归合并（设置页回填的扁平值覆盖默认值） */
export function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null
      ? mergeDeep(out[k], v)
      : v;
  }
  return out;
}

/** 把配置里的排除规则合成为实际使用的两份清单 */
export function buildExcludes(config) {
  const dirs = new Set(DEFAULT_PRUNE_DIRS);
  for (const d of config.extraExcludeDirs || []) {
    if (d && String(d).trim()) dirs.add(String(d).trim().toLowerCase());
  }
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS];
  for (const p of config.extraExcludePatterns || []) {
    if (p && String(p).trim()) patterns.push(String(p).trim().toLowerCase());
  }
  return { dirs, patterns: patterns.map((p) => p.toLowerCase()) };
}
