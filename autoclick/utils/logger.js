// utils/logger.js
// 统一日志工具：控制台彩色输出 + storage持久化（循环队列，最多200条）

const LOG_KEY = 'logQueue';
const MAX_LOG = 200;

// 颜色方案（用于控制台）
const COLORS = {
  INFO: 'color: #2e7d32; font-weight: bold;',      // 绿色
  WARN: 'color: #b76e00; font-weight: bold;',      // 橙色
  ERROR: 'color: #c62828; font-weight: bold;',     // 红色
  DEBUG: 'color: #1565c0; font-weight: bold;',     // 蓝色
};

/**
 * 写入日志（同时输出到控制台和存储）
 * @param {string} level - 'INFO'|'WARN'|'ERROR'|'DEBUG'
 * @param {string} tag - 来源标识，如 '[CS]' '[BG]' '[POPUP]'
 * @param {string} message - 日志内容
 */
export async function log(level, tag, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fullMsg = `[${timestamp}] [${level}] ${tag} ${message}`;

  // 1. 彩色控制台输出
  const color = COLORS[level] || COLORS.INFO;
  console.log(`%c${fullMsg}`, color);

  // 2. 写入 storage（异步，不阻塞）
  try {
    const result = await chrome.storage.local.get(LOG_KEY);
    let queue = result[LOG_KEY] || [];
    queue.push(fullMsg);
    if (queue.length > MAX_LOG) {
      queue = queue.slice(-MAX_LOG);
    }
    await chrome.storage.local.set({ [LOG_KEY]: queue });
  } catch (err) {
    // 存储失败不应影响主逻辑，只打印一次错误到控制台（不加无限循环）
    console.error('[Logger] 写入存储失败:', err);
  }
}

/**
 * 获取全部日志（用于展示）
 */
export async function getLogs() {
  const result = await chrome.storage.local.get(LOG_KEY);
  return result[LOG_KEY] || [];
}

/**
 * 清空日志
 */
export async function clearLogs() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}