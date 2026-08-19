// content/player.js
// 脚本执行引擎（支持自动恢复）

(function() {
  if (window.__player_initialized) {
    console.log('[Player] 已初始化，跳过重复加载');
    return;
  }
  window.__player_initialized = true;

  let abortController = null;
  let isRunning = false;
  let floatingBar = null;
  let stopRequested = false;

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'executeScript') {
      const { scriptId, scriptData } = message.payload;
      if (isRunning) stopExecution();
      startExecution(scriptId, scriptData)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.type === 'stopScript') {
      stopExecution();
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'resumeExecution') {
      const { scriptId, scriptData, startIndex } = message.payload;
      if (isRunning) stopExecution();
      startExecution(scriptId, scriptData, startIndex)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });

  // ---------- 浮窗 ----------
  function createFloatingBar(totalSteps) {
    if (floatingBar) return;
    const bar = document.createElement('div');
    bar.id = 'mch-floating-bar';
    bar.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      pointer-events: auto;
      user-select: none;
    `;
    bar.innerHTML = `
      <span id="mch-progress">⏳ 0/${totalSteps}</span>
      <span id="mch-remaining">剩余 --s</span>
      <button id="mch-stop" style="
        background: #d32f2f;
        border: none;
        color: white;
        padding: 2px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      ">■ 停止</button>
    `;
    document.body.appendChild(bar);
    floatingBar = bar;
    document.getElementById('mch-stop').addEventListener('click', () => {
      stopRequested = true;
      if (abortController) abortController.abort();
    });
  }

  function updateFloatingBar(current, total, remainingMs = null) {
    if (!floatingBar) return;
    const prog = document.getElementById('mch-progress');
    const rem = document.getElementById('mch-remaining');
    if (prog) prog.textContent = `⏳ ${current}/${total}`;
    if (rem) {
      if (remainingMs !== null && remainingMs > 0) {
        rem.textContent = `剩余 ${Math.ceil(remainingMs/1000)}s`;
      } else {
        rem.textContent = '执行中...';
      }
    }
  }

  function removeFloatingBar() {
    if (floatingBar) {
      floatingBar.remove();
      floatingBar = null;
    }
  }

  // ---------- 执行引擎 ----------
  async function startExecution(scriptId, scriptData, startIndex = 0) {
    if (!scriptData || !scriptData.actions || !Array.isArray(scriptData.actions)) {
      throw new Error('无效的脚本数据');
    }

    if (startIndex > 0) {
      await chrome.runtime.sendMessage({ type: 'markResumed' });
    }

    stopRequested = false;
    abortController = new AbortController();
    isRunning = true;
    const signal = abortController.signal;

    const beforeUnloadHandler = () => {
      if (isRunning) {
        chrome.runtime.sendMessage({
          type: 'log',
          payload: { level: 'WARN', tag: '[CS]', message: '页面刷新，脚本执行被中断' }
        }).catch(() => {});
        removeFloatingBar();
      }
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);

    const actions = scriptData.actions;
    const total = actions.length;
    createFloatingBar(total);
    updateFloatingBar(startIndex, total);

    await log('INFO', '[CS]', `开始执行脚本: ${scriptData.name || '未命名'}${startIndex > 0 ? `（从第 ${startIndex + 1} 步继续）` : ''}`);

    try {
      for (let i = startIndex; i < actions.length; i++) {
        if (signal.aborted || stopRequested) {
          await log('WARN', '[CS]', '脚本执行被用户中断');
          break;
        }

        const action = actions[i];
        updateFloatingBar(i, total);
        await log('DEBUG', '[CS]', `执行第 ${i+1}/${total} 步: ${action.type}`);

        await chrome.runtime.sendMessage({
          type: 'updateProgress',
          payload: { index: i }
        }).catch(() => {});

        if (action.type === 'delay') {
          const ms = action.value || 0;
          updateFloatingBar(i, total, ms);
          await delay(ms, signal);
        } else if (action.type === 'click') {
          updateFloatingBar(i, total);
          await performClick(action.target, signal);
        } else {
          await log('WARN', '[CS]', `未知动作类型: ${action.type}，跳过`);
        }
      }

      if (!signal.aborted && !stopRequested) {
        updateFloatingBar(total, total);
        await log('INFO', '[CS]', '脚本执行完成');
        await chrome.runtime.sendMessage({ type: 'clearExecutionState' });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        await log('WARN', '[CS]', '脚本执行被强制终止');
      } else {
        await log('ERROR', '[CS]', `执行错误: ${err.message}`);
      }
    } finally {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      isRunning = false;
      abortController = null;
      removeFloatingBar();
    }
  }

  function stopExecution() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isRunning = false;
    stopRequested = true;
    removeFloatingBar();
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => resolve(), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }

  async function performClick(target, signal) {
    const { documentX, documentY, snapshotScrollX, snapshotScrollY, clickOffsetX, clickOffsetY, elementRect } = target;

    if (snapshotScrollX !== undefined && snapshotScrollY !== undefined) {
      window.scrollTo(snapshotScrollX, snapshotScrollY);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    const currentScrollX = window.scrollX;
    const currentScrollY = window.scrollY;
    let clientX = documentX - currentScrollX;
    let clientY = documentY - currentScrollY;

    if (elementRect && clickOffsetX !== undefined && clickOffsetY !== undefined) {
      const rectLeft = elementRect.left;
      const rectTop = elementRect.top;
      const newDocX = rectLeft + clickOffsetX;
      const newDocY = rectTop + clickOffsetY;
      clientX = newDocX - currentScrollX;
      clientY = newDocY - currentScrollY;
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const success = simulateClick(clientX, clientY);
    if (!success) {
      if (elementRect) {
        const retryX = elementRect.left + (elementRect.width / 2) - currentScrollX;
        const retryY = elementRect.top + (elementRect.height / 2) - currentScrollY;
        const retrySuccess = simulateClick(retryX, retryY);
        if (retrySuccess) {
          await log('WARN', '[CS]', `坐标 (${clientX},${clientY}) 无元素，采用区域中心重试成功`);
          return;
        }
      }
      throw new Error(`点击坐标 (${clientX}, ${clientY}) 处无有效元素`);
    }
  }

  function simulateClick(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return false;
    const eventOpts = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));
    return true;
  }

  async function log(level, tag, message) {
    try {
      await chrome.runtime.sendMessage({
        type: 'log',
        payload: { level, tag, message }
      });
    } catch (e) {
      console.log(`[${level}] ${tag} ${message}`);
    }
  }

  console.log('[Player] 已加载，等待执行指令');
})();