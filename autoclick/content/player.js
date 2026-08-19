// content/player.js
// 页面客户端：执行单次点击 + 进度浮窗（执行循环在后台 offscreen 引擎中）

(function() {
  if (window.__player_initialized) {
    return;
  }
  window.__player_initialized = true;

  let floatingBar = null;
  let paused = false;

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'performClick') {
      const { target, index, total } = message.payload;
      ensureFloatingBar(total);
      updateFloatingBar(index, total);
      performClick(target)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    if (message.type === 'barUpdate') {
      const { index, total, remainingMs } = message.payload;
      ensureFloatingBar(total);
      updateFloatingBar(index, total, remainingMs);
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'barHide') {
      removeFloatingBar();
      sendResponse({ success: true });
      return false;
    }
    if (message.type === 'syncPauseState') {
      setPausedState(message.payload.paused);
      sendResponse({ success: true });
      return false;
    }
  });

  // ---------- 浮窗 ----------
  function ensureFloatingBar(total) {
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
      <span id="mch-progress">⏳ 0/${total}</span>
      <span id="mch-remaining">执行中...</span>
      <button id="mch-pause" style="
        background: #f5a623;
        border: none;
        color: white;
        padding: 2px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      ">⏸</button>
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
      chrome.runtime.sendMessage({ type: 'stopScript' }).catch(() => {});
    });
    document.getElementById('mch-pause').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: paused ? 'resumeScript' : 'pauseScript' }).catch(() => {});
    });
  }

  function updateFloatingBar(current, total, remainingMs = null) {
    if (!floatingBar) return;
    const prog = document.getElementById('mch-progress');
    const rem = document.getElementById('mch-remaining');
    if (prog) prog.textContent = `⏳ ${current}/${total}`;
    if (rem) {
      if (paused) {
        rem.textContent = '⏸ 已暂停';
      } else if (remainingMs !== null && remainingMs > 0) {
        rem.textContent = `剩余 ${Math.ceil(remainingMs/1000)}s`;
      } else {
        rem.textContent = '执行中...';
      }
    }
  }

  function setPausedState(pausedValue) {
    paused = pausedValue;
    const pauseBtn = floatingBar && document.getElementById('mch-pause');
    if (pauseBtn) pauseBtn.textContent = paused ? '▶' : '⏸';
    if (floatingBar) {
      const rem = document.getElementById('mch-remaining');
      if (rem) rem.textContent = paused ? '⏸ 已暂停' : '执行中...';
    }
  }

  function removeFloatingBar() {
    if (floatingBar) {
      floatingBar.remove();
      floatingBar = null;
    }
    paused = false;
  }

  // ---------- 点击执行 ----------
  async function performClick(target) {
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
      clientX = elementRect.left + clickOffsetX - currentScrollX;
      clientY = elementRect.top + clickOffsetY - currentScrollY;
    }

    const success = simulateClick(clientX, clientY);
    if (!success) {
      if (elementRect) {
        const retryX = elementRect.left + (elementRect.width / 2) - currentScrollX;
        const retryY = elementRect.top + (elementRect.height / 2) - currentScrollY;
        if (simulateClick(retryX, retryY)) {
          return;
        }
      }
      throw new Error(`点击坐标 (${clientX}, ${clientY}) 处无有效元素`);
    }
  }

  function simulateClick(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return false;
    const eventOpts = { bubbles: true, cancelable: true, view: window, clientX, clientY, detail: 1 };
    const pointerOpts = { ...eventOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));
    return true;
  }

  // ---------- 注入后自查：页面刷新/重注入时恢复浮窗 ----------
  chrome.runtime.sendMessage({ type: 'getRunningState' })
    .then(res => {
      if (res && res.success && res.running) {
        ensureFloatingBar(res.totalSteps);
        updateFloatingBar(res.currentIndex, res.totalSteps, null);
        setPausedState(res.paused);
      }
    })
    .catch(() => {});
})();