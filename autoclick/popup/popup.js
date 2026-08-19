// popup/popup.js
import { getScripts, deleteScript, setDefaultScriptId, getDefaultScriptId, saveScript, exportScripts, importScripts } from '../utils/storage.js';
import { log, getLogs, clearLogs } from '../utils/logger.js';
import { escapeHtml } from '../utils/escape.js';

// DOM
const scriptListEl = document.getElementById('script-list');
const editorDiv = document.getElementById('editor');
const editNameEl = document.getElementById('edit-script-name');
const actionListEl = document.getElementById('action-list');
const addDelayBtn = document.getElementById('add-delay');
const delayInput = document.getElementById('delay-input');
const addClickBtn = document.getElementById('add-click');
const saveEditorBtn = document.getElementById('save-editor');
const cancelEditorBtn = document.getElementById('cancel-editor');
const btnNew = document.getElementById('btn-new');
const newScriptRow = document.getElementById('new-script-row');
const newScriptInput = document.getElementById('new-script-input');
const newScriptOk = document.getElementById('new-script-ok');
const newScriptCancel = document.getElementById('new-script-cancel');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const btnLogs = document.getElementById('btn-logs');
const btnClearLogs = document.getElementById('btn-clear-logs');
const logsPanel = document.getElementById('logs-panel');
const logsContent = document.getElementById('logs-content');
const logsClose = document.getElementById('logs-close');
const runStatus = document.getElementById('run-status');
const runName = document.getElementById('run-name');
const runProgress = document.getElementById('run-progress');
const runProgressBar = document.getElementById('run-progress-bar');
const runRemaining = document.getElementById('run-remaining');
const runPause = document.getElementById('run-pause');
const runStop = document.getElementById('run-stop');

let currentEditingId = null;
let editingActions = [];
let dragIndex = null;
let renamingId = null;
let confirmingDeleteId = null;
let running = null;
let runPollTimer = null;

// ---------- Toast ----------
function showToast(text) {
  const existing = document.querySelector('.mch-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'mch-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ---------- 运行状态条 ----------
async function refreshRunningState() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'getRunningState' });
  } catch (e) {
    return;
  }
  if (res && res.success && res.running) {
    running = res;
    runStatus.style.display = 'flex';
    runName.textContent = res.scriptName;
    runProgress.textContent = `${res.currentIndex}/${res.totalSteps}`;
    const pct = res.totalSteps > 0 ? Math.round(res.currentIndex / res.totalSteps * 100) : 0;
    runProgressBar.style.width = pct + '%';
    runPause.textContent = res.paused ? '▶ 继续' : '⏸ 暂停';
    runRemaining.textContent = res.paused ? '⏸ 已暂停' : '执行中...';
  } else {
    running = null;
    runStatus.style.display = 'none';
  }
}

runPause.addEventListener('click', async () => {
  if (!running) return;
  const msg = await chrome.runtime.sendMessage({ type: running.paused ? 'resumeScript' : 'pauseScript' });
  if (msg && !msg.success) {
    showToast(msg.error || '操作失败');
    return;
  }
  await refreshRunningState();
});

runStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stopScript' }).catch(() => {});
  running = null;
  runStatus.style.display = 'none';
  showToast('脚本已停止');
});

// ---------- 保存与重载 ----------
async function saveCurrentScript() {
  if (!currentEditingId) return;
  const scripts = await getScripts();
  const script = scripts.find(s => s.id === currentEditingId);
  if (script) {
    script.actions = editingActions;
    await saveScript(script);
  }
}

async function reloadEditingActions(scriptId) {
  const scripts = await getScripts();
  const script = scripts.find(s => s.id === scriptId);
  if (script) {
    editingActions = JSON.parse(JSON.stringify(script.actions || []));
    renderActions();
  }
}

// ---------- 渲染动作列表 ----------
function renderActions() {
  if (!actionListEl) return;
  if (editingActions.length === 0) {
    actionListEl.innerHTML = '<div style="color:#999;padding:8px;text-align:center;">暂无动作，请添加</div>';
    return;
  }
  let html = '';
  editingActions.forEach((action, index) => {
    let desc = '';
    if (action.type === 'delay') {
      desc = `⏱️ 延迟 ${escapeHtml(action.value)}ms`;
    } else if (action.type === 'click') {
      const t = action.target;
      desc = `🖱️ 点击 (${escapeHtml(t.documentX)}, ${escapeHtml(t.documentY)})`;
    } else {
      desc = `❓ ${escapeHtml(action.type)}`;
    }
    html += `
      <div class="action-item" draggable="true" data-index="${index}">
        <span class="action-info">${index + 1}. ${desc}</span>
        <span class="action-ops">
          <button class="op-btn" data-act="up" data-index="${index}" title="上移">↑</button>
          <button class="op-btn" data-act="down" data-index="${index}" title="下移">↓</button>
          <button class="op-btn danger" data-act="del" data-index="${index}" title="删除">✕</button>
        </span>
      </div>
    `;
  });
  actionListEl.innerHTML = html;

  actionListEl.querySelectorAll('.action-item').forEach(item => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
  });
}

// ---------- 拖拽处理 ----------
function handleDragStart(e) {
  dragIndex = parseInt(this.dataset.index);
  this.style.opacity = '0.4';
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.style.border = '2px dashed #1a73e8';
}

function handleDragLeave(e) {
  this.style.border = '';
}

function handleDrop(e) {
  e.preventDefault();
  this.style.border = '';
  const dropIndex = parseInt(this.dataset.index);
  if (dragIndex !== null && dragIndex !== dropIndex) {
    const [removed] = editingActions.splice(dragIndex, 1);
    editingActions.splice(dropIndex, 0, removed);
    renderActions();
    saveCurrentScript();
  }
  dragIndex = null;
}

// ---------- 编辑器 ----------
async function openEditor(scriptId) {
  const scripts = await getScripts();
  const script = scripts.find(s => s.id === scriptId);
  if (!script) return;
  currentEditingId = scriptId;
  editingActions = JSON.parse(JSON.stringify(script.actions || []));
  editNameEl.textContent = `编辑: ${script.name}`;
  renderActions();
  editorDiv.style.display = 'block';
}

function closeEditor() {
  currentEditingId = null;
  editingActions = [];
  editorDiv.style.display = 'none';
}

// ---------- 渲染脚本列表 ----------
async function renderScriptList() {
  const scripts = await getScripts();
  const defaultId = await getDefaultScriptId();
  if (scripts.length === 0) {
    scriptListEl.innerHTML = '<div style="color:#999;padding:12px;text-align:center;">暂无脚本，请新建或导入</div>';
    return;
  }
  let html = '';
  for (const s of scripts) {
    const isDefault = s.id === defaultId;
    const actionsCount = (s.actions || []).length;
    if (renamingId === s.id) {
      html += `
        <div class="script-item">
          <span class="rename-row">
            <input id="rename-input" type="text" value="${escapeHtml(s.name || '')}">
            <button id="rename-ok" class="primary">✓</button>
            <button id="rename-cancel">✕</button>
          </span>
        </div>`;
    } else if (confirmingDeleteId === s.id) {
      html += `
        <div class="script-item">
          <span class="confirm-row">确定删除「${escapeHtml(s.name || '未命名')}」？</span>
          <span class="confirm-row">
            <button id="confirm-del-yes" class="danger">删除</button>
            <button id="confirm-del-no">取消</button>
          </span>
        </div>`;
    } else {
      html += `
        <div class="script-item">
          <span class="script-name" data-id="${s.id}" title="点击重命名">${isDefault ? '⭐ ' : ''}${escapeHtml(s.name || '未命名')} <span style="color:#bbb;font-size:11px;">(${actionsCount})</span></span>
          <span class="script-actions">
            <button class="edit-btn" data-id="${s.id}" title="编辑">✏️</button>
            <button class="run-btn" data-id="${s.id}" title="运行">▶</button>
            <button class="default-btn" data-id="${s.id}" title="${isDefault ? '默认脚本' : '设为默认'}">${isDefault ? '⭐' : '☆'}</button>
            <button class="del-btn" data-id="${s.id}" title="删除">🗑</button>
          </span>
        </div>`;
    }
  }
  scriptListEl.innerHTML = html;

  // 重命名行绑定
  const renameInput = document.getElementById('rename-input');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    const commitRename = async () => {
      const name = renameInput.value.trim();
      const scripts = await getScripts();
      const script = scripts.find(x => x.id === renamingId);
      if (script && name) {
        script.name = name;
        await saveScript(script);
        if (currentEditingId === renamingId) {
          editNameEl.textContent = `编辑: ${script.name}`;
        }
      }
      renamingId = null;
      renderScriptList();
    };
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      else if (e.key === 'Escape') { renamingId = null; renderScriptList(); }
    });
    document.getElementById('rename-ok').addEventListener('click', commitRename);
    document.getElementById('rename-cancel').addEventListener('click', () => {
      renamingId = null;
      renderScriptList();
    });
  }
}

// ---------- 脚本列表事件（委托） ----------
scriptListEl.addEventListener('click', async (e) => {
  const delYes = e.target.closest('#confirm-del-yes');
  if (delYes) {
    const id = confirmingDeleteId;
    confirmingDeleteId = null;
    await deleteScript(id);
    if (currentEditingId === id) closeEditor();
    showToast('已删除');
    renderScriptList();
    return;
  }
  const delNo = e.target.closest('#confirm-del-no');
  if (delNo) {
    confirmingDeleteId = null;
    renderScriptList();
    return;
  }

  const btn = e.target.closest('button');
  if (!btn) {
    const nameEl = e.target.closest('.script-name');
    if (nameEl) {
      renamingId = nameEl.dataset.id;
      renderScriptList();
    }
    return;
  }
  const id = btn.dataset.id;
  if (!id) return;

  if (btn.classList.contains('run-btn')) {
    const scripts = await getScripts();
    const script = scripts.find(s => s.id === id);
    if (!script) { showToast('脚本不存在'); return; }
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'runScript',
        payload: { scriptId: id, scriptData: script }
      });
      if (response && !response.success) {
        showToast('执行失败: ' + response.error);
      } else {
        window.close();
      }
    } catch (err) {
      if (!err.message?.includes('port closed') && !err.message?.includes('Receiving end')) {
        showToast('执行失败: ' + err.message);
      }
    }
    return;
  }

  if (btn.classList.contains('edit-btn')) {
    await openEditor(id);
    return;
  }

  if (btn.classList.contains('default-btn')) {
    await setDefaultScriptId(id);
    renderScriptList();
    return;
  }

  if (btn.classList.contains('del-btn')) {
    confirmingDeleteId = id;
    renderScriptList();
  }
});

// ---------- 动作列表操作（委托） ----------
actionListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.op-btn');
  if (!btn) return;
  const idx = parseInt(btn.dataset.index);
  const act = btn.dataset.act;
  if (act === 'up' && idx > 0) {
    const [item] = editingActions.splice(idx, 1);
    editingActions.splice(idx - 1, 0, item);
  } else if (act === 'down' && idx < editingActions.length - 1) {
    const [item] = editingActions.splice(idx, 1);
    editingActions.splice(idx + 1, 0, item);
  } else if (act === 'del') {
    editingActions.splice(idx, 1);
  } else {
    return;
  }
  renderActions();
  await saveCurrentScript();
});

// ---------- 新建脚本 ----------
btnNew.addEventListener('click', () => {
  newScriptRow.style.display = 'flex';
  newScriptInput.value = '';
  newScriptInput.focus();
});

newScriptCancel.addEventListener('click', () => {
  newScriptRow.style.display = 'none';
});

newScriptOk.addEventListener('click', async () => {
  const name = newScriptInput.value.trim() || '未命名脚本';
  const newScript = {
    id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name,
    actions: []
  };
  await saveScript(newScript);
  newScriptRow.style.display = 'none';
  await renderScriptList();
  await openEditor(newScript.id);
  showToast('已创建脚本');
});

newScriptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') newScriptOk.click();
  else if (e.key === 'Escape') newScriptCancel.click();
});

// ---------- 编辑操作 ----------
addDelayBtn.addEventListener('click', async () => {
  const val = parseInt(delayInput.value);
  if (isNaN(val) || val < 0) {
    showToast('请输入有效的毫秒数');
    return;
  }
  editingActions.push({ type: 'delay', value: val });
  renderActions();
  await saveCurrentScript();
});

addClickBtn.addEventListener('click', async () => {
  if (!currentEditingId) {
    showToast('请先创建或打开一个脚本进行编辑');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showToast('未找到活动标签页，请打开一个网页');
    return;
  }

  const continuous = document.getElementById('continuous-mode').checked;

  await chrome.runtime.sendMessage({
    type: 'preparePicker',
    payload: { scriptId: currentEditingId, continuous }
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/picker.js'],
    });
  } catch (err) {
    showToast('拾取器注入失败，请刷新页面后重试');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'startPicker',
      payload: { continuous }
    });
  } catch (err) {
    showToast('启动拾取器失败，请刷新页面后重试');
  }
});

saveEditorBtn.addEventListener('click', async () => {
  if (!currentEditingId) return;
  const scripts = await getScripts();
  const script = scripts.find(s => s.id === currentEditingId);
  if (!script) return;
  script.actions = editingActions;
  await saveScript(script);
  closeEditor();
  renderScriptList();
  log('INFO', '[POPUP]', `脚本 "${script.name}" 已保存`);
  showToast('已保存');
});

cancelEditorBtn.addEventListener('click', closeEditor);

// ---------- 导入导出 ----------
btnImport.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mcsx,application/json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        await importScripts(ev.target.result);
        renderScriptList();
        showToast('导入成功');
      } catch (err) {
        showToast('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
});

btnExport.addEventListener('click', async () => {
  try {
    const json = await exportScripts();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mouseclick_scripts_${new Date().toISOString().slice(0, 10)}.mcsx`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出');
  } catch (err) {
    showToast('导出失败: ' + err.message);
  }
});

// ---------- 日志面板 ----------
async function refreshLogsPanel() {
  const logs = await getLogs();
  logsContent.textContent = logs.length ? logs.join('\n') : '（暂无日志）';
}

btnLogs.addEventListener('click', async () => {
  const show = logsPanel.style.display === 'none';
  logsPanel.style.display = show ? 'block' : 'none';
  if (show) await refreshLogsPanel();
});

logsClose.addEventListener('click', () => {
  logsPanel.style.display = 'none';
});

btnClearLogs.addEventListener('click', async () => {
  await clearLogs();
  showToast('日志已清空');
  await refreshLogsPanel();
});

// ---------- 初始化 ----------
async function init() {
  await renderScriptList();
  await refreshRunningState();
  runPollTimer = setInterval(refreshRunningState, 1000);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'actionSaved') {
      if (currentEditingId === msg.payload.scriptId) {
        reloadEditingActions(msg.payload.scriptId);
      }
      showToast('✅ 点击动作已添加');
    }
  });
}

init().catch(err => console.error('初始化失败:', err));