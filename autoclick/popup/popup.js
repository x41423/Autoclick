// popup/popup.js
import { getScripts, deleteScript, setDefaultScriptId, getDefaultScriptId, saveScript, exportScripts, importScripts } from '../utils/storage.js';
import { log, getLogs } from '../utils/logger.js';

// DOM
const scriptListEl = document.getElementById('script-list');
const editorDiv = document.getElementById('editor');
const editNameEl = document.getElementById('edit-script-name');
const actionListEl = document.getElementById('action-list');
const addDelayBtn = document.getElementById('add-delay');
const addClickBtn = document.getElementById('add-click');
const saveEditorBtn = document.getElementById('save-editor');
const cancelEditorBtn = document.getElementById('cancel-editor');

let currentEditingId = null;       // 正在编辑的脚本ID
let editingActions = [];          // 临时动作列表（用于编辑）

// 示例脚本（保持不变）
const DEMO_SCRIPT = {
  id: 'demo',
  name: '示例脚本 - 百度搜索点击',
  actions: [
    { type: 'delay', value: 1000 },
    { 
      type: 'click',
      target: {
        documentX: 500,
        documentY: 300,
        snapshotScrollX: 0,
        snapshotScrollY: 0,
        elementRect: null,
        clickOffsetX: 0,
        clickOffsetY: 0,
      }
    }
  ]
};

// ---------- 初始化 ----------
async function init() {
  const scripts = await getScripts();
  if (scripts.length === 0) {
    await saveScript(DEMO_SCRIPT);
    await setDefaultScriptId(DEMO_SCRIPT.id);
    log('INFO', '[POPUP]', '已创建示例脚本');
  }
  renderScriptList();
  // 监听来自 background 的 picker 确认消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'pickerConfirm') {
      // 收到拾取数据，添加点击动作
      const action = {
        type: 'click',
        target: msg.payload
      };
      editingActions.push(action);
      renderActions();
      sendResponse({ success: true });
    } else if (msg.type === 'pickerCancel') {
      // 用户取消拾取，无操作
      sendResponse({ success: true });
    }
  });
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

  // 绑定事件
  scriptListEl.querySelectorAll('.run-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const scripts = await getScripts();
      const script = scripts.find(s => s.id === id);
      if (script) {
        chrome.runtime.sendMessage({ type: 'runScript', payload: { scriptId: id, scriptData: script } }, (response) => {
          if (chrome.runtime.lastError) alert('执行失败: ' + chrome.runtime.lastError.message);
          else if (response && !response.success) alert('执行失败: ' + response.error);
          else window.close();
        });
      }
    });
  });

  scriptListEl.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await openEditor(id);
    });
  });

  scriptListEl.querySelectorAll('.default-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await setDefaultScriptId(btn.dataset.id);
      renderScriptList();
    });
  });

  scriptListEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('确定删除此脚本吗？')) {
        await deleteScript(btn.dataset.id);
        renderScriptList();
        if (currentEditingId === btn.dataset.id) closeEditor();
      }
    });
  });

  scriptListEl.querySelectorAll('.script-name').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const scripts = await getScripts();
      const script = scripts.find(s => s.id === id);
      if (!script) return;
      const newName = prompt('修改脚本名称:', script.name);
      if (newName !== null && newName.trim() !== '') {
        script.name = newName.trim();
        await saveScript(script);
        renderScriptList();
        if (currentEditingId === id) {
          editNameEl.textContent = script.name;
        }
      }
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
      <div class="action-item">
        <span class="action-info">${index+1}. ${desc}</span>
        <button class="action-del-btn" data-index="${index}">✕</button>
      </div>
    `;
  });
  actionListEl.innerHTML = html;
  // 删除事件
  actionListEl.querySelectorAll('.action-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      editingActions.splice(idx, 1);
      renderActions();
    });
  });
}

// 添加延迟
addDelayBtn.addEventListener('click', () => {
  const ms = prompt('请输入延迟毫秒数:', '1000');
  if (ms === null) return;
  const val = parseInt(ms);
  if (isNaN(val) || val < 0) {
    alert('请输入有效的正整数');
    return;
  }
  editingActions.push({ type: 'delay', value: val });
  renderActions();
});

// 添加点击（触发拾取器）
addClickBtn.addEventListener('click', async () => {
  // 获取当前活动标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    alert('未找到活动标签页，请打开一个网页');
    return;
  }
  // 注入 picker.js
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/picker.js'],
    });
  } catch (e) {
    // 可能已注入，忽略
  }
  // 发送启动消息
  await chrome.tabs.sendMessage(tab.id, { type: 'startPicker' });
  // 注意：拾取器完成后会通过 runtime.onMessage 发送 pickerConfirm，我们在 init 中已监听
  // 这里可以关闭 popup 吗？不建议，因为用户需要看到结果，但拾取器会在页面操作，popup保持开启即可
});

// 保存编辑
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

// 取消编辑
cancelEditorBtn.addEventListener('click', closeEditor);

// ---------- 导入导出日志 ----------
document.getElementById('btn-import').addEventListener('click', () => {
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

document.getElementById('btn-export').addEventListener('click', async () => {
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

document.getElementById('btn-logs').addEventListener('click', async () => {
  const logs = await getLogs();
  if (logs.length === 0) {
    alert('暂无日志');
    return;
  }
  const text = logs.join('\n');
  const win = window.open('', '_blank', 'width=600,height=400');
  win.document.write(`<pre style="margin:0;padding:12px;font-size:12px;background:#f5f5f5;height:100%;overflow:auto;">${text}</pre>`);
});

// 启动
init().catch(err => console.error('初始化失败:', err));