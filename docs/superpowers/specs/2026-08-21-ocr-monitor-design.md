# OCR 区域监控（Paddle.js 离线识别）设计文档

- 日期：2026-08-21
- 状态：已确认，待实现
- 关联仓库：https://github.com/x41423/Autoclick

## 1. 背景与目标

当前扩展（Autoclick）的脚本是基于坐标的线性点击自动化（点击 + 延迟）。用户希望接入 PaddleOCR 的离线 OCR 能力，实现「文本/数字视觉」功能。

核心场景：**区域数值监控**——脚本周期性识别屏幕指定区域内的文字/数字，与用户设定的阈值比较，越界（高于上限或低于下限）时发出提醒。

### 明确需求

1. OCR 以浏览器内推理方式离线运行（Paddle.js，WebGL 优先 + WASM 兜底），零安装、自包含。
2. 录制阶段：用户在当前页面上拖框选定一个监控区域（视口坐标矩形）。
3. 运行阶段：脚本周期性截取该区域 → OCR 识别 → 提取数字 → 与阈值比较 → 越界提醒。
4. 阈值支持两种模式：
   - 百分比模式：用户设定目标值 + 上下浮动百分比（如目标 100，高于 110% 或低于 90% 时提醒）。
   - 精确模式：用户设定精确上下限（如 >150 或 <50 时提醒）。
5. 刷新频率：**0.5 秒起步可配，默认 1 秒**；目标在 A/B 两台机器（A: i7-8700K + RTX 2060，B: i5-13600KF + RTX 2070）上 1Hz 轻松达标。
6. 监控作为并行后台哨兵运行，**不影响**现有点击/延迟动作的线性执行。
7. 错误处理与日志要**全面**，便于检修与维护。

## 2. 架构总览

```
┌─────────────────────────── 浏览器页面 (tab) ───────────────────────────┐
│  picker.js (录制时)          player.js (运行时)                            │
│   拖框选区域 → 记 region 视口矩形   浮窗显示监控状态/报警红灯              │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ 消息
┌───────────────┴──────────────────────────────────────────────────────────┐
│  Service Worker (background)                                             │
│  - captureVisibleTab 截屏（MV3 限制：仅 SW 可调用）                        │
│  - chrome.notifications 系统通知                                        │
│  - 浮窗消息转发、callSW 路由、executionState                             │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ 端口 (Port) + callSW
┌───────────────┴──────────────────────────────────────────────────────────┘
│  Offscreen Document（引擎 + OCR 宿主）                                    │
│  - engine.js: 线性动作执行（点击/延迟/监控哨兵注册）                        │
│  - ocr.js: Paddle.js 单例（WebGL/WASM），模型离线打包                      │
│  - monitor.js: 后台哨兵循环（截屏请求→裁剪→识别→解析→比较→提醒）           │
│  - engine-main.js: 端口胶水层                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 新增/改动文件

- `autoclick/offscreen/ocr.js`（新增）— Paddle.js 封装
- `autoclick/offscreen/monitor.js`（新增）— 哨兵逻辑
- `autoclick/offscreen/engine.js`（改动）— 支持 `monitor` 动作，注册/取消哨兵
- `autoclick/offscreen/engine-main.js`（改动）— 新增消息路由
- `autoclick/background/service-worker.js`（改动）— captureVisibleTab、notifications、消息路由
- `autoclick/content/picker.js`（改动）— 拖框选区域 UI、阈值配置
- `autoclick/content/player.js`（改动）— 浮窗监控状态展示
- `autoclick/popup/*`（改动）— 监控动作的编辑 UI、日志面板
- `autoclick/manifest.json`（改动）— 权限、打包资源
- `autoclick/paddlejs/models/*`（新增）— 离线模型文件（PP-OCR det + rec，约 10-20MB）
- `autoclick/paddlejs/lib/*`（新增）— Paddle.js 运行时库
- `tests/monitor.test.js`（新增）— 阈值比较/解析/哨兵调度单测

## 3. 数据模型

### 3.1 监控动作

```js
{
  type: 'monitor',
  name: '监控余额',                 // 可选，便于日志识别
  region: { x, y, w, h },           // 视口坐标矩形（录制时选取）
  intervalSec: 1,                   // 轮询间隔，下限 0.5s
  thresholds: {
    mode: 'percent' | 'exact',
    target: 100,                    // percent 模式：基准目标值
    percentUp: 110,                 // percent 模式：高于目标 N% 提醒
    percentDown: 90,                // percent 模式：低于目标 N% 提醒
    upper: 150,                     // exact 模式：精确上限（含）
    lower: 50                       // exact 模式：精确下限（含）
  },
  alert: {
    way: 'notification' | 'sound' | 'both',  // 提醒方式，默认 both
    cooldownSec: 60                 // 越界后重复提醒最小间隔（防刷屏）
  },
  parse: 'number' | 'text'          // 提取策略，默认 number
}
```

### 3.2 哨兵运行状态（仅运行时内部，不落盘）

```js
{
  id: 'monitor_<scriptId>_<index>',
  actionIndex: 3,                   // 所属动作下标，用于日志定位
  status: 'active' | 'waiting' | 'error' | 'stopped',
  lastValue: null,                  // 最近一次识别到的数值
  lastRawText: '',                  // 最近一次识别原文
  lastCheckAt: 0,                   // 最近一次成功检查时间戳
  lastAlertAt: 0,                   // 最近一次提醒时间戳（冷却判定）
  alertState: 'normal' | 'high' | 'low',  // 当前越界状态（状态变化才提醒）
  consecutiveFailures: 0,           // 连续失败次数（OCR/解析失败累计）
  stopped: false                    // 取消标志
}
```

### 3.3 阈值比较规则

- 解析后的数值 `v`，未解析出数字时 `v = null`。
- percent 模式：`high = v > target * percentUp / 100`；`low = v < target * percentDown / 100`。
- exact 模式：`high = v > upper`；`low = v < lower`。
- `null` 一律不算越界（不误报），计入解析失败统计。

## 4. 运行时流程

### 4.1 引擎动作执行

- 引擎线性遍历动作列表，遇到 `monitor` 动作时：创建哨兵并注册（不阻塞），**立即继续**下一条动作。
- 其余 `click`/`delay` 动作逻辑完全不变。

### 4.2 哨兵循环（独立 async 循环，与主流程并行）

每轮：

1. 检查 `stopped` / 引擎停止标志，是则退出。
2. `callSW({type:'captureVisibleTab'})` → SW 截取当前可见视口（JPEG，quality 60）→ 返回 dataURL。
   - 若失败（标签页不可见/被切换/超时）→ 记日志，`consecutiveFailures++`，跳过本轮，下轮重试。
3. offscreen 用 canvas 载入图片，裁剪 `region` 区域 → 小图（必要时白底增强，提高识别率）。
4. 送入 Paddle.js（单例，经推理队列串行）→ 得到文本行 + 置信度。
5. 按 `parse` 策略提取数值：
   - `number`：正则提取首个数字（支持负号、小数、千分位、中文数字转阿拉伯数字）。
   - `text`：直接取全文。
6. 阈值比较 → 更新 `alertState`。
7. 状态从 `normal` 变为 `high`/`low` → 触发提醒（若距上次提醒超过 `cooldownSec`）；状态恢复 `normal` → 也提醒一次（提示"已恢复正常"）。
8. 成功则 `consecutiveFailures = 0`，更新 `lastValue/lastRawText/lastCheckAt`。
9. 等待 `intervalSec`（动态微调：若本轮实际耗时超过间隔，不叠加等待，防漂移）。

### 4.3 提醒链路

- offscreen 检测越界/恢复 → `callSW({type:'monitorAlert', payload})`。
- SW：`chrome.notifications.create` 系统通知（含脚本名、区域名、当前值、越界类型）；并向对应标签页浮窗发 `barAlert`（红灯闪烁 + 显示当前值）。
- 声音：offscreen 用 Web Audio 播放提示音（SW 无音频能力）。
- 全部提醒动作都写日志。

### 4.4 停止

- 引擎 `engineStop` / 端口断开 / 脚本停止：取消全部哨兵，状态置 `stopped`，释放 Paddle 实例资源。

## 5. 错误处理与日志（重点）

目标是"任何异常都能在日志里还原现场、定位到具体环节"。日志统一走现有 logger 工具，带时间戳、哨兵 id、动作下标。

### 5.1 日志分级

- INFO：哨兵启动/停止、每轮成功结果（值 + 原文 + 耗时）、提醒触发/恢复。
- WARN：单次截屏失败、单次 OCR 无结果、解析失败（记录原文，便于调正则）、单轮超时。
- ERROR：模型加载失败、连续失败超阈值（连续 5 次）、Paddle 推理异常、消息路由异常。

### 5.2 各环节异常处理

| 环节 | 异常 | 处理 | 日志 |
|---|---|---|---|
| 截屏 | 标签页不可见/被切换 | 跳过本轮，下轮重试 | WARN（含 tabId、原因） |
| 截屏 | 超时（>10s） | 跳过本轮，计入连续失败 | WARN |
| 图片解码 | 损坏/格式错误 | 跳过本轮 | ERROR |
| 推理 | Paddle 异常 | 跳过本轮，计入连续失败 | ERROR（含异常栈） |
| 识别 | 无文本行 | 跳过本轮，不算越界 | WARN（含裁剪尺寸） |
| 解析 | 提取不到数字 | 跳过本轮，不算越界，保留原文 | WARN（含原文） |
| 比较 | `null` 值 | 不算越界 | INFO |
| 连续失败 | 累计 ≥5 | 暂停该哨兵 30s 后重试，期间不再高频空转 | ERROR + 通知用户 |
| 模型加载 | 失败 | 运行前预检，明确报错，不启动脚本 | ERROR（含原因/修复建议） |

### 5.3 运行前预检

脚本启动时若包含 `monitor` 动作，先执行预检（不阻塞主流程，异步进行）：

- Paddle 运行时库与模型文件是否打包齐全（`chrome.runtime.getURL` 校验）。
- 首次加载+预热模型（小图跑一次），失败则给出明确错误 + 指引（重装扩展/检查文件）。
- 校验每个 monitor 动作的 region 尺寸合法、intervalSec ≥ 0.5、阈值配置完整（percent 模式必须给 target 且 percentUp>percentDown）。

### 5.4 可维护性

- 所有耗时环节（截屏耗时、裁剪耗时、推理耗时、总轮耗时）记入日志，供性能调优。
- 哨兵状态在运行面板可见（最后值、原文、状态、耗时、失败计数）。
- 日志面板支持按哨兵 id / 级别过滤。

## 6. 权限与清单变更

- `permissions` 新增：`tabs`（captureVisibleTab）、`notifications`（系统通知）。
- 已有：`activeTab`、`storage` 等保持。
- `web_accessible_resources`：无需新增（Paddle 库与模型仅 offscreen 内使用，不走页面加载）。
- offscreen 文档：WebGL 默认可用，无需额外权限。

## 7. 性能预算

目标刷新频率 0.5~1s，单轮预算：

| 环节 | 预计耗时（A/B 机器） |
|---|---|
| captureVisibleTab + JPEG 传输 | 100-300ms |
| 区域裁剪 + 预处理 | 10-30ms |
| Paddle.js 推理（WebGL，小图） | 50-200ms |
| 解析 + 比较 + 日志 | <5ms |
| **合计** | **~200-500ms** |

- WebGL 为默认后端；WASM 兜底（无 GPU 时）预计慢 3-5 倍，自动把有效频率降级为 1-2s。
- 多哨兵共用单例 Paddle 实例 + 推理队列，避免并发 WebGL 争抢。

## 8. 测试策略

- 单元测试（Node，`node --test`）：
  - 阈值比较：percent/exact 边界（= 上限、= 下限、临界浮动值）、null 不误报。
  - 数字解析：整数/小数/负数/千分位/混合文本/中文数字。
  - 哨兵调度：假时钟验证间隔、动态微调、冷却期、状态变化触发。
  - 截屏失败/推理失败/连续失败退避逻辑。
- 浏览器手工验证（A/B 机器）：
  - 真实页面框选区域 → 运行 → 验证 1Hz 刷新、提醒触发、恢复、停止。
  - 页面滚动/切页/隐藏标签页时的行为符合预期。
- 回归：现有 43 个测试全部保持通过；现有点击/延迟功能不受影响。

## 9. 明确不做（YAGNI）

- 不做整屏全文识别/OCR 点击定位（当前需求仅为区域数值监控）。
- 不做跨区域文字联动（如"读取 A 区域数值写入 B 输入框"），留待后续。
- 不做云端 OCR 或在线模型下载（必须离线）。
- 不做大屏自动跟踪滚动（region 为固定视口矩形；页面滚动时区域随视口走）。