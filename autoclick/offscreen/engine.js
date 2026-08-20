// offscreen/engine.js
// 脚本执行引擎（纯逻辑，依赖注入，可在 Node 中单元测试）

export function createAbortableSleep() {
  let aborted = false;
  let paused = false;
  return {
    abort() { aborted = true; },
    isAborted() { return aborted; },
    pause() { paused = true; },
    resume() { paused = false; },
    isPaused() { return paused; },
    async waitIfPaused() {
      while (paused && !aborted) {
        await new Promise(r => setTimeout(r, 50));
      }
    },
    sleep(ms, onTick) {
      return new Promise((resolve) => {
        if (aborted) return resolve();
        const target = Date.now() + ms;
        let lastTick = Date.now();
        const step = () => {
          if (aborted) return resolve();
          if (paused) {
            setTimeout(step, 50);
            return;
          }
          const remaining = target - Date.now();
          if (remaining <= 0) return resolve();
          if (onTick && Date.now() - lastTick >= 1000) {
            lastTick = Date.now();
            onTick(remaining);
          }
          setTimeout(step, Math.min(100, remaining));
        };
        setTimeout(step, Math.min(100, ms));
      });
    }
  };
}

/**
 * 执行脚本动作序列
 * @param {object} state - { scriptId, tabId, currentIndex, scriptData }
 * @param {object} deps - { performClick, saveProgress, log, sleep, isAborted, onTick?, waitIfPaused? }
 * @returns {Promise<{completed: boolean}>}
 */
export async function runEngine(state, deps) {
  const actions = state?.scriptData?.actions;
  if (!actions || !Array.isArray(actions)) {
    throw new Error('无效的脚本数据');
  }

  const startIndex = Math.max(0, state.currentIndex || 0);
  const tabId = state.tabId;
  const total = actions.length;
  let interrupted = false;

  for (let i = startIndex; i < total; i++) {
    if (deps.isAborted()) { interrupted = true; break; }
    await deps.waitIfPaused?.();
    const action = actions[i];
    await deps.saveProgress(i);

    if (action.type === 'delay') {
      await deps.sleep(action.value || 0, (remainingMs) => deps.onTick?.(i, total, remainingMs));
    } else if (action.type === 'click') {
      const result = await deps.performClick(tabId, action.target, i, total);
      if (!result || !result.success) {
        throw new Error((result && result.error) || `点击失败 (第 ${i + 1} 步)`);
      }
    } else if (action.type === 'monitor') {
      await deps.startMonitor(i, action);
    } else {
      await deps.log('WARN', `未知动作类型: ${action.type}，跳过`);
    }

    if (deps.isAborted()) { interrupted = true; break; }
  }

  if (interrupted) await deps.stopMonitors?.();

  return { completed: !interrupted };
}