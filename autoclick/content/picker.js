// content/picker.js
// 可视化坐标拾取器（自包含，通过消息控制）

(function() {
  if (window.__picker_initialized) return;
  window.__picker_initialized = true;

  let isActive = false;
  let highlightedElement = null;
  let highlightDiv = null;
  let overlayDiv = null;
  let tooltipDiv = null;
  let locked = false;
  let targetData = null;

  // 创建遮罩
  function createOverlay() {
    if (overlayDiv) return;
    overlayDiv = document.createElement('div');
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
    const cls = element.className ? `.${element.className.split(' ')[0]}` : '';
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

  function deactivate() {
    if (overlayDiv) overlayDiv.remove();
    if (highlightDiv) highlightDiv.remove();
    if (tooltipDiv) tooltipDiv.remove();
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('click', onMouseClick, true);
    document.removeEventListener('keydown', onKeyDown);
    isActive = false;
    window.__picker_initialized = false;
  }

  function onMouseMove(e) {
    if (locked) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== overlayDiv && el !== highlightDiv && el !== tooltipDiv) {
      highlightedElement = el;
      updateHighlight(el);
    } else {
      clearHighlight();
    }
  }

  function onMouseClick(e) {
    if (locked) return;
    if (!highlightedElement) {
      deactivate();
      chrome.runtime.sendMessage({ type: 'pickerCancel' });
      return;
    }
    locked = true;
    const el = highlightedElement;
    const rect = el.getBoundingClientRect();
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
    tooltipDiv.textContent = '✅ 已锁定，方向键微调 (±1px) | Enter确认 | ESC取消';
    tooltipDiv.style.left = (rect.left + 10) + 'px';
    tooltipDiv.style.top = (rect.top - 28) + 'px';
    tooltipDiv.style.display = 'block';
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeyDown(e) {
    if (!locked) return;
    if (e.key === 'Escape') {
      locked = false;
      highlightDiv.style.borderColor = '#1a73e8';
      highlightDiv.style.background = 'rgba(26, 115, 232, 0.15)';
      tooltipDiv.textContent = '🔄 请重新悬停目标元素，点击锁定';
      return;
    }
    if (e.key === 'Enter') {
      chrome.runtime.sendMessage({ type: 'pickerConfirm', payload: targetData });
      deactivate();
      return;
    }
    let deltaX = 0, deltaY = 0;
    if (e.key === 'ArrowLeft') deltaX = -1;
    else if (e.key === 'ArrowRight') deltaX = 1;
    else if (e.key === 'ArrowUp') deltaY = -1;
    else if (e.key === 'ArrowDown') deltaY = 1;
    else return;
    e.preventDefault();
    targetData.clickOffsetX += deltaX;
    targetData.clickOffsetY += deltaY;
    const rect = targetData.elementRect;
    targetData.documentX = Math.round(rect.left + targetData.clickOffsetX);
    targetData.documentY = Math.round(rect.top + targetData.clickOffsetY);
    tooltipDiv.textContent = `📍 偏移 (${targetData.clickOffsetX}, ${targetData.clickOffsetY}) → 坐标 (${targetData.documentX}, ${targetData.documentY})`;
  }

  function activate() {
    if (isActive) return;
    isActive = true;
    createOverlay();
    createHighlight();
    createTooltip();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('click', onMouseClick, true);
    document.addEventListener('keydown', onKeyDown);
    tooltipDiv.textContent = '🖱️ 悬停目标元素，点击锁定';
    tooltipDiv.style.left = '20px';
    tooltipDiv.style.top = '20px';
    tooltipDiv.style.display = 'block';
    chrome.runtime.sendMessage({ type: 'log', payload: { level: 'INFO', tag: '[Picker]', message: '拾取器已激活' } });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'startPicker') {
      activate();
      sendResponse({ success: true });
    } else if (msg.type === 'stopPicker') {
      deactivate();
      sendResponse({ success: true });
    }
  });

  console.log('[Picker] 已加载，等待 startPicker 消息');
})();