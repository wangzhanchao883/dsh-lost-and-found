/* dsh-lost-and-found client bundle — Web 设置页。
 * 经典脚本形式注册到 window.__ModuleLoader__；工厂内用 require 取 React，不用 JSX。
 * 本页只负责「配置」；扫描结果与找文件都在对话里由模型驱动完成。 */
window.__ModuleLoader__.load({
  id: "dsh-lost-and-found",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = "settings.lostAndFound";
    const SETTINGS_NAMESPACE = "dsh-lost-and-found";
    // 打包版本标记：显示在按钮下方状态行里，用来一眼确认浏览器跑的是哪一版前端代码。
    const BUILD_TAG = "v5-perroot-anchor";

    const zh = {
      nav: "文件快速寻回",
      loading: "正在读取配置…",
      unavailable: "配置面板不可用（设置服务未挂载）。可直接编辑配置文件，或用对话里的 file_index_scan 工具。",
      saved: "已保存",
      error: "保存失败：",
      intro: "这是什么？\n帮你记住电脑里都放过哪些文件。以后忘了东西存哪了，直接问我一句就能找回来。\n\n它会做什么？\n定期看看你指定的几个文件夹，记下文件叫什么、是什么类型、在哪里、什么时候出现的；新加入的文件夹第一次会把已有的历史文件也收进来。图片还能让模型看一眼、记下内容。所有记录只存在你电脑上的一个小文件里，不会上传到任何地方。\n\n它不会做什么？\n不会修改、移动或删除你的任何文件。不会去看你没有指定的文件夹。\n\n怎么用？\n不用记任何命令。以后直接跟我说「我上个月收到的那份报价单在哪」，我去帮你查。",
      overview: "扫描概况",
      scanNow: "立即扫描一次",
      scanHint: "每个文件夹按各自的进度增量收录；新加入的文件夹第一次会把它已有的历史文件一并收进来。通常几秒到几十秒，结果会出现在对话里。",
      statusBtn: "查看概况",
      scanning: "扫描中…",
      scanStarted: ">>> 已发起扫描，请到当前对话查看结果。",
      done: ">>> 已完成，结果同时写入了对话：",
      noSession: ">>> 还没有对话，请先在对话里新建一个会话。",
      cmdMissing: ">>> 命令未加载（插件可能未启用）。",
      runFail: "发起失败：",
      rootsTitle: "让它看哪些文件夹",
      rootsHint: "只扫描这里列出的文件夹（以及它们的子文件夹）。系统目录、缓存、程序目录会自动跳过。",
      rootPath: "文件夹路径",
      rootPolicy: "记录深度",
      rootAdd: "添加一个文件夹",
      rootRemove: "删除",
      rootEmpty: "还没添加任何文件夹。以后想找文件，先把它常存东西的地方加进来。",
      policyFull: "完整（正文+摘要+看图）",
      policySummary: "只摘要（不留正文原文）",
      policyMeta: "只记基本信息",
      storageTitle: "记录存放在哪",
      dbPath: "记忆库文件位置",
      dbPathHint: "留空使用默认位置（在系统盘的 AppData\\Local\\dsh-lost-and-found\\index.db）。想放到别的盘就填完整路径，例如 D:\\file-index\\index.db。",
      freqTitle: "多久看一次",
      interval: "自动扫描间隔",
      freqHint: "打开 DSH 时会检查：距离上次扫描超过这个间隔，就自动补扫一次。",
      freq1: "每天（推荐）",
      freq3: "每 3 天",
      freq7: "每周",
      freq0: "关闭自动扫描（只手动扫）",
      contentTitle: "内容读取",
      contentNotice: "图片内容按批次交给模型看过之后写回描述，之后就能按画面内容搜索。文档正文抽取还在路线图里（见仓库 docs/ 的规划），当前尚未启用。设为「只记基本信息」的文件夹不会看图。",
      advanced: "高级选项",
      maxFileMB: "超过这个体积就不读内容（MB）",
      maxFileMBHint: "大文件只记名字、类型、位置和时间，避免卡顿。",
      imageQuota: "每次看图张数上限",
      imageQuotaHint: "看图片内容是分批进行的，避免一次看太多。",
      patrol: "提示白名单外的新文件",
      patrolHint: "每天提示一次：哪些没被列入的文件夹最近出现了新文件（只提示，不自动收录）。",
      backupKeep: "每日备份保留份数",
      backupKeepHint: "索引库每天自动备份一份，出错时可以回退。0 = 不备份。",
      enabled: "启用文件快速寻回",
      enabledHint: "关闭后不再自动扫描，也不再提供找文件的工具。",
    };

    const en = {
      nav: "File Recall",
      loading: "Reading configuration…",
      unavailable: "Configuration panel unavailable. Use the file_index_scan tool in chat instead.",
      saved: "Saved",
      error: "Save failed: ",
      intro: "What is this?\nIt remembers which files have appeared on your computer, so when you forget where you put something you can just ask.\n\nWhat it does\nIt periodically looks at the folders you choose and records what files are called, what type they are, where they live and when they appeared; a folder added later gets its existing files backfilled on the first scan. Images can be reviewed and described too. Everything is stored in one local file on your machine and is never uploaded.\n\nWhat it never does\nIt never modifies, moves or deletes your files. It never looks at folders you did not choose.\n\nHow to use\nNo commands to memorise. Just ask: \"where is that quotation I received last month?\"",
      overview: "Overview",
      scanNow: "Scan now",
      scanHint: "Each folder is collected on its own progress: a folder added later gets its existing files backfilled on the first scan. Takes seconds to a minute; results appear in the conversation.",
      statusBtn: "View overview",
      scanning: "Scanning…",
      scanStarted: ">>> Scan started, check the current conversation.",
      done: ">>> Done — the result was also written into the conversation:",
      noSession: ">>> No conversation yet. Create one in chat first.",
      cmdMissing: ">>> Command not loaded (plugin may be disabled).",
      runFail: "Failed to start: ",
      rootsTitle: "Folders to watch",
      rootsHint: "Only the folders listed here (and their subfolders) are watched. System, cache and program folders are skipped automatically.",
      rootPath: "Folder path",
      rootPolicy: "Detail level",
      rootAdd: "Add a folder",
      rootRemove: "Remove",
      rootEmpty: "No folders yet. Add the places where you usually save things.",
      policyFull: "Full (text + summary + images)",
      policySummary: "Summary only (no raw text)",
      policyMeta: "Metadata only",
      storageTitle: "Where records are stored",
      dbPath: "Database file",
      dbPathHint: "Leave empty for the default location under AppData\\Local\\dsh-lost-and-found\\. Or give a full path such as D:\\file-index\\index.db.",
      freqTitle: "How often to look",
      interval: "Automatic scan interval",
      freqHint: "When you open DSH it checks whether this interval has passed, and catches up if needed.",
      freq1: "Daily (recommended)",
      freq3: "Every 3 days",
      freq7: "Weekly",
      freq0: "Off (manual only)",
      contentTitle: "Reading contents",
      contentNotice: "Image contents are reviewed by the model in batches and written back as descriptions, so pictures become searchable by what they show. Extracting document text is still on the roadmap (see docs/ in the repo) and is not enabled yet. Folders set to metadata-only never have images reviewed.",
      advanced: "Advanced",
      maxFileMB: "Skip contents above this size (MB)",
      maxFileMBHint: "Large files keep only name, type, location and time.",
      imageQuota: "Images per batch",
      imageQuotaHint: "Image contents are reviewed in batches.",
      patrol: "Suggest new folders",
      patrolHint: "Once a day, point out folders outside the list that received new files (suggestion only).",
      backupKeep: "Daily backups to keep",
      backupKeepHint: "One backup per day; 0 disables backups.",
      enabled: "Enable File Recall",
      enabledHint: "When off, no automatic scanning and no find tools.",
    };

    const STYLES = [
      ".laf-config{max-width:660px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}",
      ".laf-group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2)}",
      ".laf-group h3{margin:0 0 10px;font-size:13px;font-weight:600}",
      ".laf-intro{font-size:13px;line-height:1.8;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-left:4px solid var(--dsw-alias-state-business-primary);border-radius:8px;padding:12px 14px;white-space:pre-wrap}",
      ".laf-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
      ".laf-field label{font-size:12px;font-weight:500}",
      ".laf-field input[type=text],.laf-field input[type=number],.laf-field select{height:30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:0 8px;font:inherit;font-size:13px;box-sizing:border-box;width:100%}",
      ".laf-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
      ".laf-switch{display:flex;align-items:center;gap:8px;margin-bottom:6px}",
      ".laf-switch input{accent-color:var(--dsw-alias-state-business-primary)}",
      ".laf-status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px;white-space:pre-wrap}",
      ".laf-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
      ".laf-btn{height:32px;padding:0 16px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:#fff;border-radius:6px;font:inherit;font-size:13px;cursor:pointer}",
      ".laf-btn:disabled{opacity:.6;cursor:not-allowed}",
      ".laf-btn2{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;font:inherit;font-size:12px;cursor:pointer}",
      ".laf-row{display:flex;gap:8px;align-items:flex-end;margin-bottom:8px}",
      ".laf-rootpath{flex:1 1 auto}",
      ".laf-rootpolicy{flex:0 0 190px}",
      ".laf-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
    ].join("");

    function Field({ label, hint, children }) {
      return h("div", { className: "laf-field" }, h("label", null, label), children, hint ? h("div", { className: "laf-hint" }, hint) : null);
    }

    /** 文本输入：本地即时反馈，失焦/回车才提交 */
    function TextField({ value, onCommit, placeholder }) {
      const [v, setV] = useState(value || "");
      const last = useRef(value || "");
      useEffect(() => { if ((value || "") !== last.current) { last.current = value || ""; setV(value || ""); } }, [value]);
      const commit = () => { if (v !== last.current) { last.current = v; onCommit(v); } };
      return h("input", {
        type: "text", value: v, placeholder: placeholder || "",
        onChange: (e) => setV(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === "Enter") commit(); },
      });
    }

    function RootsEditor({ roots, onCommit, t }) {
      const [list, setList] = useState(() => (Array.isArray(roots) ? roots.map((r) => ({ ...r })) : []));
      const commit = (next) => { setList(next); onCommit(next.filter((r) => String(r.path || "").trim())); };
      return h("div", null, [
        ...list.map((r, i) => h("div", { className: "laf-row", key: `r${i}` }, [
          h("div", { className: "laf-rootpath" }, h(Field, {
            label: i === 0 ? t("rootPath") : "",
            children: h(TextField, {
              value: r.path,
              placeholder: "D:\\某个文件夹",
              onCommit: (v) => commit(list.map((x, j) => (j === i ? { ...x, path: v } : x))),
            }),
          })),
          h("div", { className: "laf-rootpolicy" }, h(Field, {
            label: i === 0 ? t("rootPolicy") : "",
            children: h("select", {
              value: r.policy || "full",
              onChange: (e) => commit(list.map((x, j) => (j === i ? { ...x, policy: e.target.value } : x))),
            }, [
              h("option", { value: "full", key: "full" }, t("policyFull")),
              h("option", { value: "summary", key: "summary" }, t("policySummary")),
              h("option", { value: "meta", key: "meta" }, t("policyMeta")),
            ]),
          })),
          h("button", {
            className: "laf-btn2",
            onClick: () => commit(list.filter((_, j) => j !== i)),
          }, t("rootRemove")),
        ])),
        list.length === 0 ? h("div", { className: "laf-hint" }, t("rootEmpty")) : null,
        h("button", {
          className: "laf-btn2",
          onClick: () => setList([...list, { path: "", policy: "full" }]),
        }, t("rootAdd")),
      ]);
    }

    function ConfigSection({ scope, t, runCommand }) {
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      const [status, setStatus] = useState("");
      const [busy, setBusy] = useState("");
      const timer = useRef(null);
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      // 成功提示 2.5 秒后消失；失败/诊断信息常驻，方便用户把它读给排查的人（别一闪而过）。
      const flash = (msg, hold) => {
        setStatus(msg);
        if (timer.current) clearTimeout(timer.current);
        if (!hold) timer.current = setTimeout(() => setStatus(""), 2500);
      };
      const save = (field, v) => {
        Promise.resolve(scope.set(field, v))
          .then(() => flash(t("saved")))
          .catch((err) => flash(`${t("error")}${err && err.message ? err.message : String(err)}`, true));
      };
      const run = (cmd, mark) => {
        if (busy) return;
        setBusy(mark);
        Promise.resolve(runCommand(cmd, t))
          .then((msg) => flash(msg || "", msg !== t("scanStarted")))
          .catch((err) => flash(`${t("runFail")}${err && err.message ? err.message : String(err)}`, true))
          .finally(() => setBusy(""));
      };

      if (snap.status === "loading") return h("p", { className: "laf-status" }, t("loading"));
      if (snap.status === "unavailable") return h("p", { className: "laf-status" }, t("unavailable"));
      const v = snap.value || {};

      return h("div", { className: "laf-config" }, [
        h("div", { className: "laf-intro" }, t("intro")),

        h("div", { className: "laf-group" }, [
          h("h3", null, t("overview")),
          h("div", { className: "laf-actions" }, [
            h("button", { className: "laf-btn", disabled: !!busy, onClick: () => run("/lostfound_scan", t("scanning")) },
              busy ? t("scanning") : t("scanNow")),
            h("button", { className: "laf-btn2", disabled: !!busy, onClick: () => run("/lostfound_status", t("statusBtn")) }, t("statusBtn")),
          ]),
          h("div", { className: "laf-hint", style: { marginTop: "6px" } }, t("scanHint")),
          h("div", { className: "laf-status" }, status),
        ]),

        h("div", { className: "laf-group" }, [
          h("h3", null, t("rootsTitle")),
          h("div", { className: "laf-hint", style: { marginBottom: "10px" } }, t("rootsHint")),
          h(RootsEditor, { roots: v.roots || [], t, onCommit: (next) => save("roots", next) }),
        ]),

        h("div", { className: "laf-group" }, [
          h("h3", null, t("storageTitle")),
          Field({
            label: t("dbPath"),
            hint: t("dbPathHint"),
            children: h(TextField, { value: v.dbPath || "", placeholder: "", onCommit: (val) => save("dbPath", val) }),
          }),
        ]),

        h("div", { className: "laf-group" }, [
          h("h3", null, t("freqTitle")),
          Field({
            label: t("interval"),
            hint: t("freqHint"),
            children: h("select", {
              value: String(v.intervalDays ?? 1),
              onChange: (e) => save("intervalDays", Number(e.target.value)),
            }, [
              h("option", { value: "1", key: "1" }, t("freq1")),
              h("option", { value: "3", key: "3" }, t("freq3")),
              h("option", { value: "7", key: "7" }, t("freq7")),
              h("option", { value: "0", key: "0" }, t("freq0")),
            ]),
          }),
        ]),

        h("div", { className: "laf-group" }, [
          h("h3", null, t("contentTitle")),
          h("div", { className: "laf-note" }, t("contentNotice")),
        ]),

        h("div", { className: "laf-group" }, [
          h("h3", null, t("advanced")),
          h("div", { className: "laf-switch" }, [
            h("input", { type: "checkbox", id: "laf-enabled", checked: v.enabled !== false, onChange: (e) => save("enabled", e.target.checked) }),
            h("label", { htmlFor: "laf-enabled" }, t("enabled")),
          ]),
          h("div", { className: "laf-hint", style: { marginBottom: "10px" } }, t("enabledHint")),
          h("div", { className: "laf-switch" }, [
            h("input", { type: "checkbox", id: "laf-patrol", checked: v.patrolEnabled !== false, onChange: (e) => save("patrolEnabled", e.target.checked) }),
            h("label", { htmlFor: "laf-patrol" }, t("patrol")),
          ]),
          h("div", { className: "laf-hint", style: { marginBottom: "10px" } }, t("patrolHint")),
          Field({
            label: t("maxFileMB"),
            hint: t("maxFileMBHint"),
            children: h(TextField, { value: String(v.maxFileMB ?? 50), onCommit: (val) => save("maxFileMB", Number(val) || 0) }),
          }),
          Field({
            label: t("imageQuota"),
            hint: t("imageQuotaHint"),
            children: h(TextField, { value: String(v.imageQuotaPerRun ?? 20), onCommit: (val) => save("imageQuotaPerRun", Number(val) || 0) }),
          }),
          Field({
            label: t("backupKeep"),
            hint: t("backupKeepHint"),
            children: h(TextField, { value: String(v.backupKeep ?? 7), onCommit: (val) => save("backupKeep", Number(val) || 0) }),
          }),
        ]),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.setAttribute("data-plugin", "dsh-lost-and-found");
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
      }, "dsh-lost-and-found: styles");

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-lost-and-found: dictionaries");

      const t = ctx.locale.bind(NS);
      // 0.1.7：`ctx.settingsScope` 已被整个移除，改为 `ctx.configForms.get(条目 id)`。
      // 新 API 与旧 API 同名同义（getSnapshot / subscribe / set / unset / mutate），
      // 快照结构 `{status,value,base,user,revision,writable,mode}` 也没变，所以组件体无需改动。
      const scope = ctx.configForms.get(SETTINGS_NAMESPACE);
      // 客户端远程命名空间挂在 `remote.<namespace>` 服务上（DSH 0.1.5-rc.1 起；
      // 旧的 connection.api.* 已不存在，写它会报 reading 'sessions'）。
      // 触发斜杠命令必须走 remote.commands.execute：往会话里塞一条 "/cmd" 文本
      // 只会当成普通消息发给模型——斜杠命令的拦截在输入框那层，不在 host。
      const remote = ctx.get("remote");
      const remoteCommands = ctx.get("remote.commands") || (remote && remote.commands);
      const sessions = ctx.get("sessions");

      // 选"要发到哪个对话"：优先侧栏当前选中的会话；current 缺失（停在设置页、
      // 或选中的只是一张空白草稿）时，退回"最近更新过的非空白会话"，
      // 绝不把命令发进空白草稿——那正是 2026-09-14 结果"不见了"的原因。
      const pickTarget = () => {
        const s = (sessions.list.getSnapshot && sessions.list.getSnapshot()) || {};
        const byId = s.byId || {};
        const ids = Array.isArray(s.ids) ? s.ids : [];
        const row = (id) => byId[id] || {};
        if (s.current && !row(s.current).blank) {
          return { id: s.current, title: row(s.current).displayTitle || String(s.current).slice(0, 8) };
        }
        const rows = ids
          .map((id) => ({ id, ...row(id) }))
          .filter((r) => r.id && !r.blank && r.origin !== "subagent")
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (rows[0]) return { id: rows[0].id, title: rows[0].displayTitle || String(rows[0].id).slice(0, 8) };
        if (s.current) return { id: s.current, title: row(s.current).displayTitle || String(s.current).slice(0, 8) };
        if (ids.length) return { id: ids[ids.length - 1], title: row(ids[ids.length - 1]).displayTitle || String(ids[ids.length - 1]).slice(0, 8) };
        return { id: void 0, title: void 0 };
      };

      // 按钮 -> 让 host 执行一条斜杠命令，并等它跑完：命令结果由 host 写进会话
      // （command/run + command/done），execute 的返回值里也带着同一份结果文本，
      // 所以这里直接把报告显示在设置页——不管目标会话有没有被切到别的窗口，
      // 用户都能当场看到结果。增量扫描约 5 秒，等待是可接受的。
      const WAIT_MS = 120000;
      const runCommand = async (cmd, tr) => {
        try {
          if (!remoteCommands || typeof remoteCommands.execute !== "function") return `${tr("runFail")}remote.commands 不可用（${BUILD_TAG}）`;
          if (!sessions || !sessions.list) return `${tr("runFail")}sessions 不可用（${BUILD_TAG}）`;
          const target = pickTarget();
          if (!target.id) return `${tr("noSession")}（${BUILD_TAG}）`;
          try { if (sessions.open) sessions.open(target.id); } catch { /* 已在前台 */ }
          const where = `目标对话：${target.title}`;
          const pending = Symbol("pending");
          const outcome = await Promise.race([
            Promise.resolve(remoteCommands.execute(target.id, cmd, [])).catch((e) => ({
              ok: false,
              error: { message: e && e.message ? e.message : String(e) },
            })),
            new Promise((resolve) => setTimeout(() => resolve(pending), WAIT_MS)),
          ]);
          if (outcome === pending) return `${tr("scanStarted")}（${where}｜${BUILD_TAG}）`;
          if (outcome && outcome.ok === false) {
            return `${tr("runFail")}${outcome.error && outcome.error.message ? outcome.error.message : "未知错误"}（${where}｜${BUILD_TAG}）`;
          }
          const text = outcome && outcome.value && outcome.value.result ? outcome.value.result.text : void 0;
          if (text) return `${tr("done")}（${where}｜${BUILD_TAG}）\n${text}`;
          return `${tr("scanStarted")}（${where}｜${BUILD_TAG}）`;
        } catch (e) {
          return `${tr("runFail")}${e && e.message ? e.message : String(e)}（${BUILD_TAG}）`;
        }
      };

      const injected = () => ({ scope, runCommand });
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-lost-and-found",
        order: 215,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      }, ConfigSection));
    }

    module.exports = {
      name: "dsh-lost-and-found",
      inject: ["slots", "locale", "configForms", "remote", "remote.commands", "sessions"],
      apply,
    };
    return module.exports;
  },
});
