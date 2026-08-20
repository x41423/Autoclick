// content/picker.js
// 可视化坐标拾取器（自包含，通过消息控制）

(function() {
  if (window.__picker_initialized) {
    console.log('[Picker] 已初始化，跳过重复加载');
    return;
  }
  window.__picker_initialized = true;

  let isActive = false;
  let paused = false;
  let continuousMode = false;
  let highlightedElement = null;
  let highlightDiv = null;
  let overlayDiv = null;
  let tooltipDiv = null;
  let locked = false;
  let targetData = null;
  let pickCount = 0;
  let controlBarDiv = null;
  let statusEl = null;
  let pauseBtn = null;
  let cancelBtn = null;

  // ---------- 创建遮罩 ----------
  function createOverlay() {
    if (overlayDiv) return;
    overlayDiv = document.createElement('div');
    overlayDiv.id = 'mch-picker-overlay';
    overlayDiv.style.cssText = `
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 999999;
      pointer-events: none;
      background: rgba(0,0,0,0.08);
    `;
    document.body.appendChild(overlayDiv);
  }

  function createHighlight() {
    if (highlightDiv) return;
    highlightDiv = document.createElement('div');
    highlightDiv.id = 'mch-picker-highlight';
    highlightDiv.style.cssText = `
      position: fixed;
      border: 2px solid #1a73e8;
      background: rgba(26, 115, 232, 0.15);
      pointer-events: none;
      z-index: 1000000;
      display: none;
    `;
    document.body.appendChild(highlightDiv);
  }

  function createTooltip() {
    if (tooltipDiv) return;
    tooltipDiv = document.createElement('div');
    tooltipDiv.id = 'mch-picker-tooltip';
    tooltipDiv.style.cssText = `
      position: fixed;
      background: rgba(0,0,0,0.85);
      color: #fff;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-family: system-ui, sans-serif;
      pointer-events: none;
      z-index: 1000001;
      display: none;
      max-width: 300px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    document.body.appendChild(tooltipDiv);
  }

  // ---------- 浮动控制条 ----------
  function createControlBar() {
    if (controlBarDiv) return;
    controlBarDiv = document.createElement('div');
    controlBarDiv.id = 'mch-picker-controls';
    controlBarDiv.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 1000002;
      display: flex;
      gap: 6px;
      padding: 6px;
      background: rgba(0,0,0,0.85);
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      font-family: system-ui, sans-serif;
      user-select: none;
    `;

    const btnBase = `
      width: 38px;
      height: 38px;
      border: none;
      border-radius: 6px;
      background: rgba(255,255,255,0.18);
      color: #fff;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
    `;

    statusEl = document.createElement('span');
    statusEl.id = 'mch-picker-status';
    statusEl.style.cssText = `
      color: #fff;
      font-size: 12px;
      padding: 0 8px;
      max-width: 280px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      align-self: center;
    `;

    pauseBtn = document.createElement('button');
    pauseBtn.id = 'mch-picker-pause';
    pauseBtn.textContent = '⏸';
    pauseBtn.title = '暂停拾取（空格）';
    pauseBtn.style.cssText = btnBase;

    cancelBtn = document.createElement('button');
    cancelBtn.id = 'mch-picker-cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.title = '退出拾取（ESC）';
    cancelBtn.style.cssText = btnBase;

    // pointerdown 先关闭任何原生弹窗（如 select 下拉），避免首击被弹窗关闭吞掉
    const closeNativePopup = () => {
      const ae = document.activeElement;
      if (ae && typeof ae.blur === 'function') ae.blur();
    };

    pauseBtn.addEventListener('pointerdown', closeNativePopup);
    cancelBtn.addEventListener('pointerdown', closeNativePopup);
    pauseBtn.addEventListener('click', () => togglePause());
    cancelBtn.addEventListener('click', () => {
      deactivate();
      chrome.runtime.sendMessage({ type: 'pickerCancel' });
    });

    controlBarDiv.appendChild(statusEl);
    controlBarDiv.appendChild(pauseBtn);
    controlBarDiv.appendChild(cancelBtn);
    document.body.appendChild(controlBarDiv);
  }

  function updateControlBarStatus() {
    if (!statusEl) return;
    let text = '';
    if (paused) {
      text = '⏸ 已暂停 · 空格/▶ 继续';
    } else if (locked) {
      text = '✅ 已锁定 · Enter 确认 · ESC 取消';
    } else if (continuousMode) {
      text = `🔄 连续拾取 ${pickCount} 个 · 点击锁定 · Enter 继续 · 空格暂停`;
    } else {
      text = '🎯 点击锁定目标 · Enter 确认';
    }
    statusEl.textContent = text;
  }

  function removeControlBar() {
    if (controlBarDiv) {
      controlBarDiv.remove();
      controlBarDiv = null;
    }
    statusEl = null;
    pauseBtn = null;
    cancelBtn = null;
  }

  function togglePause() {
    if (locked) return;
    paused = !paused;
    if (highlightDiv) {
      if (paused) {
        highlightDiv.style.borderColor = '#888';
        highlightDiv.style.background = 'rgba(136, 136, 136, 0.1)';
      } else {
        highlightDiv.style.borderColor = '#1a73e8';
        highlightDiv.style.background = 'rgba(26, 115, 232, 0.15)';
        const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        if (el) {
          highlightedElement = el;
          updateHighlight(el);
        }
      }
    }
    if (pauseBtn) {
      pauseBtn.textContent = paused ? '▶' : '⏸';
      pauseBtn.title = paused ? '继续拾取' : '暂停拾取（空格）';
    }
    updateTooltipText();
  }

  // ---------- 高亮与提示 ----------
  function updateHighlight(element) {
    if (!element || !highlightDiv) return;
    const rect = element.getBoundingClientRect();
    highlightDiv.style.left = rect.left + 'px';
    highlightDiv.style.top = rect.top + 'px';
    highlightDiv.style.width = rect.width + 'px';
    highlightDiv.style.height = rect.height + 'px';
    highlightDiv.style.display = 'block';

    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    
    let cls = '';
    try {
      const raw = element.className;
      let str = '';
      if (typeof raw === 'string') str = raw;
      else if (raw && raw.baseVal !== undefined) str = raw.baseVal;
      else if (raw && raw.toString) str = raw.toString();
      if (str) cls = `.${str.split(' ')[0]}`;
    } catch (_) {}

    const text = element.textContent.trim().slice(0, 30);
    tooltipDiv.textContent = `${tag}${id}${cls}${text ? ': ' + text : ''}`;
    tooltipDiv.style.left = (rect.left + 10) + 'px';
    tooltipDiv.style.top = (rect.top - 28) + 'px';
    tooltipDiv.style.display = 'block';
  }

  function clearHighlight() {
    if (highlightDiv) highlightDiv.style.display = 'none';
    if (tooltipDiv) tooltipDiv.style.display = 'none';
    highlightedElement = null;
  }

  function updateTooltipText() {
    if (!tooltipDiv) return;
    let text = '';
    if (paused) {
      text = '⏸️ 已暂停，点击页面展开菜单（空格 / ▶ 按钮继续）';
    } else if (locked) {
      text = '✅ 已锁定，方向键微调 (±1px) | Enter确认 | ESC取消';
    } else if (continuousMode) {
      text = `🔄 连续模式 (已拾取 ${pickCount} 个) | 悬停点击锁定，Enter继续，ESC结束，空格暂停`;
    } else {
      text = '🖱️ 悬停目标元素，点击锁定';
    }
    tooltipDiv.textContent = text;
    if (!paused && !locked) {
      tooltipDiv.style.left = '20px';
      tooltipDiv.style.top = '20px';
      tooltipDiv.style.display = 'block';
    }
    updateControlBarStatus();
  }

  // ---------- 激活与停用 ----------
  function deactivate() {
    if (overlayDiv) {
      overlayDiv.remove();
      overlayDiv = null;
    }
    if (highlightDiv) {
      highlightDiv.remove();
      highlightDiv = null;
    }
    if (tooltipDiv) {
      tooltipDiv.remove();
      tooltipDiv = null;
    }
    removeControlBar();
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('click', onMouseClick, true);
    document.removeEventListener('keydown', onKeyDown);
    isActive = false;
    paused = false;
    continuousMode = false;
    locked = false;
    pickCount = 0;
  }

  function activate(continuous = false) {
    if (isActive) {
      deactivate();
    }
    continuousMode = continuous;
    paused = false;
    pickCount = 0;
    isActive = true;
    createOverlay();
    createHighlight();
    createTooltip();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('click', onMouseClick, true);
    document.addEventListener('keydown', onKeyDown);
    createControlBar();
    updateTooltipText();
    tooltipDiv.style.left = '20px';
    tooltipDiv.style.top = '20px';
    tooltipDiv.style.display = 'block';
    chrome.runtime.sendMessage({
      type: 'log',
      payload: {
        level: 'INFO',
        tag: '[Picker]',
        message: `拾取器已激活${continuous ? ' (连续模式)' : ''}`
      }
    });
  }

  // ---------- 鼠标事件 ----------
  let rafPending = false;
  function onMouseMove(e) {
    if (paused || locked) return;
    if (rafPending) return;
    rafPending = true;
    const clientX = e.clientX;
    const clientY = e.clientY;
    requestAnimationFrame(() => {
      rafPending = false;
      const el = document.elementFromPoint(clientX, clientY);
      if (el && el !== overlayDiv && el !== highlightDiv && el !== tooltipDiv && el !== controlBarDiv && el !== pauseBtn && el !== cancelBtn) {
        highlightedElement = el;
        updateHighlight(el);
      } else {
        clearHighlight();
      }
    });
  }

  function onMouseClick(e) {
  if (paused) return;
  // 点击控制条（暂停/退出按钮）时放行，交由按钮处理
  if (e.target === controlBarDiv || e.target === pauseBtn || e.target === cancelBtn) return;
  e.preventDefault();
  e.stopPropagation();
  if (locked) return;

  // 调试日志
  console.log('[Picker] onMouseClick triggered, highlightedElement:', highlightedElement);

  let targetEl = highlightedElement;
  
  // 如果 highlightedElement 不存在，尝试使用 e.target
  if (!targetEl) {
    console.warn('[Picker] highlightedElement is null, using e.target');
    targetEl = e.target;
  }

  // 如果目标元素是遮罩或高亮框本身，忽略
  if (targetEl === overlayDiv || targetEl === highlightDiv || targetEl === tooltipDiv) {
    console.warn('[Picker] target is overlay/highlight, ignoring');
    return;
  }

  // 尝试获取矩形，如果失败则退出
  let rect;
  try {
    rect = targetEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      console.warn('[Picker] element has zero size, trying to find parent');
      // 尝试查找父元素
      let parent = targetEl.parentElement;
      while (parent && parent !== document.body) {
        const pRect = parent.getBoundingClientRect();
        if (pRect.width > 0 && pRect.height > 0) {
          rect = pRect;
          targetEl = parent;
          break;
        }
        parent = parent.parentElement;
      }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        console.warn('[Picker] cannot get valid rect, ignoring');
        return;
      }
    }
  } catch (err) {
    console.error('[Picker] getBoundingClientRect error:', err);
    return;
  }

  // 锁定逻辑
  locked = true;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const centerX = rect.left + rect.width/2;
  const centerY = rect.top + rect.height/2;
  const docX = centerX + scrollX;
  const docY = centerY + scrollY;
  const offsetX = centerX - rect.left;
  const offsetY = centerY - rect.top;

  targetData = {
    documentX: Math.round(docX),
    documentY: Math.round(docY),
    snapshotScrollX: scrollX,
    snapshotScrollY: scrollY,
    elementRect: {
      left: rect.left + scrollX,
      top: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
    },
    clickOffsetX: Math.round(offsetX),
    clickOffsetY: Math.round(offsetY),
  };

  highlightDiv.style.borderColor = '#0f9d58';
  highlightDiv.style.background = 'rgba(15, 157, 88, 0.2)';
  updateTooltipText();
  tooltipDiv.style.left = (rect.left + 10) + 'px';
  tooltipDiv.style.top = (rect.top - 28) + 'px';
  tooltipDiv.style.display = 'block';

  console.log('[Picker] locked, targetData:', targetData);
}

  // ---------- 键盘事件 ----------
  function onKeyDown(e) {
    const isSpace = (e.key === ' ' || e.key === 'Space');

    // 暂停时：页面正常接收键盘输入，仅拦截非文本控件上的空格用于继续拾取
    if (paused) {
      if (!isSpace) return;
      const ae = document.activeElement;
      const isEditable = ae && (
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable
      );
      if (isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      togglePause();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // 空格键：暂停/继续
    if (isSpace) {
      togglePause();
      return;
    }

    // ESC 键：取消锁定 或 退出拾取器
    if (e.key === 'Escape') {
      if (locked) {
        // 取消锁定，回到悬停状态
        locked = false;
        if (highlightDiv) {
          highlightDiv.style.borderColor = '#1a73e8';
          highlightDiv.style.background = 'rgba(26, 115, 232, 0.15)';
        }
        targetData = null;
        updateTooltipText();
      } else {
        // 未锁定，直接退出拾取器
        deactivate();
        chrome.runtime.sendMessage({ type: 'pickerCancel' });
      }
      return;
    }

    if (!locked) return;

    // Enter 键：确认
    if (e.key === 'Enter') {
      chrome.runtime.sendMessage({
        type: 'pickerConfirm',
        payload: targetData
      });
      pickCount++;
      if (continuousMode) {
        locked = false;
        highlightedElement = null;
        clearHighlight();
        if (highlightDiv) {
          highlightDiv.style.borderColor = '#1a73e8';
          highlightDiv.style.background = 'rgba(26, 115, 232, 0.15)';
        }
        updateTooltipText();
        tooltipDiv.style.left = '20px';
        tooltipDiv.style.top = '20px';
        tooltipDiv.style.display = 'block';
      } else {
        deactivate();
      }
      return;
    }

    // 方向键微调
    let deltaX = 0, deltaY = 0;
    if (e.key === 'ArrowLeft') deltaX = -1;
    else if (e.key === 'ArrowRight') deltaX = 1;
    else if (e.key === 'ArrowUp') deltaY = -1;
    else if (e.key === 'ArrowDown') deltaY = 1;
    else return;

    targetData.clickOffsetX += deltaX;
    targetData.clickOffsetY += deltaY;
    const rect = targetData.elementRect;
    targetData.documentX = Math.round(rect.left + targetData.clickOffsetX);
    targetData.documentY = Math.round(rect.top + targetData.clickOffsetY);
    tooltipDiv.textContent = `📍 偏移 (${targetData.clickOffsetX}, ${targetData.clickOffsetY}) → 坐标 (${targetData.documentX}, ${targetData.documentY})`;
  }

  // ---------- 页面 Toast ----------
  function showPageToast(text) {
    const existing = document.querySelector('.mch-page-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'mch-page-toast';
    toast.textContent = text;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.8)',
      color: '#fff',
      padding: '8px 20px',
      borderRadius: '6px',
      fontSize: '14px',
      zIndex: '999999',
      boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
      transition: 'opacity 0.3s',
      opacity: '1'
    });
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ---------- 区域监控拖选 ----------
  let regionMode = false;
  let dragStart = null;
  let dragRectDiv = null;
  let regionPanelDiv = null;
  let lastRegion = null;

  function createDragRect() {
    if (dragRectDiv) return;
    dragRectDiv = document.createElement('div');
    dragRectDiv.id = 'mch-picker-region-rect';
    dragRectDiv.style.cssText = `
      position: fixed;
      border: 2px dashed #ff9800;
      background: rgba(255, 152, 0, 0.15);
      pointer-events: none;
      z-index: 1000001;
      display: none;
    `;
    document.body.appendChild(dragRectDiv);
  }

  function updateDragRect() {
    if (!dragStart || !dragRectDiv) return;
    const x = Math.min(dragStart.x, lastRegion.x);
    const y = Math.min(dragStart.y, lastRegion.y);
    dragRectDiv.style.left = x + 'px';
    dragRectDiv.style.top = y + 'px';
    dragRectDiv.style.width = Math.abs(lastRegion.w) + 'px';
    dragRectDiv.style.height = Math.abs(lastRegion.h) + 'px';
    dragRectDiv.style.display = 'block';
  }

  function onRegionPointerDown(e) {
    if (!regionMode) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart = { x: e.clientX, y: e.clientY };
    lastRegion = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    updateDragRect();
    document.addEventListener('pointermove', onRegionPointerMove, true);
    document.addEventListener('pointerup', onRegionPointerUp, true);
  }

  function onRegionPointerMove(e) {
    if (!regionMode || !dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    lastRegion = {
      x: Math.min(dragStart.x, e.clientX),
      y: Math.min(dragStart.y, e.clientY),
      w: Math.abs(e.clientX - dragStart.x),
      h: Math.abs(e.clientY - dragStart.y)
    };
    updateDragRect();
  }

  function onRegionPointerUp(e) {
    if (!regionMode || !dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    document.removeEventListener('pointermove', onRegionPointerMove, true);
    document.removeEventListener('pointerup', onRegionPointerUp, true);
    if (lastRegion && lastRegion.w >= 10 && lastRegion.h >= 10) {
      dragStart = null;
      if (dragRectDiv) dragRectDiv.style.borderStyle = 'solid';
      showRegionPanel();
    } else {
      dragStart = null;
      if (dragRectDiv) dragRectDiv.style.display = 'none';
      showPageToast('区域太小，请重新拖选（至少 10×10）');
    }
  }

  function createRegionPanel() {
    if (regionPanelDiv) return;
    regionPanelDiv = document.createElement('div');
    regionPanelDiv.id = 'mch-region-panel';
    regionPanelDiv.style.cssText = `
      position: fixed;
      top: 20px; right: 20px;
      width: 260px;
      z-index: 1000002;
      background: rgba(255,255,255,0.97);
      color: #222;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      padding: 14px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      user-select: none;
      display: none;
    `;
    regionPanelDiv.innerHTML = `
      <div style="font-weight:600;margin-bottom:10px;">区域监控配置</div>
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:2px;">名称</label>
        <input id="mch-rp-name" value="监控区域" style="width:100%;box-sizing:border-box;padding:4px 6px;"/>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:2px;">间隔（秒）</label>
        <input id="mch-rp-interval" type="number" min="0.5" step="0.5" value="1" style="width:100%;box-sizing:border-box;padding:4px 6px;"/>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:2px;">阈值模式</label>
        <select id="mch-rp-mode" style="width:100%;padding:4px 6px;">
          <option value="exact">精确值（上/下限）</option>
          <option value="percent">百分比（相对基准）</option>
        </select>
      </div>
      <div id="mch-rp-exact" style="margin-bottom:8px;">
        <div style="display:flex;gap:6px;">
          <div style="flex:1;"><label style="display:block;margin-bottom:2px;">上限</label><input id="mch-rp-upper" type="number" value="150" style="width:100%;box-sizing:border-box;padding:4px 6px;"/></div>
          <div style="flex:1;"><label style="display:block;margin-bottom:2px;">下限</label><input id="mch-rp-lower" type="number" value="50" style="width:100%;box-sizing:border-box;padding:4px 6px;"/></div>
        </div>
      </div>
      <div id="mch-rp-percent" style="margin-bottom:8px;display:none;">
        <div style="display:flex;gap:6px;">
          <div style="flex:1;"><label style="display:block;margin-bottom:2px;">基准</label><input id="mch-rp-target" type="number" value="100" style="width:100%;box-sizing:border-box;padding:4px 6px;"/></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <div style="flex:1;"><label style="display:block;margin-bottom:2px;">高于 %</label><input id="mch-rp-up" type="number" value="110" style="width:100%;box-sizing:border-box;padding:4px 6px;"/></div>
          <div style="flex:1;"><label style="display:block;margin-bottom:2px;">低于 %</label><input id="mch-rp-down" type="number" value="90" style="width:100%;box-sizing:border-box;padding:4px 6px;"/></div>
        </div>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:2px;">提醒方式</label>
        <select id="mch-rp-way" style="width:100%;padding:4px 6px;">
          <option value="both">通知 + 声音</option>
          <option value="notification">仅通知</option>
          <option value="sound">仅声音</option>
        </select>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:2px;">冷却（秒）</label>
        <input id="mch-rp-cooldown" type="number" min="0" value="60" style="width:100%;box-sizing:border-box;padding:4px 6px;"/>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;margin-bottom:2px;">解析方式</label>
        <select id="mch-rp-parse" style="width:100%;padding:4px 6px;">
          <option value="number">数字（比较阈值）</option>
          <option value="text">文本（仅记录）</option>
        </select>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button id="mch-rp-redo" style="padding:5px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">重新选择</button>
        <button id="mch-rp-cancel" style="padding:5px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">取消</button>
        <button id="mch-rp-ok" style="padding:5px 12px;border:none;border-radius:6px;background:#1a73e8;color:#fff;cursor:pointer;">添加监控</button>
      </div>
    `;
    regionPanelDiv.querySelector('#mch-rp-mode').addEventListener('change', () => {
      const percent = regionPanelDiv.querySelector('#mch-rp-mode').value === 'percent';
      regionPanelDiv.querySelector('#mch-rp-exact').style.display = percent ? 'none' : '';
      regionPanelDiv.querySelector('#mch-rp-percent').style.display = percent ? '' : 'none';
    });
    regionPanelDiv.querySelector('#mch-rp-redo').addEventListener('click', () => {
      regionPanelDiv.style.display = 'none';
      dragStart = null;
      if (dragRectDiv) {
        dragRectDiv.style.display = 'none';
        dragRectDiv.style.borderStyle = 'dashed';
      }
      lastRegion = null;
      showPageToast('请重新拖选监控区域');
    });
    regionPanelDiv.querySelector('#mch-rp-cancel').addEventListener('click', () => {
      regionPanelDiv.style.display = 'none';
      exitRegionMode();
    });
    regionPanelDiv.querySelector('#mch-rp-ok').addEventListener('click', () => {
      const q = (id) => regionPanelDiv.querySelector(id);
      const mode = q('#mch-rp-mode').value;
      const thresholds = mode === 'percent'
        ? { mode: 'percent', target: Number(q('#mch-rp-target').value), percentUp: Number(q('#mch-rp-up').value), percentDown: Number(q('#mch-rp-down').value) }
        : { mode: 'exact', upper: Number(q('#mch-rp-upper').value), lower: Number(q('#mch-rp-lower').value) };
      const config = {
        name: q('#mch-rp-name').value || '监控区域',
        intervalSec: Math.max(0.5, Number(q('#mch-rp-interval').value) || 1),
        thresholds,
        alert: { way: q('#mch-rp-way').value, cooldownSec: Math.max(0, Number(q('#mch-rp-cooldown').value) || 0) },
        parse: q('#mch-rp-parse').value
      };
      chrome.runtime.sendMessage({
        type: 'pickerRegionConfirm',
        payload: { region: lastRegion, scale: window.devicePixelRatio || 1, config }
      });
      showPageToast(`✅ 已添加监控 "${config.name}"`);
      exitRegionMode();
    });
    document.body.appendChild(regionPanelDiv);
  }

  function showRegionPanel() {
    createRegionPanel();
    regionPanelDiv.style.display = 'block';
  }

  function exitRegionMode() {
    regionMode = false;
    dragStart = null;
    lastRegion = null;
    if (dragRectDiv) { dragRectDiv.remove(); dragRectDiv = null; }
    if (regionPanelDiv) { regionPanelDiv.remove(); regionPanelDiv = null; }
    document.removeEventListener('pointerdown', onRegionPointerDown, true);
    document.removeEventListener('keydown', onRegionKeyDown, true);
    deactivate();
  }

  function onRegionKeyDown(e) {
    if (!regionMode) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exitRegionMode();
      chrome.runtime.sendMessage({ type: 'pickerCancel' });
    }
  }

  function activateRegionMode() {
    if (isActive) deactivate();
    regionMode = true;
    isActive = true;
    createOverlay();
    createDragRect();
    showPageToast('按住鼠标左键拖选监控区域，松开后配置阈值');
    document.addEventListener('pointerdown', onRegionPointerDown, true);
    document.addEventListener('keydown', onRegionKeyDown, true);
    chrome.runtime.sendMessage({
      type: 'log',
      payload: { level: 'INFO', tag: '[Picker]', message: '区域拖选已激活' }
    });
  }

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'showToast') {
      showPageToast(msg.payload.message);
      sendResponse({ success: true });
      return false;
    }
    if (msg.type === 'startPicker') {
      const continuous = msg.payload?.continuous || false;
      activate(continuous);
      sendResponse({ success: true });
      return false;
    }
    if (msg.type === 'stopPicker') {
      deactivate();
      sendResponse({ success: true });
      return false;
    }
    if (msg.type === 'startPickRegion') {
      activateRegionMode();
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  console.log('[Picker] 已加载，等待 startPicker 消息');
})();