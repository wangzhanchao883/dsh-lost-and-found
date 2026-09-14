/**
 * 文件快速寻回 · 分类与来源标注
 *
 * 关于「是谁创建的文件」：Windows 不记录可信的作者信息（NTFS Owner 只反映系统账户，
 * 你这台机器上几乎所有东西都是同一账户），因此这里不做「作者判定」，
 * 而是做可判定的「来源推断」：文件是从哪类目录出现的。
 * 这是与用户确认过的口径 —— 索引「最近出现在我地盘上的新文件」。
 */

const CATEGORY_BY_EXT = new Map(Object.entries({
  // 文档
  ".doc": "文档", ".docx": "文档", ".rtf": "文档", ".odt": "文档", ".wps": "文档",
  ".md": "文本", ".txt": "文本", ".log": "文本",
  // 表格 / 演示
  ".xls": "表格", ".xlsx": "表格", ".xlsm": "表格", ".csv": "表格", ".et": "表格",
  ".ppt": "演示", ".pptx": "演示", ".pps": "演示", ".ppsx": "演示", ".dps": "演示",
  // PDF / 电子书
  ".pdf": "PDF", ".epub": "电子书", ".mobi": "电子书", ".azw3": "电子书", ".caj": "电子书",
  // 图片
  ".jpg": "图片", ".jpeg": "图片", ".png": "图片", ".gif": "图片", ".webp": "图片",
  ".bmp": "图片", ".heic": "图片", ".tif": "图片", ".tiff": "图片", ".svg": "图片",
  ".psd": "图片", ".ai": "图片", ".raw": "图片", ".cr2": "图片",
  // 音视频
  ".mp3": "音频", ".wav": "音频", ".flac": "音频", ".m4a": "音频", ".aac": "音频", ".ogg": "音频",
  ".mp4": "视频", ".mkv": "视频", ".avi": "视频", ".mov": "视频", ".wmv": "视频", ".flv": "视频", ".webm": "视频",
  // 压缩包
  ".zip": "压缩包", ".rar": "压缩包", ".7z": "压缩包", ".tar": "压缩包", ".gz": "压缩包", ".bz2": "压缩包", ".xz": "压缩包",
  // 安装包 / 程序
  ".exe": "安装包", ".msi": "安装包", ".apk": "安装包", ".dmg": "安装包", ".pkg": "安装包", ".deb": "安装包",
  ".dll": "程序", ".sys": "程序", ".so": "程序", ".bat": "脚本", ".cmd": "脚本", ".ps1": "脚本", ".sh": "脚本",
  // 代码
  ".js": "代码", ".mjs": "代码", ".cjs": "代码", ".ts": "代码", ".tsx": "代码", ".jsx": "代码",
  ".py": "代码", ".java": "代码", ".c": "代码", ".cpp": "代码", ".h": "代码", ".cs": "代码",
  ".go": "代码", ".rs": "代码", ".rb": "代码", ".php": "代码", ".html": "代码", ".css": "代码",
  ".json": "代码", ".xml": "代码", ".yml": "代码", ".yaml": "代码", ".sql": "代码", ".vue": "代码",
  // 其他
  ".ttf": "字体", ".otf": "字体", ".woff": "字体", ".woff2": "字体",
  ".db": "数据库", ".sqlite": "数据库", ".sqlite3": "数据库", ".mdb": "数据库",
  ".lnk": "快捷方式", ".url": "快捷方式", ".iso": "镜像", ".vhd": "镜像", ".vhdx": "镜像",
  ".psd1": "代码", ".canvas": "其他",
}));

export const CATEGORY_ORDER = [
  "文档", "表格", "演示", "PDF", "文本", "电子书", "图片", "视频", "音频",
  "压缩包", "代码", "脚本", "安装包", "程序", "字体", "数据库", "镜像", "快捷方式", "其他",
];

export function categoryOf(ext) {
  if (!ext) return "其他";
  return CATEGORY_BY_EXT.get(String(ext).toLowerCase()) || "其他";
}

/** 能读正文的类型（P1 内容抽取用） */
export const TEXT_EXTRACTABLE = new Set([
  "文档", "表格", "演示", "PDF", "文本", "代码", "脚本",
]);

export const ORIGIN = Object.freeze({
  DOWNLOAD: "我下载",
  CHAT: "聊天收到",
  TOOL: "工具/AI 产出",
  DESKTOP: "桌面",
  USER: "本地创建",
  UNKNOWN: "未知",
});

const ORIGIN_RULES = [
  [ORIGIN.CHAT, ["xwechat_files", "wechat", "微信", "\\qq\\", "tencent files", "\\msg\\file\\", "企业微信", "wxid_"]],
  [ORIGIN.DOWNLOAD, ["download", "下载", "baidunetdiskdownload", "softboxdownload", "hrappstoredownload", "\\tmp\\download", "浏览器下载"]],
  [ORIGIN.TOOL, ["deepseekharness", "\\.dsh\\", "错题本", "简历库", "openviking", "\\.agents\\", "dsh-plugin"]],
  [ORIGIN.DESKTOP, ["\\desktop\\", "\\桌面", "desk\\"]],
];

/** 路径 -> 来源推断（不区分大小写包含匹配） */
export function originOf(fullPath) {
  const p = String(fullPath || "").toLowerCase();
  for (const [origin, keys] of ORIGIN_RULES) {
    for (const k of keys) if (p.includes(k)) return origin;
  }
  return ORIGIN.UNKNOWN;
}

/**
 * 噪音判定：程序内部件、缓存件、无后缀的内部数据。
 * 这类文件仍然入库（保持索引诚实），但默认不参与检索 —— 否则「其他」类会淹没真正要找的东西。
 * 需要时可在 file_find 里用 includeNoise=true 显式包含。
 */
export const NOISE_EXT = new Set([
  ".node", ".ico", ".icns", ".pyc", ".pyo", ".class", ".obj", ".pdb", ".ilk", ".lib", ".exp",
  ".pak", ".bin", ".dat", ".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".db-journal",
  ".tmp", ".bak", ".extra", ".log", ".lock", ".pid", ".cache", ".etl", ".dmp",
]);

const HASH_NAME_RE = /^[0-9a-f]{16,}\./i;

export function isNoise({ ext, name } = {}) {
  const e = String(ext || "").toLowerCase();
  if (NOISE_EXT.has(e)) return 1;
  if (!e) return 1; // 无后缀：绝大多数是程序内部数据
  if (HASH_NAME_RE.test(String(name || ""))) return 1; // 哈希命名 = 缓存件
  return 0;
}
