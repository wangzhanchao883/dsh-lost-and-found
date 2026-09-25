/**
 * 文件快速寻回（dsh-lost-and-found）· DSH 插件主入口
 *
 * 定位：帮用户记住电脑里「新出现」的文件（名称/类型/内容大意/位置/时间），
 *       以后忘了东西存哪了，问一句就能找回来。
 * 职责边界：插件负责「记得住 + 找得快」；语义判断交给会话里的模型。
 * 只读承诺：不修改、不移动、不删除用户的任何文件。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  DEFAULT_CONFIG, POLICY, normalizeRoots, resolveDbPath, buildExcludes,
  writeRunSnapshot, dataDir,
} from "./config.mjs";
import { openDb, counts, lastScanMs, recentRuns, rootCounts, dbFileSize, forgetPaths, verifyBatch, getMeta } from "./db.mjs";
import { computeSinceMs, isDue, nextDueMs, rootSinceMs } from "./core/schedule.mjs";
import { searchFiles, liveSearch, describeQuery } from "./core/search.mjs";
import { categoryOf } from "./core/classify.mjs";
import { humanSize, relTime, absTime, shortPath } from "./core/format.mjs";

/** 把一条检索结果渲染成给人看的几行 */
function renderRow(r, idx) {
  const mark = r.exists === false ? "❌ 已不在此处" : r.exists ? "✅ 还在" : "";
  const lines = [`${idx}. 【${r.category || categoryOf(r.ext)}】${r.name}${mark ? `  ${mark}` : ""}`];
  lines.push(`   位置：${shortPath(r.path, 96)}`);
  lines.push(`   出现：${absTime(r.appeared_ms)}（${relTime(r.appeared_ms)}）｜${humanSize(r.size)}｜来源：${r.origin || "未知"}${r._live ? "｜现场找到" : ""}`);
  if (r.summary) lines.push(`   内容：${r.summary}`);
  if (r.image_desc) lines.push(`   图片：${r.image_desc}`);
  if (r.tags) lines.push(`   关键词：${r.tags}`);
  if (r._hitIn && r._hitIn.length) lines.push(`   命中：${r._hitIn.join(" / ")}`);
  if (r.snippet) lines.push(`   片段：${r.snippet}`);
  return lines;
}

export const name = "dsh-lost-and-found";
export const inject = ["tools", "commands"];

const SETTINGS_NS = "dsh-lost-and-found";
const AUTO_CHECK_THROTTLE_MS = 15 * 60 * 1000;

/**
 * 0.1.7 设置契约：插件用**纯具名导出**的 `Config` 声明可配置项，settings 服务照着它投影出表单。
 * 两条硬要求：
 *   ① 不能有 `export default` —— 剥壳后会把 `Config` 一起丢掉，条目被静默过滤；
 *   ② 每个可写字段都要标 `.volatile()`（= 「能现场改、改完不用重挂载」），否则 `volatileForm()`
 *      返回 undefined，整个条目被 `describe()` **静默过滤**（面板消失，且不报任何错）。
 * `.volatile()` 需要 schemastery >= 3.18.4；下面降级包装保证在老版本上仍能正常加载。
 */
const vol = (schema) => (typeof schema.volatile === "function" ? schema.volatile() : schema);

export const Config = z.object({
  enabled: vol(z.boolean().default(true)),
  dbPath: vol(z.string().default("")),
  intervalDays: vol(z.number().min(0).max(365).default(1)),
  firstRunWindowDays: vol(z.number().min(0).max(365).default(7)),
  /** 目录首次扫描收多久：full=全部历史（默认）/ window=最近 N 天 / none=只收今后新增 */
  firstScanMode: vol(z.string().default("full")),
  maxFileMB: vol(z.number().min(0).max(10240).default(50)),
  patrolEnabled: vol(z.boolean().default(true)),
  imageQuotaPerRun: vol(z.number().min(0).max(500).default(20)),
  backupKeep: vol(z.number().min(0).max(60).default(7)),
  roots: vol(z.array(z.object({ path: z.string(), policy: z.string().default("full") })).default([])),
  extraExcludeDirs: vol(z.array(z.string()).default([])),
  extraExcludePatterns: vol(z.array(z.string()).default([])),
});

function textTool(definition) {
  return defineTool({
    ...definition,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    presentCall: (args) => ({ card: "generic", kind: "text", title: definition.name, rawInput: args }),
  });
}

/** 把 "7d" / "24h" / "3w" / "2mo" / ISO 时间 / 毫秒时间戳 解析成 ms */
export function parseTime(input, now = Date.now()) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "number") return input > 1e12 ? input : now - input * 1000;
  const s = String(input).trim();
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(mo|[dhwmy])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const table = { d: 86400000, h: 3600000, w: 7 * 86400000, mo: 30 * 86400000, m: 30 * 86400000, y: 365 * 86400000 };
    return now - n * (table[unit] || 86400000);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function openLiveDb(config) {
  const dbPath = resolveDbPath(config);
  return { db: openDb(dbPath), dbPath };
}

function parseRunnerOutput(stdout) {
  const marker = "===LAF_RUN_RESULT===";
  const i = stdout.indexOf(marker);
  if (i < 0) return null;
  try {
    return JSON.parse(stdout.slice(i + marker.length));
  } catch {
    return null;
  }
}

export function apply(ctx, input = {}) {
  let liveConfig = { ...structuredClone(DEFAULT_CONFIG), ...(input || {}) };
  let lastAutoCheck = 0;
  let childRunning = false;

  // ---------- 设置读取（0.1.7 契约） ----------
  // 旧写法 `settings.register(ns, schema, {base})` + `scope.get()` + `scope.watch()` 在 0.1.7 已废：
  // settings 服务改为**投影** Loader 里本插件条目的 `Config`（命名空间 = patch 条目的 id，即
  // `SETTINGS_NS`），不再维护独立的值，也不再提供 watch。所以读改走 `describe()`。
  //
  // ⚠️ 0.1.7 实测更正（v0.1.3）：面板写入**不会**让宿主重新 apply 本插件 —— 写进去的值只落在
  // profile 的 `cordis.patch.yml` 上，本进程内存里的 `liveConfig` 一直是加载那一刻的旧值。
  // 后果不是「显示没跟上」这种小事，而是功能级故障：面板里刚加的扫描目录，点「立即扫描」会报
  // 「还没设置要扫描的文件夹」；改了库位置也仍然读写旧库。所以下面所有**入口**都先过 `freshConfig()`。
  let settingsService = null;

  function syncFromSettings() {
    if (!settingsService) return false;
    try {
      const row = settingsService.describe().find((it) => it && it.ns === SETTINGS_NS);
      if (!row || row.value === undefined || row.value === null) return false;
      liveConfig = { ...liveConfig, ...row.value, roots: normalizeRoots(row.value.roots) };
      return true;
    } catch (err) {
      ctx.logger.warn(`dsh-lost-and-found: 读取设置失败(继续用传入配置) - ${err.message}`);
      return false;
    }
  }

  /**
   * 取「当前最新」的配置：每次调用都重读一遍设置投影。
   * 面板改完立刻生效，不需要重启 DSH（`describe()` 读的就是刚写入的权威值，纯内存操作，成本可忽略）。
   * 所有对外入口（工具 / 斜杠命令 / 自动扫描检查）都必须先走这里，不要直接读 `liveConfig` 的闭包快照。
   */
  function freshConfig() {
    syncFromSettings();
    return liveConfig;
  }

  ctx.inject(["settings"], (settingsCtx) => {
    settingsService = settingsCtx.settings;
    freshConfig();
  });

  // ---------- 派生扫描子进程 ----------
  async function spawnScan({ trigger = "manual", wait = false, forceFull = false } = {}) {
    freshConfig();
    if (childRunning && wait) throw new Error("已有扫描在进行中");
    if (!liveConfig.enabled) throw new Error("插件已关闭（可在设置页打开）");
    const roots = normalizeRoots(liveConfig.roots);
    const excludes = buildExcludes(liveConfig);
    const dbPath = resolveDbPath(liveConfig);

    // 逐目录锚点：给每个目录算它自己的收录起点。
    // 不能用单一全局窗口——那会让「后加入的目录」只收到全局锚点之后 6 小时的文件，
    // 该目录更早的历史文件永久漏收（实测 D:\读书 570 个文件只进了 13 个）。
    let rootsWithSince = roots.map((r) => ({ ...r, sinceMs: 0 }));
    try {
      const db = openDb(dbPath);
      try {
        rootsWithSince = roots.map((r) => ({
          ...r,
          sinceMs: rootSinceMs({ db, root: r, config: liveConfig, forceFull }),
        }));
      } finally {
        db.close();
      }
    } catch { /* 库还没建起来时按全量处理，与 run-scan 的兜底一致 */ }
    const globalSince = rootsWithSince.length
      ? Math.min(...rootsWithSince.map((r) => Number(r.sinceMs) || 0))
      : Date.now();

    writeRunSnapshot({
      dbPath,
      config: {
        firstRunWindowDays: liveConfig.firstRunWindowDays,
        firstScanMode: liveConfig.firstScanMode,
        intervalDays: liveConfig.intervalDays,
        maxFileMB: liveConfig.maxFileMB,
        patrolEnabled: liveConfig.patrolEnabled,
        imageQuotaPerRun: liveConfig.imageQuotaPerRun,
        backupKeep: liveConfig.backupKeep,
      },
      roots: rootsWithSince,
      excludes: { dirs: [...excludes.dirs], patterns: excludes.patterns },
      sinceMs: globalSince,
      forceFull: !!forceFull,
      patrolSinceMs: Date.now() - 86400000,
      drives: ["C:", "D:", "E:"],
      trigger,
    });

    const runner = fileURLToPath(new URL("./core/run-scan.mjs", import.meta.url));
    const child = spawn(process.execPath, [runner, `--trigger=${trigger}`], {
      detached: !wait,
      stdio: wait ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
      cwd: dataDir(),
      env: { ...process.env, LAF_TRIGGER: trigger },
    });
    if (!wait) {
      child.unref();
      return { started: true, pid: child.pid };
    }
    childRunning = true;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    const code = await new Promise((res) => child.on("exit", (c) => res(c)));
    childRunning = false;
    return { started: true, exitCode: code, stdout: out, stderr: err, result: parseRunnerOutput(out) };
  }

  // ---------- 到期自动扫描：会话一开就检查（用户选了「每天」） ----------
  function maybeAutoScan(reason) {
    try {
      freshConfig();
      if (!liveConfig.enabled) return;
      const days = Number(liveConfig.intervalDays);
      if (!days || days <= 0) return;
      const now = Date.now();
      if (now - lastAutoCheck < AUTO_CHECK_THROTTLE_MS) return;
      lastAutoCheck = now;
      const db = openDb(resolveDbPath(liveConfig));
      const due = isDue(db, liveConfig, now);
      db.close();
      if (!due) return;
      ctx.logger.info(`dsh-lost-and-found: ${reason}，距上次扫描已超过 ${days} 天，后台开始补扫`);
      spawnScan({ trigger: "auto", wait: false }).catch((e) => ctx.logger.warn(`自动扫描派发失败:${e.message}`));
    } catch (e) {
      ctx.logger.warn(`自动扫描检查失败:${e.message}`);
    }
  }

  try {
    ctx.on("agent/session-start", () => maybeAutoScan("新会话开始"));
    ctx.on("agent/pre-step", async (payload, next) => {
      maybeAutoScan("对话中");
      return typeof next === "function" ? next() : undefined;
    }, { prepend: true });
  } catch (e) {
    ctx.logger.warn(`dsh-lost-and-found: 会话事件注册失败(自动扫描将依赖手动触发):${e.message}`);
  }

  // ---------- 工具 1：找文件（核心） ----------
  ctx.tools.register(textTool({
    name: "file_find",
    description:
      "在「文件快速寻回」的记忆库里按内容/名字/时间/类型/位置找文件。这是用户问「我那个文件放哪了」时的首选工具。" +
      "keywords 支持多个词（空格分隔，全部命中才算）；since/until 支持相对写法（7d=最近7天, 24h, 3w, 2mo）或 ISO 时间；" +
      "ext 支持逗号分隔后缀（xlsx,pdf）；folder 限定目录前缀；category 支持 文档/表格/演示/PDF/文本/图片/视频/音频/压缩包/代码等。" +
      "索引没命中时会自动对扫描目录做一次实时兜底扫描（fallback=true 默认开）。",
    parameters: {
      keywords: { type: "string", description: "关键词，空格分隔；可空（空则只按时间/类型筛选）" },
      since: { type: "string", description: "起始时间，如 7d / 24h / 3w / 2mo / 2026-09-01" },
      until: { type: "string", description: "结束时间，同上" },
      ext: { type: "string", description: "后缀过滤，逗号分隔，如 xlsx,pdf" },
      folder: { type: "string", description: "限定目录（前缀匹配），如 D:\\工作" },
      category: { type: "string", description: "类别过滤，逗号分隔，如 表格,文档" },
      origin: { type: "string", description: "来源过滤：我下载/聊天收到/工具/AI 产出/桌面/本地创建/未知" },
      limit: { type: "number", description: "返回条数，默认 15，最大 100" },
      includeMissing: { type: "boolean", description: "是否包含已不在原处的记录，默认 false" },
      includeNoise: { type: "boolean", description: "是否包含程序内部件/缓存件（默认 false，这些会淹没结果）" },
      fallback: { type: "boolean", description: "索引没命中时是否实时扫描扫描目录兜底，默认 true" },
    },
    async execute(args = {}) {
      const cfg = freshConfig();
      const roots = normalizeRoots(cfg.roots);
      const opts = {
        keywords: args.keywords,
        since: parseTime(args.since),
        until: parseTime(args.until) ?? (args.until ? null : null),
        ext: args.ext ? String(args.ext).split(/[,，\s]+/).filter(Boolean) : [],
        folder: args.folder,
        categories: args.category ? String(args.category).split(/[,，\s]+/).filter(Boolean) : [],
        origins: args.origin ? String(args.origin).split(/[,，\s]+/).filter(Boolean) : [],
        limit: args.limit,
        includeMissing: !!args.includeMissing,
        includeNoise: !!args.includeNoise,
      };
      const { db } = openLiveDb(cfg);
      let res;
      try {
        res = await searchFiles(db, opts);
      } finally {
        db.close();
      }

      const lines = [];
      const head = `搜的是：${describeQuery({ ...opts, keywords: res.query.keywords })}`;

      if (res.rows.length) {
        lines.push(`在记忆库里找到 ${res.rows.length} 个候选（按相关度排序，共匹配 ${res.candidates} 条）：`, "");
        res.rows.forEach((r, i) => lines.push(...renderRow(r, i + 1)));
        lines.push("", head);
      } else {
        lines.push(`记忆库里没有匹配（${head}）`);
      }

      // 兜底实时扫描
      const wantFallback = args.fallback !== false && res.rows.length === 0 && roots.length > 0;
      if (wantFallback) {
        lines.push("", "记忆库里没有，正在扫描目录里现场找一遍（这些文件可能还没被收录）…");
        const live = await liveSearch({
          roots, excludes: buildExcludes(cfg),
          keywords: opts.keywords, since: opts.since, until: opts.until, ext: opts.ext,
          limit: opts.limit || 15, includeNoise: opts.includeNoise,
        });
        if (live.rows.length) {
          lines.push(`现场找到 ${live.rows.length} 个（扫描了 ${live.scanned.total} 个文件）：`, "");
          live.rows.forEach((r, i) => lines.push(...renderRow(r, i + 1)));
          lines.push("", "提示：这些文件还没进入记忆库，所以只能按名字/时间找；要按内容找需要等它被扫描收录。");
        } else {
          lines.push(`现场也没找到（扫描了 ${live.scanned.total} 个文件）。`);
        }
      } else if (res.rows.length === 0 && roots.length === 0) {
        lines.push("", "提示：还没设置要扫描的文件夹，所以只能查已收录的内容。请在插件设置页里添加目录。");
      }

      // 结构化尾巴：便于模型精确取用路径
      lines.push("", "```json", JSON.stringify(
        res.rows.map((r) => ({
          path: r.path, name: r.name, category: r.category, origin: r.origin,
          size: r.size, appeared: absTime(r.appeared_ms), exists: r.exists,
          summary: r.summary || null, snippet: r.snippet || null, policy: r.policy,
        })), null, 1), "```");
      return lines.join("\n");
    },
  }));

  // ---------- 工具 2：立刻扫描一次 ----------
  ctx.tools.register(textTool({
    name: "file_index_scan",
    description:
      "立刻对已设置的文件夹做一次扫描。每个文件夹有自己的增量锚点：从未扫过的文件夹会按首扫策略回填" +
      "（默认收录该目录全部历史文件），扫过的只收上次扫描之后新出现的。默认后台跑、立即返回；" +
      "wait=true 则等它跑完并返回结果（几十秒到几分钟）；full=true 强制忽略锚点、全量重扫一遍。" +
      "用户说「扫一下/更新一下记忆」时用它。",
    parameters: {
      wait: { type: "boolean", description: "是否等扫描跑完再返回，默认 false（后台跑）" },
      full: { type: "boolean", description: "强制全量重扫（忽略已有锚点），默认 false" },
    },
    async execute(args = {}) {
      const cfg = freshConfig();
      if (!normalizeRoots(cfg.roots).length) {
        return "还没设置要扫描的文件夹。请在插件设置页点「一键扫描」或手动添加目录后再试。";
      }
      if (args.wait) {
        const r = await spawnScan({ trigger: "manual", wait: true, forceFull: !!args.full });
        if (!r.result || r.result.ok === false) {
          return `扫描失败：${r.result?.error || r.stderr || `退出码 ${r.exitCode}`}`;
        }
        const x = r.result;
        const skipped = Array.isArray(x.rootsSkipped) && x.rootsSkipped.length
          ? `· 有 ${x.rootsSkipped.length} 个目录没扫完（已保留锚点，下次会补）`
          : null;
        return [
          "扫描完成。",
          `· 看了 ${x.scannedFiles} 个文件，其中 ${x.candidates} 个符合收录条件`,
          `· 新增收录 ${x.added} 个，更新 ${x.updated} 个`,
          `· 记忆库现在共 ${x.total} 个文件`,
          skipped,
          x.errors ? `· 有 ${x.errors} 个文件没能读取（已跳过）` : null,
        ].filter(Boolean).join("\n");
      }
      await spawnScan({ trigger: "manual", wait: false, forceFull: !!args.full });
      return "已在后台开始扫描，跑完会自动写进记忆库。可以用 file_index_status 看进度。";
    },
  }));

  // ---------- 工具 3：概况 ----------
  ctx.tools.register(textTool({
    name: "file_index_status",
    description: "查看「文件快速寻回」的概况：上次扫描时间、库内文件数、扫描目录、待处理项、野文件提示、库位置与错误。",
    parameters: {},
    async execute() {
      const cfg = freshConfig();
      const dbPath = resolveDbPath(cfg);
      const { db } = openLiveDb(cfg);
      try {
        const c = counts(db);
        const last = lastScanMs(db);
        const st = getMeta(db, "run_state");
        const note = getMeta(db, "run_note");
        const runs = recentRuns(db, 3);
        const byRoot = rootCounts(db);
        const patrol = db.prepare("SELECT dir, files, sample FROM patrol WHERE status = 'new' ORDER BY files DESC LIMIT 5").all();
        const pendingImgs = db.prepare("SELECT COUNT(*) AS n FROM files WHERE category = '图片' AND policy = 'full' AND (image_desc IS NULL OR image_desc = '') AND state = 'ok'").get();

        const lines = [];
        lines.push(`状态：${cfg.enabled ? "已启用" : "已关闭"}　|　扫描间隔：${Number(cfg.intervalDays) > 0 ? `每 ${cfg.intervalDays} 天` : "仅手动"}`);
        lines.push(`上次扫描：${last ? `${absTime(last)}（${relTime(last)}）` : "还没扫描"}`);
        if (Number(cfg.intervalDays) > 0) {
          const next = nextDueMs(db, cfg);
          lines.push(`下次自动扫描：${st === "running" ? "正在扫描中…" : absTime(next)}`);
        }
        lines.push(`记忆库：${c.total} 个文件${c.missing ? `（其中 ${c.missing} 个已不在原处）` : ""}${c.noise ? `　|　程序内部件/缓存件 ${c.noise} 个（默认不参与检索）` : ""}`);
        lines.push(`待处理：${c.enrichPending} 个待读内容${c.enrichFailed ? `，${c.enrichFailed} 个读取失败` : ""}　|　待看图：${pendingImgs ? pendingImgs.n : 0} 张`);
        lines.push(`库位置：${dbPath}（${humanSize(dbFileSize(dbPath))}）`);
        lines.push("");

        const roots = normalizeRoots(cfg.roots);
        if (!roots.length) {
          lines.push("扫描目录：（还没设置，请在设置页点「一键扫描」或手动添加）");
        } else {
          lines.push(`扫描目录（${roots.length} 个）：`);
          for (const r of roots) {
            const hit = byRoot.find((b) => b.root === r.path);
            lines.push(`  · ${shortPath(r.path, 60)}　[${r.policy}]　${hit ? hit.n : 0} 个文件`);
          }
        }

        if (patrol.length) {
          lines.push("", "巡查提示：这些目录不在扫描范围里，但最近有新文件：");
          for (const p of patrol) lines.push(`  · ${shortPath(p.dir, 60)}　${p.files} 个新文件${p.sample ? `（如 ${p.sample}）` : ""}`);
        }
        if (st === "running") lines.push("", `正在扫描：已收录 ${getMeta(db, "run_files") || 0} 个…`);
        if (st === "error" && note) lines.push("", `上次扫描出错：${String(note).slice(0, 300)}`);
        if (runs.length) {
          lines.push("", "最近几轮：");
          for (const r of runs) {
            lines.push(`  · ${absTime(r.started_ms)} [${r.trigger}] 新增 ${r.added} / 更新 ${r.updated}${r.note ? ` — ${r.note}` : ""}`);
          }
        }
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  }));

  // ---------- 工具 4：打开所在文件夹 ----------
  ctx.tools.register(textTool({
    name: "file_index_open",
    description: "在文件资源管理器里定位并选中某个文件（只开窗口，不修改文件）。path 传完整路径。",
    parameters: { path: { type: "string", description: "文件完整路径" } },
    async execute(args = {}) {
      const p = String(args.path || "").trim();
      if (!p) return "请提供文件路径";
      if (!existsSync(p)) return `文件已不在此处：${p}（可能被移动或删除）`;
      const child = spawn("explorer.exe", [`/select,${p}`], { detached: true, stdio: "ignore" });
      child.unref();
      return `已在资源管理器中定位：${p}`;
    },
  }));

  // ---------- 工具 5：忘掉某些记录（只删索引，不删文件） ----------
  ctx.tools.register(textTool({
    name: "file_index_forget",
    description: "把指定的记录从记忆库里删掉（只删记忆，绝不动用户文件）。paths 传路径数组。",
    parameters: { paths: { type: "array", items: { type: "string" }, description: "要忘掉的完整路径数组" } },
    async execute(args = {}) {
      const paths = (args.paths || []).map((x) => (typeof x === "string" ? x : x && x.path)).filter(Boolean);
      if (!paths.length) return "请提供要忘掉的路径";
      const cfg = freshConfig();
      const { db } = openLiveDb(cfg);
      try {
        const n = forgetPaths(db, paths);
        return `已从记忆库删除 ${n} 条记录（用户文件未被改动）。`;
      } finally {
        db.close();
      }
    },
  }));

  // ---------- 工具 6：手动跑一次存在性校验 ----------
  ctx.tools.register(textTool({
    name: "file_index_verify",
    description: "手动检查一批已记录文件是否还在原处（用于清理「已经不在了」的记录）。",
    parameters: { limit: { type: "number", description: "本批检查条数，默认 500" } },
    async execute(args = {}) {
      const cfg = freshConfig();
      const { db } = openLiveDb(cfg);
      try {
        const r = verifyBatch(db, Number(args.limit) || 500);
        return `检查了 ${r.checked} 个文件，其中 ${r.missing} 个已不在原处（连续两次确认后才会标记）。`;
      } finally {
        db.close();
      }
    },
  }));

  // ---------- 工具 7/8：图片待描述队列（看图由会话里的模型完成） ----------
  ctx.tools.register(textTool({
    name: "file_index_pending_images",
    description:
      "取出「还没看过内容」的图片清单（供模型用 read_image 逐张看图并写描述）。返回路径+名字+时间。",
    parameters: { limit: { type: "number", description: "本次取几张，默认用配置里的看图配额" } },
    async execute(args = {}) {
      const cfg = freshConfig();
      const limit = Number(args.limit) || Number(cfg.imageQuotaPerRun) || 20;
      const { db } = openLiveDb(cfg);
      try {
        const rows = db.prepare(`
          SELECT path, name, ext, size, appeared_ms, origin FROM files
          WHERE category = '图片' AND policy = 'full' AND state = 'ok' AND noise = 0
            AND (image_desc IS NULL OR image_desc = '')
          ORDER BY appeared_ms DESC LIMIT ?`).all(limit);
        if (!rows.length) return "没有待看图的图片了。";
        const lines = [`待看图 ${rows.length} 张（看完请用 file_index_set_image_desc 写回描述）：`, ""];
        rows.forEach((r, i) => {
          lines.push(`${i + 1}. ${r.path}`);
          lines.push(`   ${absTime(r.appeared_ms)}（${relTime(r.appeared_ms)}）｜${humanSize(r.size)}｜来源：${r.origin || "未知"}`);
        });
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  }));

  ctx.tools.register(textTool({
    name: "file_index_set_image_desc",
    description:
      "把一张图片的描述与关键词写回记忆库（含图上读到的文字，如金额/姓名/单号，便于以后按内容搜到）。",
    parameters: {
      path: { type: "string", description: "图片完整路径" },
      description: { type: "string", description: "一句话描述这张图是什么" },
      tags: { type: "string", description: "关键词（空格或用逗号分隔），含图上读到的关键文字" },
    },
    async execute(args = {}) {
      const p = String(args.path || "").trim();
      if (!p) return "请提供图片路径";
      const cfg = freshConfig();
      const { db } = openLiveDb(cfg);
      try {
        const r = db.prepare("UPDATE files SET image_desc = ?, tags = ?, enrich = 'described', last_seen_ms = ? WHERE path = ?")
          .run(String(args.description || ""), String(args.tags || ""), Date.now(), p);
        return Number(r.changes) ? `已记录：${p}` : `记忆库里没有这条记录：${p}`;
      } finally {
        db.close();
      }
    },
  }));

  // ---------- 斜杠命令（供设置页按钮与用户直接输入） ----------
  if (ctx.commands) {
    ctx.commands.register({
      name: "lostfound_scan",
      description: "立刻扫描一次并返回结果（等同设置页的「立即扫描」按钮）。",
      input: { hint: "扫描一次：新目录首次扫描会回填其历史文件，其余只收新增。", images: false },
      handler: async () => {
        try {
          const roots = normalizeRoots(freshConfig().roots);
          if (!roots.length) return { kind: "error", text: "还没设置要扫描的文件夹：请在插件设置页点「一键扫描」或手动添加目录。" };
          const r = await spawnScan({ trigger: "settings", wait: true });
          if (!r.result || r.result.ok === false) {
            return { kind: "error", text: `扫描失败：${r.result?.error || r.stderr || `退出码 ${r.exitCode}`}` };
          }
          const x = r.result;
          return {
            kind: "success",
            text: [
              "**扫描完成**",
              "",
              `· 看了 ${x.scannedFiles} 个文件，其中 ${x.candidates} 个是新出现的`,
              `· 新增收录 ${x.added} 个${x.updated ? `，更新 ${x.updated} 个` : ""}`,
              `· 记忆库现在共 ${x.total} 个文件`,
              x.errors ? `· ${x.errors} 个文件读取失败（已跳过，不影响其它文件）` : null,
            ].filter(Boolean).join("\n"),
          };
        } catch (e) {
          return { kind: "error", text: `扫描失败：${e && e.message ? e.message : String(e)}` };
        }
      },
    });

    ctx.commands.register({
      name: "lostfound_status",
      description: "查看文件快速寻回的概况。",
      input: { hint: "查看上次扫描时间、库内文件数、扫描目录。", images: false },
      handler: async () => {
        try {
          const cfg = freshConfig();
          const dbPath = resolveDbPath(cfg);
          const { db } = openLiveDb(cfg);
          try {
            const c = counts(db);
            const last = lastScanMs(db);
            const roots = normalizeRoots(cfg.roots);
            return {
              kind: "success",
              text: [
                "**文件快速寻回 · 概况**",
                "",
                `· 状态：${cfg.enabled ? "已启用" : "已关闭"}｜扫描间隔：${Number(cfg.intervalDays) > 0 ? `每 ${cfg.intervalDays} 天` : "仅手动"}`,
                `· 上次扫描：${last ? `${absTime(last)}（${relTime(last)}）` : "还没扫描"}`,
                `· 记忆库：${c.total} 个文件`,
                `· 扫描目录：${roots.length ? roots.length + " 个" : "还没设置"}`,
                `· 库位置：${dbPath}（${humanSize(dbFileSize(dbPath))}）`,
              ].join("\n"),
            };
          } finally {
            db.close();
          }
        } catch (e) {
          return { kind: "error", text: `读取失败：${e && e.message ? e.message : String(e)}` };
        }
      },
    });
  }

  ctx.logger.info("dsh-lost-and-found: 文件快速寻回已加载");
}
