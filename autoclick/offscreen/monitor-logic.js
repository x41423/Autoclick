export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[－﹣]/g, '-')
    .replace(/[，,]/g, ',');
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

function parseChineseNumber(s) {
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit >= 10000) {
        total += (section + num) * unit;
        section = 0;
        num = 0;
      } else {
        section += (num || 1) * unit;
        num = 0;
      }
    } else {
      return null;
    }
  }
  return total + section + num;
}

export function parseNumber(text) {
  const s = normalizeText(text);
  if (!s) return null;
  const cnMatch = s.match(/[零一二两三四五六七八九十百千万亿]+/);
  if (cnMatch) {
    const v = parseChineseNumber(cnMatch[0]);
    if (v !== null && v >= 0) return v;
  }
  const cleaned = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const m = cleaned.match(/-?(?:\d+\.?\d*|\.\d+)/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

export function checkThreshold(value, thresholds) {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    return 'normal';
  }
  const t = thresholds ?? {};
  if (t.mode === 'percent') {
    const up = (t.target ?? 0) * (t.percentUp ?? 0) / 100;
    const down = (t.target ?? 0) * (t.percentDown ?? 0) / 100;
    if (value > up) return 'high';
    if (value < down) return 'low';
    return 'normal';
  }
  if (value > t.upper) return 'high';
  if (value < t.lower) return 'low';
  return 'normal';
}

export function validateMonitorAction(action) {
  const errors = [];
  const a = action ?? {};
  const r = a.region ?? {};
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) {
    errors.push('region 必须为数字矩形');
  } else if (r.w <= 0 || r.h <= 0) {
    errors.push('region 宽高必须为正数');
  }
  if (!Number.isFinite(a.intervalSec) || a.intervalSec < 0.5) {
    errors.push('intervalSec 必须 ≥ 0.5');
  }
  const t = a.thresholds ?? {};
  if (t.mode === 'percent') {
    if (!(t.target > 0) || !(t.percentUp > 0) || !(t.percentDown > 0)) {
      errors.push('percent 模式需要 target/percentUp/percentDown 为正数');
    } else if (t.percentUp <= t.percentDown) {
      errors.push('percentUp 必须大于 percentDown');
    }
  } else if (t.mode === 'exact') {
    if (!Number.isFinite(t.upper) || !Number.isFinite(t.lower)) {
      errors.push('exact 模式需要 upper/lower 数字');
    } else if (t.upper <= t.lower) {
      errors.push('upper 必须大于 lower');
    }
  } else {
    errors.push('thresholds.mode 必须为 percent 或 exact');
  }
  if (!['notification', 'sound', 'both'].includes(a.alert?.way)) {
    errors.push('alert.way 非法');
  }
  if (!Number.isFinite(a.alert?.cooldownSec) || a.alert.cooldownSec < 0) {
    errors.push('alert.cooldownSec 必须 ≥ 0');
  }
  if (!['number', 'text'].includes(a.parse)) {
    errors.push('parse 必须为 number 或 text');
  }
  return { ok: errors.length === 0, errors };
}