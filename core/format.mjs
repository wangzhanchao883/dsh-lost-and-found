/** 文件快速寻回 · 展示层格式化（给人看的话，不出现术语） */

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function relTime(ms, now = Date.now()) {
  if (!ms) return "时间未知";
  const d = now - ms;
  const min = Math.round(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} 个月前`;
  return `${Math.round(mon / 12)} 年前`;
}

export function absTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 中间省略的长路径 */
export function shortPath(p, max = 76) {
  const s = String(p || "");
  if (s.length <= max) return s;
  const keepTail = Math.floor(max * 0.65);
  const keepHead = max - keepTail - 3;
  return `${s.slice(0, keepHead)}...${s.slice(s.length - keepTail)}`;
}
