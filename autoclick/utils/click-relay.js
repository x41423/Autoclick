// utils/click-relay.js
// 后台转发点击到页面（注入 player + 发送消息，失败自动重试）

/**
 * 转发一次点击并处理重试
 * @param {object} deps - { injectPlayer(tabId), sendToTab(tabId, message), isTabAlive(tabId), isAborted?(), wait(ms) }
 * @param {object} params - { tabId, target, index, total, retries?, retryDelayMs? }
 */
export async function relayClickWithRetry(deps, params) {
  const { tabId, target, index, total } = params;
  const retries = params.retries ?? 4;
  const retryDelayMs = params.retryDelayMs ?? 800;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (deps.isAborted && deps.isAborted()) {
      return { success: false, error: '执行已中止', aborted: true };
    }
    try {
      await deps.injectPlayer(tabId);
      const resp = await deps.sendToTab(tabId, { type: 'performClick', payload: { target, index, total } });
      if (resp && resp.success) return { success: true };
      return { success: false, error: (resp && resp.error) || '页面执行失败' };
    } catch (err) {
      if (deps.isAborted && deps.isAborted()) {
        return { success: false, error: '执行已中止', aborted: true };
      }
      const alive = await deps.isTabAlive(tabId);
      if (!alive) {
        return { success: false, error: '标签页已关闭，脚本终止', aborted: true };
      }
      if (attempt === retries) {
        return { success: false, error: `页面未就绪: ${err.message}` };
      }
      await deps.wait(retryDelayMs);
    }
  }
  return { success: false, error: '未知错误' };
}