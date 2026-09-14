/**
 * 文件快速寻回 · 检索层
 *
 * 检索策略（与用户确认过的架构一致）：
 *  1) SQL 硬过滤：时间范围 / 类型 / 目录 / 来源 / 状态
 *  2) 多关键词 LIKE 取交（中文无需分词，子串匹配天然可用）
 *  3) JS 侧命中位置加权打分：文件名 > 关键词标签 > 路径 > 摘要 > 图片描述 > 正文
 *  4) 对最终结果逐个 stat，标注「还在 / 已不在此处」
 *  5) 索引不够用时，对扫描目录做一次实时兜底扫描（不写库）
 *
 * 为什么不用 FTS5：是否可用取决于 Node 版本 —— 实测系统 node v22.14.0 报
 * `no such module: fts5`，而 DSH 运行时的 QClaw 自带 node v22.22.3 是带 FTS5 的。
 * 为在两种环境都能跑，这里不假设 FTS5 存在（将来检测到可用时可作为加速路径）。
 */
import { stat } from "node:fs/promises";
import { scanRoots } from "./scan.mjs";
import { categoryOf, originOf } from "./classify.mjs";

const LIKE_COLUMNS = ["name", "path", "tags", "summary", "image_desc", "excerpt"];

const WEIGHT = {
  name: 50,
  tags: 30,
  path: 20,
  summary: 15,
  image_desc: 10,
  excerpt: 8,
};

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function splitKeywords(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input || "")
    .split(/[\s,，、;；|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 兼容「字符串 / 逗号分隔字符串 / 数组」三种入参 */
function toArray(input) {
  if (input === undefined || input === null || input === "") return [];
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input).split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 构造 SQL 与参数 */
function buildQuery(opts) {
  const where = [];
  const params = [];
  const keywords = splitKeywords(opts.keywords);

  if (!opts.includeMissing) where.push("state = 'ok'");
  if (!opts.includeNoise) where.push("noise = 0");

  if (opts.since) { where.push("appeared_ms >= ?"); params.push(Number(opts.since)); }
  if (opts.until) { where.push("appeared_ms <= ?"); params.push(Number(opts.until)); }

  const exts = toArray(opts.ext).map((e) => e.toLowerCase()).map((e) => (e.startsWith(".") ? e : `.${e}`));
  if (exts.length) {
    where.push(`ext IN (${exts.map(() => "?").join(",")})`);
    params.push(...exts);
  }

  const cats = toArray(opts.categories);
  if (cats.length) {
    where.push(`category IN (${cats.map(() => "?").join(",")})`);
    params.push(...cats);
  }

  const origins = toArray(opts.origins);
  if (origins.length) {
    where.push(`origin IN (${origins.map(() => "?").join(",")})`);
    params.push(...origins);
  }

  if (opts.folder) {
    const f = escapeLike(String(opts.folder).replace(/[\\/]+$/, ""));
    where.push("(path LIKE ? ESCAPE '\\' OR root LIKE ? ESCAPE '\\')");
    params.push(`${f}%`, `${f}%`);
  }

  for (const kw of keywords) {
    const k = `%${escapeLike(kw)}%`;
    where.push(`(${LIKE_COLUMNS.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    for (let i = 0; i < LIKE_COLUMNS.length; i++) params.push(k);
  }

  const sql = `SELECT * FROM files ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY appeared_ms DESC LIMIT ?`;
  return { sql, params, keywords };
}

function scoreRow(row, keywords) {
  const lower = {
    name: String(row.name || "").toLowerCase(),
    path: String(row.path || "").toLowerCase(),
    tags: String(row.tags || "").toLowerCase(),
    summary: String(row.summary || "").toLowerCase(),
    image_desc: String(row.image_desc || "").toLowerCase(),
    excerpt: String(row.excerpt || "").toLowerCase(),
  };
  let score = 0;
  const hitIn = new Set();
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    for (const col of LIKE_COLUMNS) {
      if (lower[col] && lower[col].includes(k)) {
        score += WEIGHT[col];
        hitIn.add(col);
      }
    }
    if (lower.name === k) score += 80;
  }
  const age = Date.now() - (row.appeared_ms || 0);
  if (age < 7 * 86400000) score += 6;
  else if (age < 30 * 86400000) score += 3;
  return { score, hitIn: [...hitIn] };
}

function snippetOf(row, keywords) {
  for (const col of ["excerpt", "summary", "image_desc"]) {
    const text = String(row[col] || "");
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      const i = lower.indexOf(kw.toLowerCase());
      if (i >= 0) {
        const from = Math.max(0, i - 50);
        const to = Math.min(text.length, i + kw.length + 50);
        return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
      }
    }
    if (col === "excerpt") return text.replace(/\s+/g, " ").slice(0, 100);
  }
  return null;
}

/**
 * 索引检索。
 * @returns {Promise<{rows:Array, candidates:number, query:object}>}
 */
export async function searchFiles(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const candidateLimit = Math.min(Math.max(limit * 25, 300), 3000);
  const { sql, params, keywords } = buildQuery(opts);
  const rows = db.prepare(sql).all(...params, candidateLimit);

  const scored = rows.map((row) => {
    const { score, hitIn } = scoreRow(row, keywords);
    return { ...row, _score: keywords.length ? score : (row.appeared_ms || 0) / 1e10, _hitIn: hitIn };
  });
  scored.sort((a, b) => b._score - a._score);
  const top = scored.slice(0, limit);

  const out = [];
  for (const row of top) {
    let exists = null;
    try {
      const st = await stat(row.path);
      exists = st.isFile();
    } catch {
      exists = false;
    }
    out.push({ ...row, exists, snippet: snippetOf(row, keywords) });
  }
  return { rows: out, candidates: rows.length, query: { ...opts, keywords } };
}

/**
 * 实时兜底扫描：不依赖索引、不写库，直接在扫描目录里按名字/时间找。
 * 用于「索引没命中」或「找的是还没被收录的旧文件」。
 */
export async function liveSearch({ roots, excludes, keywords, since, until, ext, limit = 30, includeNoise = false, signal, logger }) {
  const kws = splitKeywords(keywords).map((s) => s.toLowerCase());
  const exts = toArray(ext).map((e) => (String(e).startsWith(".") ? String(e) : `.${e}`).toLowerCase());
  const hits = [];
  const stats = await scanRoots({
    roots,
    excludes,
    sinceMs: since || 0,
    signal,
    logger,
    onCandidate(rec) {
      if (until && rec.appeared_ms > until) return;
      if (exts.length && !exts.includes(rec.ext)) return;
      if (!includeNoise && rec.noise) return;
      if (kws.length) {
        const hay = `${rec.name} ${rec.path}`.toLowerCase();
        if (!kws.every((k) => hay.includes(k))) return;
      }
      hits.push({
        path: rec.path, name: rec.name, ext: rec.ext, size: rec.size,
        appeared_ms: rec.appeared_ms, birth_ms: rec.birth_ms, mtime_ms: rec.mtime_ms,
        category: rec.category || categoryOf(rec.ext), origin: rec.origin || originOf(rec.path),
        root: rec.root, policy: rec.policy, state: "ok", enrich: "none", noise: rec.noise || 0,
        summary: null, excerpt: null, image_desc: null, tags: null,
        _live: true, exists: true, snippet: null, _score: rec.appeared_ms / 1e10,
      });
    },
  });
  hits.sort((a, b) => b.appeared_ms - a.appeared_ms);
  return { rows: hits.slice(0, limit), scanned: stats, total: hits.length };
}

/** 把查询条件翻译成一句人话，便于在回答里说明搜了什么 */
export function describeQuery(q) {
  const bits = [];
  if (q.keywords && q.keywords.length) bits.push(`关键词「${[].concat(q.keywords).join(" ")}」`);
  if (q.since || q.until) bits.push("时间范围");
  if (q.ext && q.ext.length) bits.push(`类型 ${[].concat(q.ext).join("/")}`);
  if (q.folder) bits.push(`范围 ${q.folder}`);
  if (q.categories && q.categories.length) bits.push(`类别 ${[].concat(q.categories).join("/")}`);
  return bits.length ? bits.join(" · ") : "全部文件";
}
