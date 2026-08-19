// popup/popup.js
import { getScripts, deleteScript, setDefaultScriptId, getDefaultScriptId, saveScript, exportScripts, importScripts } from '../utils/storage.js';
import { log, getLogs, clearLogs } from '../utils/logger.js';

// DOM
const scriptListEl = document.getElementById('script-list');
const editorDiv = document.getElementById('editor');
const editNameEl = document.getElementById('edit-script-name');
const actionListEl = document.getElementById('action-list');
const addDelayBtn = document.getElementById('add-delay');
const addClickBtn = document.getElementById('add-click');
const saveEditorBtn = document.getElementById('save-editor');
const cancelEditorBtn = document.getElementById('cancel-editor');
const btnNew = document.getElementById('btn-new');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const btnLogs = document.getElementById('btn-logs');
const btnClearLogs = document.getElementById('btn-clear-logs');

let currentEditingId = null;
let editingActions = [];
let dragIndex = null;

// ---------- Toast ----------
function showToast(text) {
  const existing = document.querySelector('.mch-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'mch-toast';
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

// ---------- 拖拽处理函数 ----------
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
      desc = `⏱️ 延迟 ${action.value}ms`;
    } else if (action.type === 'click') {
      const t = action.target;
      desc = `🖱️ 点击 (${t.documentX}, ${t.documentY})`;
    } else {
      desc = `❓ ${action.type}`;
    }
    html += `
      <div class="action-item" draggable="true" data-index="${index}">
        <span class="action-info">${index+1}. ${desc}</span>
        <button class="action-del-btn" data-index="${index}">✕</button>
      </div>
    `;
  });
  actionListEl.innerHTML = html;

  // 拖拽事件
  const items = actionListEl.querySelectorAll('.action-item');
  items.forEach(item => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
  });

  // 删除按钮
  actionListEl.querySelectorAll('.action-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      editingActions.splice(idx, 1);
      renderActions();
      await saveCurrentScript();
    });
  });
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
    html += `
      <div class="script-item">
        <span class="script-name" data-id="${s.id}">${isDefault ? '⭐ ' : ''}${s.name || '未命名'}</span>
        <div class="script-actions">
          <button class="edit-btn" data-id="${s.id}">✏️ 编辑</button>
          <button class="run-btn" data-id="${s.id}">▶ 运行</button>
          <button class="default-btn" data-id="${s.id}">${isDefault ? '⭐默认' : '设为默认'}</button>
          <button class="delete-btn danger" data-id="${s.id}">删除</button>
        </div>
      </div>
    `;
  }
  scriptListEl.innerHTML = html;
}

// ---------- 事件委托绑定（一次性） ----------
function bindScriptListEvents() {
  scriptListEl.addEventListener('click', async (e) => {
    const target = e.target.closest('button');
    if (target) {
      const id = target.dataset.id;
      if (!id) return;

      if (target.classList.contains('run-btn')) {
        const scripts = await getScripts();
        const script = scripts.find(s => s.id === id);
        if (!script) { alert('脚本不存在'); return; }
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'runScript',
            payload: { scriptId: id, scriptData: script }
          });
          if (response && !response.success) {
            alert('执行失败: ' + response.error);
          } else {
            window.close();
          }
        } catch (err) {
          if (!err.message?.includes('port closed') && !err.message?.includes('Receiving end')) {
            alert('执行失败: ' + err.message);
          }
        }
        return;
      }

      if (target.classList.contains('edit-btn')) {
        await openEditor(id);
        return;
      }

      if (target.classList.contains('default-btn')) {
        await setDefaultScriptId(id);
        renderScriptList();
        return;
      }

      if (target.classList.contains('delete-btn')) {
        if (confirm('确定删除此脚本吗？')) {
          await deleteScript(id);
          renderScriptList();
          if (currentEditingId === id) closeEditor();
        }
        return;
      }
      return;
    }

    // 点击脚本名称（重命名）
    const nameEl = e.target.closest('.script-name');
    if (nameEl) {
      const id = nameEl.dataset.id;
      const scripts = await getScripts();
      const script = scripts.find(s => s.id === id);
      if (!script) return;
      const newName = prompt('修改脚本名称:', script.name);
      if (newName !== null && newName.trim() !== '') {
        script.name = newName.trim();
        await saveScript(script);
        renderScriptList();
        if (currentEditingId === id) {
          editNameEl.textContent = `编辑: ${script.name}`;
        }
      }
    }
  });
}

// ---------- 初始化 ----------
async function init() {
  renderScriptList();
  // 绑定脚本列表事件委托（只一次）
  bindScriptListEvents();

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'actionSaved') {
      if (currentEditingId === msg.payload.scriptId) {
        reloadEditingActions(msg.payload.scriptId);
      }
      showToast('✅ 点击动作已添加');
    }
  });
}

// ---------- 事件绑定 ----------
addDelayBtn.addEventListener('click', async () => {
  const ms = prompt('请输入延迟毫秒数:', '1000');
  if (ms === null) return;
  const val = parseInt(ms);
  if (isNaN(val) || val < 0) {
    alert('请输入有效的正整数');
    return;
  }
  editingActions.push({ type: 'delay', value: val });
  renderActions();
  await saveCurrentScript();
});

addClickBtn.addEventListener('click', async () => {
  if (!currentEditingId) {
    alert('请先创建或打开一个脚本进行编辑');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    alert('未找到活动标签页，请打开一个网页');
    return;
  }

  const continuousModeCheckbox = document.getElementById('continuous-mode');
  const continuous = continuousModeCheckbox ? continuousModeCheckbox.checked : false;

  // 通知 background 准备拾取，同时传递连续模式标志
  await chrome.runtime.sendMessage({
    type: 'preparePicker',
    payload: { 
      scriptId: currentEditingId,
      continuous: continuous   // 新增
    }
  });

  // 每次强制注入 picker.js
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/picker.js'],
    });
  } catch (err) {
    alert('拾取器注入失败，请刷新页面后重试');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'startPicker',
      payload: { continuous }
    });
  } catch (err) {
    alert('启动拾取器失败，请刷新页面后重试');
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
});

cancelEditorBtn.addEventListener('click', closeEditor);

if (btnNew) {
  btnNew.addEventListener('click', async () => {
    const name = prompt('请输入新脚本名称:', '未命名脚本');
    if (name === null) return;
    const newScript = {
      id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: name.trim() || '未命名',
      actions: []
    };
    await saveScript(newScript);
    await renderScriptList();
    await openEditor(newScript.id);
  });
}

// 导入导出日志
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
        const text = ev.target.result;
        await importScripts(text);
        renderScriptList();
        alert('导入成功！');
      } catch (err) {
        alert('导入失败: ' + err.message);
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
    a.download = `mouseclick_scripts_${new Date().toISOString().slice(0,10)}.mcsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('导出失败: ' + err.message);
  }
});

btnLogs.addEventListener('click', async () => {
  const logs = await getLogs();
  if (logs.length === 0) {
    alert('暂无日志');
    return;
  }
  const text = logs.join('\n');
  const win = window.open('', '_blank', 'width=600,height=400');
  win.document.write(`<pre style="margin:0;padding:12px;font-size:12px;background:#f5f5f5;height:100%;overflow:auto;">${text}</pre>`);
});

// 清空日志
if (btnClearLogs) {
  btnClearLogs.addEventListener('click', async () => {
    if (confirm('确定清空所有日志吗？')) {
      await clearLogs();
      alert('日志已清空');
    }
  });
}

// 启动
init().catch(err => console.error('初始化失败:', err));