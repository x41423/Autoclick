# OCR 区域监控（Paddle.js 离线识别）实现计划

- 日期：2026-08-21
- 规格：docs/superpowers/specs/2026-08-21-ocr-monitor-design.md（commit 5be3ba4）
- 前置提交：本地 main = 5be3ba4（spec），GitHub main = c3abff1（spec 未推送）

## 0. 硬约束（必须遵守）

- `tests/` 已 gitignore，**任何 commit 不得包含 tests/**：`git add` 只加明确路径，提交前用 `git status` 检查。
- 本地测试：`npm test`（= `node --test "tests/*.test.js"`）。
- GitHub 推送（仅此命令有效，镜像 origin 不支持 push）：
  `git -c http.proxy=http://127.0.0.1:7897 -c credential.helper="!gh auth git-credential" push https://github.com/x41423/Autoclick.git main`
- 提交风格：短中文消息；仓库本地身份已设为 x41423。
- 中文输出乱码正常（GBK 控制台），用 `-Encoding utf8` / 文件检查代替。
- 每个「里程碑」结束后才提交，提交前 `git status` + `git diff --stat` 复查。

## 验证命令速查

```powershell
npm test                      # 全量单测（43 个既有 + 新增）
node --check <file>           # 语法检查
& node_modules\.bin\esbuild.cmd --version   # esbuild 可用性
```

## 架构决策（来自 spec，实现必须对齐）

1. **monitor 动作**（非阻塞）：引擎线性执行遇到 `monitor` → 注册后台哨兵 → 立即继续下一条。哨兵独立 async 循环，与主流程并行。
2. **截屏链路**：offscreen 不能调 captureVisibleTab（MV3 限制）→ `callSW({type:'captureVisibleTab'})` → SW 截 JPEG(quality 60) 返回 dataURL。
3. **Paddle.js 单例**：offscreen 内唯一实例 + 推理队列串行（多哨兵共用，避免 WebGL 争抢）。
4. **提醒**：越界/恢复只在 `alertState` **变化**时触发；进入越界受 cooldownSec 防刷屏；恢复提醒不受冷却限制。
5. **提醒链路**：offscreen 检测 → callSW monitorAlert → SW 发系统通知 + 页面浮窗 barAlert（红灯）；声音由 offscreen Web Audio 播放。
6. **停止**：engineStop / 端口断开 / 脚本停止 → stopAll() 取消全部哨兵。
7. **错误分级**：单轮截屏/解码/推理/解析失败 → 计入 consecutiveFailures（WARN/ERROR 日志）；≥5 → 哨兵暂停 30s + ERROR 日志 + 通知；成功轮清零。
8. **数字解析**：全角→半角 → 去千分位 → 正则取首个数字（负号/小数/千分位）；中文数字（零~亿）转换；解析不出 → null（不算越界）。
9. **阈值比较**：percent: high = v > target*percentUp/100，low = v < target*percentDown/100；exact: high = v > upper，low = v < lower；null 一律不算越界。
10. **validateMonitorAction**：region w/h 为正、intervalSec ≥ 0.5、percent 模式 target>0 且 percentUp>percentDown，exact 模式 upper>lower；不合法 → ERROR 日志 + 跳过启动（不崩脚本）。
11. **text 模式**（parse:'text'）：只记录原文与展示，不做阈值比较不提醒（YAGNI，spec 未定义）。

---

## Task 1: 依赖与离线模型准备

**目标**：安装 @paddle-js-models/ocr@4.1.1 与 esbuild；下载 PP-OCRv3 det/rec 离线模型到 `autoclick/paddlejs/models/`；确认包导出 API。

**步骤 1.1 — 安装依赖**

```powershell
npm i @paddle-js-models/ocr@4.1.1
npm i -D esbuild
```

预期：package.json 增加 dependencies（@paddle-js-models/ocr）与 devDependencies（esbuild）；node_modules 就绪。

**步骤 1.2 — 确认包导出 API**

```powershell
Get-Content node_modules\@paddle-js-models\ocr\package.json
```

预期：`main`/`module` 指向 dist 文件。再读 dist 尾部找导出：

```powershell
Get-Content node_modules\@paddle-js-models\ocr\dist\ocr.js -Tail 20
```

预期（参考调研结论）：导出 `init(detPath?, recPath?)`、`recognize(image, options?, detConfig?)`（返回 `{ text: string[], points }`）、`getVersion()` 等。若实际导出名不同，以实际为准并记录到本计划。

**步骤 1.3 — 下载 det 模型**

```powershell
New-Item -ItemType Directory -Force -Path autoclick\paddlejs\models\det | Out-Null
Invoke-WebRequest -Uri "https://js-models.bj.bcebos.com/PaddleOCR/PP-OCRv3/ch_PP-OCRv3_det_infer_js_960/model.json" -OutFile autoclick\paddlejs\models\det\model.json
Get-Content autoclick\paddlejs\models\det\model.json -Raw
```

预期：model.json 含 `paths` 数组（如 `["ch_PP-OCRv3_det_infer_js_960/param.pdmodel", ...]`）或同目录相对引用。**把 paths 里每个相对文件下载到同目录**（保持 model.json 中的相对路径结构）：

```powershell
# 按实际 paths 值逐个下载，例如：
Invoke-WebRequest -Uri "https://js-models.bj.bcebos.com/PaddleOCR/PP-OCRv3/ch_PP-OCRv3_det_infer_js_960/param.pdmodel" -OutFile autoclick\paddlejs\models\det\param.pdmodel
```

**步骤 1.4 — 下载 rec 模型**（同法，目录 `autoclick\paddlejs\models\rec`，URL `https://js-models.bj.bcebos.com/PaddleOCR/PP-OCRv3/ch_PP-OCRv3_rec_infer_js/model.json`）。

**步骤 1.5 — 校验文件齐备**

```powershell
Get-ChildItem -Recurse autoclick\paddlejs\models | Select-Object FullName, Length
```

预期：det + rec 各含 model.json 与其引用的全部参数文件，总大小约 10-20MB。

**步骤 1.6 — 确认 opencv wasm 内联**（已调研：包内仅有 .js 无独立 .wasm，emscripten wasm 内联，离线可用；跳过重复检查）。

**里程碑提交**：

```powershell
git add autoclick/paddlejs package.json package-lock.json
git status   # 必须确认没有 tests/ 与 node_modules
git commit -m "1.3: OCR 离线模型与 Paddle.js 依赖"
```

注意：`node_modules/` 需在 .gitignore（若尚无，本任务追加一行并提交）。

---

## Task 2: OCR 运行时打包与 manifest 变更

**目标**：esbuild 把 @paddle-js-models/ocr 打成单个自包含 ESM 文件 `autoclick/offscreen/ocr-lib.js`；manifest 加 `notifications` 权限、CSP `wasm-unsafe-eval`、版本 1.2.0。

**步骤 2.1 — 打包入口**

新建 `autoclick/offscreen/ocr-entry.js`：

```js
export * from '@paddle-js-models/ocr';
```

**步骤 2.2 — esbuild 打包**

```powershell
& node_modules\.bin\esbuild.cmd autoclick\offscreen\ocr-entry.js --bundle --format=esm --loader:.wasm=dataurl --outfile=autoclick\offscreen\ocr-lib.js --log-level=warning
```

预期：生成 `autoclick/offscreen/ocr-lib.js`（约 1-2MB，含 opencv+core+webgl 后端+模型加载器）。语法校验：

```powershell
node --check autoclick\offscreen\ocr-lib.js
```

**步骤 2.3 — manifest.json 变更**

- `version`: `"1.1.0"` → `"1.2.0"`（同时改 package.json version 保持一致）。
- `permissions` 新增 `"notifications"`（tabs/offscreen/scripting 已有）。
- 新增（CSP 允许 wasm 实例化）：

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

校验：

```powershell
node -e "const m=require('./autoclick/manifest.json'); console.log(m.permissions, m.content_security_policy)"
```

**里程碑提交**：

```powershell
git add autoclick/offscreen/ocr-entry.js autoclick/offscreen/ocr-lib.js autoclick/manifest.json package.json
git commit -m "1.3: OCR 运行时打包（esbuild 单文件）与清单变更"
```

---

## Task 3: monitor-logic.js（纯逻辑，TDD）

**目标**：新建 `autoclick/offscreen/monitor-logic.js`，导出 `parseNumber`、`checkThreshold`、`validateMonitorAction`、`normalizeText`。全部无 DOM/chrome 依赖，Node 可直接测试。

**步骤 3.1 — 先写测试** `tests/monitor-logic.test.js`（gitignored，仅本地）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, checkThreshold, validateMonitorAction, normalizeText } from '../autoclick/offscreen/monitor-logic.js';

test('parseNumber: 整数/负数/小数/千分位/混合文本', () => {
  assert.equal(parseNumber('123'), 123);
  assert.equal(parseNumber('余额：123.45 元'), 123.45);
  assert.equal(parseNumber('-5.5'), -5.5);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('当前 12,345'), 12345);
  assert.equal(parseNumber('12.5%'), 12.5);
  assert.equal(parseNumber('进度 50%'), 50);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(''), null);
});

test('parseNumber: 全角数字', () => {
  assert.equal(parseNumber('１２３'), 123);
  assert.equal(parseNumber('１２３．４５'), 123.45);
});

test('parseNumber: 中文数字', () => {
  assert.equal(parseNumber('十二'), 12);
  assert.equal(parseNumber('一百二十三'), 123);
  assert.equal(parseNumber('一万二千三百四十五'), 12345);
  assert.equal(parseNumber('余额 一千万 元'), 10000000);
});

test('checkThreshold: percent 模式', () => {
  const t = { mode: 'percent', target: 100, percentUp: 110, percentDown: 90 };
  assert.equal(checkThreshold(111, t), 'high');
  assert.equal(checkThreshold(110, t), 'normal');   // 等于上限不算越界
  assert.equal(checkThreshold(90, t), 'normal');    // 等于下限不算越界
  assert.equal(checkThreshold(89.9, t), 'low');
  assert.equal(checkThreshold(100, t), 'normal');
});

test('checkThreshold: exact 模式', () => {
  const t = { mode: 'exact', upper: 150, lower: 50 };
  assert.equal(checkThreshold(151, t), 'high');
  assert.equal(checkThreshold(150, t), 'normal');
  assert.equal(checkThreshold(50, t), 'normal');
  assert.equal(checkThreshold(49, t), 'low');
});

test('checkThreshold: null/非法值不误报', () => {
  assert.equal(checkThreshold(null, { mode: 'exact', upper: 1, lower: 0 }), 'normal');
  assert.equal(checkThreshold(undefined, { mode: 'exact', upper: 1, lower: 0 }), 'normal');
  assert.equal(checkThreshold(NaN, { mode: 'exact', upper: 1, lower: 0 }), 'normal');
});

test('validateMonitorAction: 合法/非法', () => {
  const base = { type: 'monitor', name: 'm', region: { x: 0, y: 0, w: 100, h: 30 },
    intervalSec: 1, thresholds: { mode: 'percent', target: 100, percentUp: 110, percentDown: 90 },
    alert: { way: 'both', cooldownSec: 60 }, parse: 'number' };
  assert.deepEqual(validateMonitorAction(base).errors, []);
  assert.ok(validateMonitorAction({ ...base, intervalSec: 0.2 }).errors.length > 0);
  assert.ok(validateMonitorAction({ ...base, region: { x: 0, y: 0, w: 0, h: 30 } }).errors.length > 0);
  assert.ok(validateMonitorAction({ ...base, thresholds: { ...base.thresholds, mode: 'exact', upper: 10, lower: 20 } }).errors.length > 0);
  assert.ok(validateMonitorAction({ ...base, thresholds: { ...base.thresholds, percentUp: 80 } }).errors.length > 0);
  assert.ok(validateMonitorAction({ ...base, alert: { way: 'loud', cooldownSec: 60 } }).errors.length > 0);
});

test('normalizeText: 全角→半角', () => {
  assert.equal(normalizeText('１２３，４５６元'), '123,456元');
  assert.equal(normalizeText('－5.5'), '-5.5');
});
```

**步骤 3.2 — 实现** `autoclick/offscreen/monitor-logic.js`：

```js
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
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) num = CN_DIGITS[ch];
    else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (num === 0 && unit === 10) num = 1;          // "十二" = 12
      section += num * unit;
      num = 0;
      if (unit >= 10000) { total += section; section = 0; }
    } else return null;                                 // 含非法字符则整体失败
  }
  return total + section + num;
}

export function parseNumber(text) {
  const s = normalizeText(text);
  if (!s) return null;
  // 1) 尝试中文数字（连续汉字数词段）
  const cnMatch = s.match(/[零一二两三四五六七八九十百千万亿]+/);
  if (cnMatch) {
    const v = parseChineseNumber(cnMatch[0]);
    if (v !== null && v > 0) return v;
  }
  // 2) 去千分位后取首个数字
  const cleaned = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
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
    if (!(t.target > 0) || !(t.percentUp > 0) || !(t.percentDown > 0)) errors.push('percent 模式需要 target/percentUp/percentDown 为正数');
    else if (t.percentUp <= t.percentDown) errors.push('percentUp 必须大于 percentDown');
  } else if (t.mode === 'exact') {
    if (!Number.isFinite(t.upper) || !Number.isFinite(t.lower)) errors.push('exact 模式需要 upper/lower 数字');
    else if (t.upper <= t.lower) errors.push('upper 必须大于 lower');
  } else {
    errors.push('thresholds.mode 必须为 percent 或 exact');
  }
  if (!['notification', 'sound', 'both'].includes(a.alert?.way)) errors.push('alert.way 非法');
  if (!Number.isFinite(a.alert?.cooldownSec) || a.alert.cooldownSec < 0) errors.push('alert.cooldownSec 必须 ≥ 0');
  if (!['number', 'text'].includes(a.parse)) errors.push('parse 必须为 number 或 text');
  return { ok: errors.length === 0, errors };
}
```

**步骤 3.3 — 运行**：

```powershell
npm test
```

预期：新增测试全部通过，既有 43 个测试仍通过（输出 `# pass` 计数 ≥ 46）。

---

## Task 4: monitor.js 哨兵管理器（TDD）

**目标**：新建 `autoclick/offscreen/monitor.js`，导出 `createMonitorManager(deps)`。依赖全部注入（可测）：`captureVisibleTab()`、`loadImage(dataUrl)`、`ocrReady()`、`ocrRecognize(img)`、`parseNumber`、`checkThreshold`、`alert(kind, payload)`、`now()`、`sleep(ms)`、`log(level, msg, ctx)`、`onStatus(snapshot)`。

哨兵循环语义（对齐 spec §4.2）：

```
每轮：
  started = now()
  try:
    dataUrl = captureVisibleTab()            # 失败 {code:'CAPTURE'} → WARN
    img = loadImage(dataUrl)                 # 失败 {code:'DECODE'} → ERROR
    await ocrReady()                         # 首次才真正加载，失败抛错
    lines = ocrRecognize(img)                # 失败 {code:'INFER'} → ERROR
    rawText = lines.join('')                 # 无文本 → WARN，跳过（不清零，计入失败）
    value = parse==='text' ? rawText : parseNumber(rawText)
    if parse==='number' && value===null → WARN（含原文），计入失败，跳过比较
    否则：
      newState = checkThreshold(value, thresholds)
      状态变化才提醒：
        newState==='normal' && alertState!=='normal' → alert('recover')，lastAlertAt=now
        newState!=='normal' && alertState!==newState && now-lastAlertAt>=cooldown → alert('enter')，lastAlertAt=now
      alertState = newState
    consecutiveFailures = 0
    更新 lastValue/lastRawText/lastCheckAt；状态变化或有值变化 → onStatus(快照)
  catch e:
    consecutiveFailures++
    log（WARN/ERROR 按 e.code）
    if consecutiveFailures >= 5 → status='error'，log ERROR，alert('error')，sleep(30s)，status='active'
  wait = max(0, intervalSec*1000 - (now()-started))
  await sleep(wait)   # 动态微调防漂移
```

**步骤 4.1 — 先写测试** `tests/monitor.test.js`（用假时钟/可控 sleep）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorManager } from '../autoclick/offscreen/monitor.js';

function makeDeps(overrides = {}) {
  const calls = { capture: 0, alert: [], status: [], logs: [] };
  let value = 100;
  const deps = {
    captureVisibleTab: async () => { calls.capture++; return 'data:image/jpeg;base64,AAA'; },
    loadImage: async (d) => ({ dataUrl: d }),
    ocrReady: async () => {},
    ocrRecognize: async () => [`${value}`],
    parseNumber: (t) => (t === '' ? null : Number(t)),
    checkThreshold: (v, t) => (v > (t.upper ?? 9999) ? 'high' : v < (t.lower ?? -9999) ? 'low' : 'normal'),
    alert: (kind, p) => calls.alert.push({ kind, p }),
    now: () => deps._now,
    sleep: async (ms) => { calls.sleep = ms; },
    log: (level, msg, ctx) => calls.logs.push({ level, msg, ctx }),
    onStatus: (s) => calls.status.push(s),
    ...overrides
  };
  deps._now = 1000;
  return { deps, calls, setValue: (v) => { value = v; } };
}

const action = (overrides = {}) => ({
  type: 'monitor', name: '余额', intervalSec: 1,
  region: { x: 0, y: 0, w: 100, h: 30 },
  thresholds: { mode: 'exact', upper: 150, lower: 50 },
  alert: { way: 'both', cooldownSec: 60 },
  parse: 'number', ...overrides
});

test('哨兵: 循环读取并更新状态', async () => {
  const { deps, calls, setValue } = makeDeps();
  const m = createMonitorManager(deps);
  m.startMonitor(0, action());
  setValue(123);
  await m._tick(0);        // 手动驱动一轮（测试钩子）
  assert.equal(m.getStatus(0).lastValue, 123);
  assert.equal(m.getStatus(0).lastRawText, '123');
  assert.equal(m.getStatus(0).alertState, 'normal');
  m.stopAll();
});

test('哨兵: 越界触发提醒（状态变化才提醒）', async () => {
  const { deps, calls, setValue } = makeDeps();
  const m = createMonitorManager(deps);
  m.startMonitor(0, action({ alert: { way: 'both', cooldownSec: 0 } }));
  setValue(200);
  await m._tick(0);
  assert.equal(m.getStatus(0).alertState, 'high');
  assert.equal(calls.alert.length, 1);
  assert.equal(calls.alert[0].kind, 'enter');
  setValue(200);           // 仍越界，状态未变化 → 不再提醒
  await m._tick(0);
  assert.equal(calls.alert.length, 1);
  setValue(100);           // 恢复 → 提醒一次
  await m._tick(0);
  assert.equal(m.getStatus(0).alertState, 'normal');
  assert.equal(calls.alert.length, 2);
  assert.equal(calls.alert[1].kind, 'recover');
});

test('哨兵: 冷却期抑制再次进入越界的提醒', async () => {
  const { deps, calls, setValue } = makeDeps();
  const m = createMonitorManager(deps);
  m.startMonitor(0, action({ alert: { way: 'both', cooldownSec: 60 } }));
  setValue(200);
  await m._tick(0);
  assert.equal(calls.alert.length, 1);          // 首次进入
  setValue(100); await m._tick(0);               // 恢复
  assert.equal(calls.alert.length, 2);
  deps._now += 5000;                             // 5s 后再次越界（冷却 60s 内）
  setValue(200);
  await m._tick(0);
  assert.equal(calls.alert.length, 2);           // 被冷却抑制
  deps._now += 60000;                            // 冷却过后再次越界
  setValue(200);
  await m._tick(0);
  assert.equal(calls.alert.length, 3);           // 允许提醒
});

test('哨兵: null 值不算越界且计入解析失败', async () => {
  const { deps, calls } = makeDeps({ ocrRecognize: async () => ['无数字内容'] });
  const m = createMonitorManager(deps);
  m.startMonitor(0, action());
  await m._tick(0);
  const s = m.getStatus(0);
  assert.equal(s.lastValue, null);
  assert.equal(s.alertState, 'normal');
  assert.equal(s.consecutiveFailures, 1);
  assert.ok(calls.logs.some(l => l.level === 'WARN' && l.msg.includes('解析')));
});

test('哨兵: 截屏失败计入连续失败', async () => {
  const { deps, calls } = makeDeps({ captureVisibleTab: async () => { const e = new Error('capture fail'); e.code = 'CAPTURE'; throw e; } });
  const m = createMonitorManager(deps);
  m.startMonitor(0, action());
  await m._tick(0);
  assert.equal(m.getStatus(0).consecutiveFailures, 1);
  assert.ok(calls.logs.some(l => l.level === 'WARN'));
});

test('哨兵: 连续失败 5 次 → 暂停 30s + ERROR + 通知', async () => {
  let fail = true;
  const { deps, calls } = makeDeps({ captureVisibleTab: async () => { if (fail) { const e = new Error('x'); e.code = 'CAPTURE'; throw e; } return 'd'; } });
  const m = createMonitorManager(deps);
  m.startMonitor(0, action());
  for (let i = 0; i < 5; i++) await m._tick(0);
  assert.equal(m.getStatus(0).status, 'error');
  assert.equal(calls.sleep, 30000);
  assert.ok(calls.alert.some(a => a.kind === 'error'));
  assert.ok(calls.logs.some(l => l.level === 'ERROR'));
  fail = false;
  await m._tick(0);
  assert.equal(m.getStatus(0).consecutiveFailures, 0);
});

test('哨兵: text 模式记录原文不做比较', async () => {
  const { deps, calls } = makeDeps({ ocrRecognize: async () => ['当前余额 123.45 元'] });
  const m = createMonitorManager(deps);
  m.startMonitor(0, action({ parse: 'text' }));
  await m._tick(0);
  assert.equal(m.getStatus(0).lastValue, '当前余额 123.45 元');
  assert.equal(calls.alert.length, 0);
});

test('哨兵: 动态等待 = max(0, interval - 耗时)', async () => {
  const { deps, calls } = makeDeps();
  const m = createMonitorManager(deps);
  m.startMonitor(0, action({ intervalSec: 1 }));
  await m._tick(0);
  assert.equal(calls.sleep, 1000);
  deps._now += 300;
  await m._tick(0);
  assert.equal(calls.sleep, 700);     // 模拟本轮耗时 300ms
});

test('哨兵: 停止后不再轮询', async () => {
  const { deps, calls } = makeDeps();
  const m = createMonitorManager(deps);
  m.startMonitor(0, action());
  m.stopAll();
  await m._tick(0);
  assert.equal(calls.capture, 0);
  assert.equal(m.getStatus(0).status, 'stopped');
});
```

**步骤 4.2 — 实现** `autoclick/offscreen/monitor.js`：

```js
import { parseNumber, checkThreshold } from './monitor-logic.js';

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_MS = 30000;

export function createMonitorManager(deps) {
  const monitors = new Map();
  let seq = 0;

  function log(level, message, ctx = {}) {
    try { deps.log(level, message, ctx); } catch { /* 日志自身失败不阻断 */ }
  }

  function snapshot(m) {
    return {
      id: m.id, name: m.action.name, actionIndex: m.actionIndex,
      status: m.status, lastValue: m.lastValue, lastRawText: m.lastRawText,
      lastCheckAt: m.lastCheckAt, lastAlertAt: m.lastAlertAt,
      alertState: m.alertState, consecutiveFailures: m.consecutiveFailures
    };
  }

  async function sentinelLoop(m) {
    const { action } = m;
    m.status = 'active';
    log('INFO', `哨兵启动 ${m.id}（${action.name ?? ''}，间隔 ${action.intervalSec}s，区域 ${JSON.stringify(action.region)}）`, { id: m.id, actionIndex: m.actionIndex });
    while (!m.stopped) {
      const started = deps.now();
      try {
        const dataUrl = await deps.captureVisibleTab();
        const img = await deps.loadImage(dataUrl);
        await deps.ocrReady();
        const lines = await deps.ocrRecognize(img);
        const rawText = lines.join('');
        let value;
        if (action.parse === 'text') {
          value = rawText;
          m.lastValue = value;
          m.lastRawText = rawText;
          m.lastCheckAt = deps.now();
        } else {
          value = parseNumber(rawText);
          m.lastRawText = rawText;
          m.lastCheckAt = deps.now();
          if (value === null) {
            log('WARN', `解析失败（原文：${rawText || '<空>'}），本轮跳过比较`, { id: m.id, actionIndex: m.actionIndex });
            m.consecutiveFailures++;
            continue;
          }
          m.lastValue = value;
          const newState = checkThreshold(value, action.thresholds);
          const now = deps.now();
          if (newState !== m.alertState) {
            if (newState === 'normal') {
              deps.alert('recover', { id: m.id, name: action.name, value, rawText, message: `${action.name ?? '监控'}已恢复正常（${value}）` });
              m.lastAlertAt = now;
              log('INFO', `恢复提醒 ${action.name}：${value}`, { id: m.id, actionIndex: m.actionIndex });
            } else if (now - m.lastAlertAt >= action.alert.cooldownSec * 1000) {
              deps.alert('enter', { id: m.id, name: action.name, value, rawText, state: newState, message: `${action.name ?? '监控'}${newState === 'high' ? '高于上限' : '低于下限'}（${value}）` });
              m.lastAlertAt = now;
              log('WARN', `越界提醒 ${action.name}：${value}（${newState === 'high' ? '高' : '低'}）`, { id: m.id, actionIndex: m.actionIndex });
            }
            m.alertState = newState;
          }
        }
        m.consecutiveFailures = 0;
        m.status = 'active';
        log('INFO', `检查完成 ${action.name}：值=${m.lastValue} 原文=${m.lastRawText} 状态=${m.alertState}`, { id: m.id, actionIndex: m.actionIndex });
      } catch (err) {
        m.consecutiveFailures++;
        const level = err?.code === 'CAPTURE' ? 'WARN' : 'ERROR';
        log(level, `本轮失败（${err?.code ?? err?.message ?? err}）：${err?.stack ?? ''}`, { id: m.id, actionIndex: m.actionIndex });
        if (m.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          m.status = 'error';
          log('ERROR', `连续失败 ${m.consecutiveFailures} 次，哨兵暂停 ${BACKOFF_MS / 1000}s`, { id: m.id, actionIndex: m.actionIndex });
          deps.alert('error', { id: m.id, name: action.name, message: `${action.name ?? '监控'}连续失败，已暂停 30 秒` });
          if (!m.stopped) await deps.sleep(BACKOFF_MS);
          m.status = 'active';
        }
      }
      const elapsed = deps.now() - started;
      const wait = Math.max(0, action.intervalSec * 1000 - elapsed);
      if (!m.stopped) await deps.sleep(wait);
    }
    m.status = 'stopped';
    log('INFO', `哨兵停止 ${m.id}`, { id: m.id, actionIndex: m.actionIndex });
  }

  return {
    startMonitor(actionIndex, action) {
      const id = `monitor_${seq++}`;
      const m = {
        id, actionIndex, action,
        status: 'waiting', lastValue: null, lastRawText: '',
        lastCheckAt: 0, lastAlertAt: 0, alertState: 'normal',
        consecutiveFailures: 0, stopped: false
      };
      monitors.set(id, m);
      sentinelLoop(m);
      return id;
    },
    stopAll() {
      for (const m of monitors.values()) m.stopped = true;
    },
    getStatus(index) {
      const found = [...monitors.values()].find(m => m.actionIndex === index);
      return found ? snapshot(found) : null;
    },
    allStatus() {
      return [...monitors.values()].map(snapshot);
    },
    isActive() {
      return [...monitors.values()].some(m => !m.stopped);
    },
    _tick(index) {
      // 测试钩子：同步驱动指定哨兵完成一轮（生产不使用）
      return Promise.resolve();
    }
  };
}
```

> 测试钩子说明：为了可测试，sentinelLoop 依赖 `deps.sleep` 在测试里是"记录即返回"，`_tick` 仅用于把循环推进一轮——测试中循环在第一轮 await sleep 后自然返回。若实现中发现该钩子不够，改为暴露 `_advance`：把 `while` 改为 `while (!m.stopped && !m._paused)` 配合 `m._tickResolve`，在计划执行时以「测试通过」为准调整内部结构（测试不暴露内部细节）。

**步骤 4.3 — 运行**：

```powershell
npm test
```

预期：monitor 测试全部通过；既有测试不回归。若 `_tick` 方案不能驱动循环，按测试结果重构哨兵循环为「每轮一个可等待的 `step()` 函数 + 循环调度」的结构（保持对外 API 不变）。

**里程碑提交**：

```powershell
git add autoclick/offscreen/monitor-logic.js autoclick/offscreen/monitor.js
git commit -m "1.3: 监控哨兵核心逻辑（解析/阈值/冷却/退避）"
```

---

## Task 5: engine.js 支持 monitor 动作（TDD 扩展）

**步骤 5.1 — 读现状**：

```powershell
Get-Content autoclick\offscreen\engine.js
Get-Content tests\engine.test.js
```

**步骤 5.2 — 改 `engine.js`**：在动作分发处（现有 `switch/if` 链，runEngine 内约第 49 行起）增加：

```js
} else if (action.type === 'monitor') {
  if (deps.startMonitor) {
    await deps.startMonitor(i, action);   // 非阻塞：内部立即返回
  } else {
    log('WARN', `引擎未注入 startMonitor，跳过监控动作 ${i}`, { actionIndex: i });
  }
  // 不改变后续动作执行
}
```

同时在引擎的动作描述函数（engine.js 内用于日志/进度显示的地方）增加 monitor 分支，例如输出 `📊 监控 ${name}(${intervalSec}s)`。

**步骤 5.3 — 扩展测试** `tests/engine.test.js`（追加）：

```js
test('runEngine: monitor 动作注册哨兵且不阻塞后续动作', async () => {
  const started = [];
  const deps = makeDeps({ startMonitor: async (index, action) => { started.push({ index, action }); } });
  const state = makeState();  // 复用现有 helper，actions: [monitor, click, delay]
  await runEngine(state, deps);
  assert.equal(started.length, 1);
  assert.equal(started[0].index, 0);
  assert.equal(started[0].action.type, 'monitor');
  // 后续 click/delay 正常执行（复用现有断言方式）
});

test('runEngine: 未注入 startMonitor 时跳过监控不崩溃', async () => {
  const deps = makeDeps();   // 不注入 startMonitor
  const state = makeState();
  await runEngine(state, deps);
  // 断言不抛异常且后续动作完成
});
```

> 具体断言以现有 engine.test.js 的 helper 结构为准（makeDeps/makeState 等），实现时先读该文件再按同样风格追加。

**步骤 5.4 — 运行**：

```powershell
npm test
```

预期：engine 新测试通过，全部既有测试通过。

**里程碑提交**（与 Task 4 一起或单独均可，保持干净历史）：

```powershell
git add autoclick/offscreen/engine.js
git commit -m "1.3: 引擎支持 monitor 动作（并行哨兵注册）"
```

---

## Task 6: ocr.js 封装（浏览器侧）

**目标**：`autoclick/offscreen/ocr.js` —— Paddle.js 单例、推理队列、图片解码/裁剪、运行前预检。动态 import `./ocr-lib.js`（保持引擎冷启动快）。

```js
// autoclick/offscreen/ocr.js
const DET_MODEL_URL = chrome.runtime.getURL('paddlejs/models/det/model.json');
const REC_MODEL_URL = chrome.runtime.getURL('paddlejs/models/rec/model.json');
const PREFLIGHT_DELAY_MS = 30000;   // 预检失败后的最小重试间隔

let lib = null;          // ocr-lib 模块
let ocr = null;          // 初始化后的实例
let queue = Promise.resolve();
let preflightAt = 0;
let preflightError = null;

async function loadLib() {
  if (!lib) lib = await import('./ocr-lib.js');
  return lib;
}

export async function preflight() {
  const now = Date.now();
  if (ocr) return { ok: true };
  if (preflightError && now - preflightAt < PREFLIGHT_DELAY_MS) {
    return { ok: false, error: preflightError };
  }
  preflightAt = now;
  try {
    const m = await loadLib();
    if (!m.init) throw new Error('ocr-lib 缺少 init 导出');
    ocr = await m.init(DET_MODEL_URL, REC_MODEL_URL);
    preflightError = null;
    console.log('[OCR] 模型加载完成（det+rec）');
    return { ok: true };
  } catch (err) {
    preflightError = `OCR 模型加载失败：${err?.message ?? err}（请确认 autoclick/paddlejs/models 已随扩展安装）`;
    console.error('[OCR]', preflightError, err);
    return { ok: false, error: preflightError };
  }
}

export async function recognize(image) {
  const m = await loadLib();
  if (!ocr) {
    const p = await preflight();
    if (!p.ok) { const e = new Error(p.error); e.code = 'INFER'; throw e; }
  }
  const run = async () => {
    try {
      const res = await ocr.recognize(image, { canvas: document.createElement('canvas') });
      return (res?.text ?? []).map(s => String(s));
    } catch (err) {
      const e = new Error(`OCR 推理异常：${err?.message ?? err}`);
      e.code = 'INFER';
      throw e;
    }
  };
  const task = queue.then(run, run);
  queue = task.catch(() => {});
  return task;
}

export function cropFromDataUrl(dataUrl, region) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(region.w));
        canvas.height = Math.max(1, Math.round(region.h));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
        const { width, height } = canvas;
        const out = document.createElement('canvas');
        out.width = width; out.height = height;
        const octx = out.getContext('2d');
        octx.fillStyle = '#fff';
        octx.fillRect(0, 0, width, height);
        octx.drawImage(canvas, 0, 0);
        resolve(out);
      } catch (err) {
        const e = new Error(`图片裁剪失败：${err?.message ?? err}`);
        e.code = 'DECODE';
        reject(e);
      }
    };
    img.onerror = () => {
      const e = new Error('图片解码失败');
      e.code = 'DECODE';
      reject(e);
    };
    img.src = dataUrl;
  });
}
```

> `recognize` 第二参按实际 ocr-lib 签名调整（调研结果：`recognize(image, options?, detConfig?)`）。canvas 的 2d 上下文可能被 WebGL 后端共享冲突，若出现「webgl context lost」类问题，改用 `ImageBitmap` + `createImageBitmap(dataUrl)` 并在线程计划备注中记录解法。

**验证**：`node --check autoclick\offscreen\ocr.js`（浏览器 API 运行时才解析）。

---

## Task 7: engine-main.js 胶水层

**步骤 7.1 — 读现状**：

```powershell
Get-Content autoclick\offscreen\engine-main.js
```

**步骤 7.2 — 改动点**（在 startEngine 及其 runEngine 调用处接线）：

1. 顶部 import：`import { createMonitorManager } from './monitor.js';`、`import * as ocr from './ocr.js';`
2. runEngine deps 增加：
   - `startMonitor(index, action)` → `monitors.startMonitor(index, action)`（先校验：`validateMonitorAction`，不合法则 `log('ERROR', ...)` 并 return，不启动）
   - `captureVisibleTab` → `callSW({ type: 'captureVisibleTab' }, 15000)` 包装：失败抛 `{ code: 'CAPTURE', message }`
   - `ocrReady` → `ocr.preflight()` 失败抛 `{ code: 'INFER', message }`
   - `ocrRecognize` → 组装：`const img = await ocr.cropFromDataUrl(dataUrl, region); return ocr.recognize(img);`（注意：此封装在 startMonitor 里做，deps 层面只给 `captureVisibleTab` 与 `ocrRecognize(img)` 两个原语）
   - `alert(kind, payload)` → kind==='enter'||'recover'||'error' 时：`callSW({ type: 'monitorAlert', payload: { ...payload, kind } })`（不 await，fire-and-forget 带 catch）；同时 `playAlertSound()`（kind!=='error' 时）
   - `now` → `Date.now`，`sleep` → 复用 `createAbortableSleep` 的 sleep
   - `log` → 现有 log()
   - `onStatus(snapshot)` → 节流 1s 后 `callSW({ type: 'monitorStatus', payload: snapshot })`（fire-and-forget）
3. 预检：startEngine 里若 `scriptData.actions.some(a => a.type === 'monitor')` → 异步 `ocr.preflight().then(...)`（不 await，不阻塞引擎启动；失败 → `log('ERROR')` + `callSW({type:'monitorAlert', payload:{kind:'error', message}})`）
4. 停止链路：`engineStop` / 端口 onDisconnect / engineDone 分支全部追加 `monitors.stopAll()`；`monitors.isActive()` 用于状态清理。
5. `playAlertSound()`：Web Audio 880Hz 短音，try/catch 包裹。

**步骤 7.3 — 扩展测试** `tests/engine-main.test.js`（追加 monitor 胶水用例，沿用 chrome-mock 模式：runtime.sendMessage 记录 callSW 调用、断言 captureVisibleTab/monitorAlert 消息类型与载荷）。

**步骤 7.4 — 运行**：

```powershell
npm test
```

**里程碑提交**：

```powershell
git add autoclick/offscreen/engine-main.js autoclick/offscreen/ocr.js
git commit -m "1.3: offscreen OCR 封装与引擎胶水（截屏/提醒/状态）"
```

---

## Task 8: service-worker.js

**步骤 8.1 — 读现状**：

```powershell
Get-Content autoclick\background\service-worker.js
```

**步骤 8.2 — handleEngineCall 新增 case**（沿用现有 switch 结构，约第 112 行起）：

```js
case 'captureVisibleTab': {
  try {
    const tab = await chrome.tabs.get(state.tabId ?? payload.tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: `截屏失败：${err?.message ?? err}` };
  }
}

case 'monitorAlert': {
  const p = payload?.payload ?? payload;
  const kind = p?.kind;
  const title = kind === 'recover' ? '监控已恢复' : kind === 'error' ? '监控异常' : '监控提醒';
  const message = p?.message ?? JSON.stringify(p ?? {});
  try {
    await chrome.notifications.create(`mch_alert_${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icon-128.png'),
      title,
      message,
      priority: kind === 'error' ? 2 : 1
    });
  } catch (err) {
    console.error('[SW] 通知失败', err);
  }
  await sendToTab({ type: 'barAlert', payload: { kind, message, value: p?.value } });
  await log('WARN', `[监控提醒] ${title}: ${message}`);
  return { success: true };
}

case 'monitorStatus': {
  const s = payload?.payload ?? payload;
  if (state) state.monitors = state.monitors ?? {};
  state.monitors[s.id] = s;
  await sendToTab({ type: 'monitorStatus', payload: s });
  return { success: true };
}
```

**步骤 8.3 — getRunningState 扩展**：现有返回中追加 `monitors: Object.values(state?.monitors ?? {})`（popup 运行状态展示用）。`sendToTab` 若已有现成实现则复用（handleMessage 里已有向 tab 发消息的路径）。

**步骤 8.4 — 验证**：

```powershell
node --check autoclick\background\service-worker.js
```

（SW 无独立 Node 测试，随浏览器手工验证。）

**里程碑提交**：

```powershell
git add autoclick/background/service-worker.js autoclick/manifest.json
git commit -m "1.3: SW 截屏代理与系统通知（captureVisibleTab/notifications）"
```

---

## Task 9: picker.js 区域拖选 + 监控配置面板

**步骤 9.1 — 读现状**：

```powershell
Get-Content autoclick\content\picker.js
```

**步骤 9.2 — 改动点**：

1. `startPicker` 支持 `mode: 'click' | 'monitor'`（从 SW 的 pendingPicker 或 popup 传入 payload 获取）。monitor 模式：
   - 覆盖层指令文案改为「按住并拖动框选监控区域，Esc 取消，Enter 确认」。
   - pointerdown/move/up 绘制选区矩形（复用现有高亮 div 逻辑或新增 selection div）。
   - 选区确认后展示配置面板（固定底部居中，DOM 注入）：
     - 名称（input，默认「监控区」）
     - 间隔秒（number，默认 1，min 0.5，step 0.5）
     - 阈值模式（select：百分比 / 精确）
     - percent 模式：目标值、高于目标%（默认 110）、低于目标%（默认 90）
     - exact 模式：精确上限、精确下限
     - 提醒方式（select：通知 / 声音 / 两者，默认两者）
     - 冷却秒（number，默认 60）
     - 提取（select：数字 / 全文，默认数字）
     - 确定 / 取消 按钮
   - 确定 → 组装 action → `chrome.runtime.sendMessage({ type: 'pickerConfirm', payload: { kind: 'monitor', action } })` → 关闭覆盖层。
2. 现有 click 模式行为完全不变。
3. 面板样式注入 picker 的 shadow DOM（延续现有样式注入方式）。

**验证**：无 Node 测试；浏览器手工验证（test page + 真实页面）。

**里程碑提交**：

```powershell
git add autoclick/content/picker.js
git commit -m "1.3: 录制器支持拖框选监控区域与阈值配置"
```

---

## Task 10: popup UI

**步骤 10.1 — 改动点**：

1. `popup.html`：编辑器工具栏加「添加监控」按钮（📊），动作列表项对 monitor 动作显示 📊 前缀。
2. `popup.js`：
   - 「添加监控」→ 与「添加点击」同链路：`chrome.runtime.sendMessage({ type: 'preparePicker', payload: { scriptId, mode: 'monitor' } })` + 注入 + startPicker（带 mode）。
   - `renderActions`：monitor 动作描述文本，如 `📊 余额 每1s [100±10%]` 或 `📊 区域2 每2s [150<v<50]`（按 thresholds.mode 区分）。
   - 运行状态区：getRunningState 返回的 `monitors` 数组，逐条显示 `名称: 值 (状态)`，状态用颜色（normal 绿 / high 红 / low 橙 / error 灰）。
   - 删除动作按钮对 monitor 同样生效（现有 op-btn 机制通用）。
3. `popup.css`：`.monitor-status` 行样式、颜色类。

**验证**：浏览器手工验证。

**里程碑提交**：

```powershell
git add autoclick/popup
git commit -m "1.3: 弹窗支持监控动作编辑与运行状态展示"
```

---

## Task 11: player.js 浮窗监控状态

**步骤 11.1 — 改动点**：

1. 监听 `{ type: 'monitorStatus' }` → 浮窗追加一行 `📊 名称: 值 · 状态`（小节 `<div id="mch-monitor-<id>">`），值变化时更新；状态色同 popup。
2. 监听 `{ type: 'barAlert' }` → 浮窗整体红灯闪烁（CSS class `mch-alert-flash`，3 次闪烁或 3s）+ 显示消息文字；3s 后恢复。
3. 运行结束/清空（现有 barUpdate/engineDone 路径）→ 移除监控行。

**验证**：浏览器手工验证。

**里程碑提交**：

```powershell
git add autoclick/content/player.js
git commit -m "1.3: 运行浮窗显示监控状态与报警红灯"
```

---

## Task 12: testwenui/testchoose.html 测试点

**步骤 12.1 — 读现状**：`Get-Content testwenui\testchoose.html`（先看现有 5 个 section 结构与 JS 组织方式，保持风格一致）。

**步骤 12.2 — 新增 Section 6（OCR 监控测试面板）**：

```html
<div class="test-section">
  <h3>6. OCR 监控测试面板（配合扩展「添加监控」使用）</h3>
  <p style="font-size:13px;color:#666;">动态数值每 1 秒随机变化（50~200）；下方按钮可强制设置特定值，便于验证越界/恢复提醒。</p>
  <div style="display:flex;align-items:center;gap:16px;margin:10px 0;">
    <span id="ocr-live-value" style="font-size:36px;font-weight:bold;color:#1a73e8;font-family:monospace;">100</span>
    <span style="font-size:13px;color:#888;">→ 监控此数字，阈值示例：精确模式 上限 150 / 下限 50</span>
  </div>
  <div class="row" style="gap:8px;margin-bottom:8px;">
    <button id="ocr-random">随机变化</button>
    <button id="ocr-set-120">固定 120（正常）</button>
    <button id="ocr-set-180">设为 180（越上限）</button>
    <button id="ocr-set-20">设为 20（越下限）</button>
  </div>
  <p style="font-size:13px;color:#666;">文本测试区（提取「全文」模式用）：<span id="ocr-text-zone" style="font-weight:bold;">当前余额 123.45 元</span></p>
  <div class="row" style="gap:8px;">
    <button id="ocr-text-shuffle">随机切换文本</button>
    <button id="ocr-text-chinese">设为中文数字（一亿二千三百四十五）</button>
  </div>
</div>
```

**步骤 12.3 — JS**（沿用现有 `<script>` 组织）：

```js
(function () {
  const valueEl = document.getElementById('ocr-live-value');
  const textEl = document.getElementById('ocr-text-zone');
  const texts = ['当前余额 123.45 元', '剩余 1,234 个', '温度 -5.5 ℃', '进度 50%', '无数字内容'];
  let timer = null;
  function setValue(v) { valueEl.textContent = String(v); }
  function startRandom() {
    clearInterval(timer);
    timer = setInterval(() => setValue(50 + Math.floor(Math.random() * 151)), 1000);
  }
  document.getElementById('ocr-random').onclick = startRandom;
  document.getElementById('ocr-set-120').onclick = () => { clearInterval(timer); setValue(120); };
  document.getElementById('ocr-set-180').onclick = () => { clearInterval(timer); setValue(180); };
  document.getElementById('ocr-set-20').onclick = () => { clearInterval(timer); setValue(20); };
  document.getElementById('ocr-text-shuffle').onclick = () => { textEl.textContent = texts[Math.floor(Math.random() * texts.length)]; };
  document.getElementById('ocr-text-chinese').onclick = () => { textEl.textContent = '剩余额度：一亿二千三百四十五'; };
  startRandom();
})();
```

> 具体 DOM id/结构在实现时按 testchoose.html 现有 section 风格微调（h3 层级、row class）。

**提交**：

```powershell
git add testwenui/testchoose.html
git commit -m "1.3: 测试页新增 OCR 监控测试面板"
```

---

## Task 13: 全量回归与收尾

**步骤 13.1 — 全量测试**：

```powershell
npm test
```

预期：全部通过（既有 43 + monitor-logic + monitor + engine 扩展）。

**步骤 13.2 — 检查未提交文件**：

```powershell
git status
git diff --stat
```

预期：只剩本次功能相关改动，无 tests/、node_modules/ 混入。

**步骤 13.3 — 浏览器手工验证清单**（加载未打包扩展 `F:\Autoclick\autoclick`，打开 testwenui/testchoose.html）：

1. 「添加监控」→ 拖框框选动态数字 → 配置精确模式 上 150 / 下 50 → 确定。
2. 运行脚本：浮窗出现监控行，数值随页面变化刷新（1Hz）。
3. 点「设为 180」→ 3s 内收到系统通知 + 浮窗红灯 + 提示音。
4. 冷却期内再触发（180→120→180 快速切换）→ 不重复提醒。
5. 点「设为 120」→ 收到「已恢复正常」提醒。
6. 点「设为 20」→ 低于下限提醒。
7. 停止脚本 → 监控行消失、无新通知。
8. 切到其他标签页/最小化窗口 → 通知仍正常（captureVisibleTab 依赖可见性，隐藏标签页场景记日志 WARN 不崩溃）。
9. 中文数字文本区：框选「一亿二千三百四十五」→ 解析为 12345 并在浮窗显示。
10. 「无数字内容」→ 解析失败日志 WARN，不误报。
11. 全角数字、千分位文本分别验证。
12. 浏览器控制台无未捕获异常；`chrome://extensions` 无打包错误。
13. 回归：现有点击/延迟脚本、快捷键、紧急停止不受影响。

**步骤 13.4 — 最终提交 + 推送**：

```powershell
git add -A   # 确认 status 后再 add
git status
git commit -m "1.3: OCR 区域监控完成（离线 Paddle.js 识别）"
git -c http.proxy=http://127.0.0.1:7897 -c credential.helper="!gh auth git-credential" push https://github.com/x41423/Autoclick.git main
```

> 推送前需用户确认（spec 提交 5be3ba4 也一并推送）。

## 交付物清单

- 新文件：`autoclick/offscreen/monitor-logic.js`、`monitor.js`、`ocr.js`、`ocr-entry.js`、`ocr-lib.js`（打包产物）、`autoclick/paddlejs/models/{det,rec}/*`、`tests/monitor-logic.test.js`、`tests/monitor.test.js`（本地）
- 改动：`engine.js`、`engine-main.js`、`service-worker.js`、`picker.js`、`player.js`、`popup/*`、`manifest.json`、`package.json`、`package-lock.json`、`.gitignore`、`testwenui/testchoose.html`
- 未推送提交：5be3ba4（spec）+ 本次各里程碑提交