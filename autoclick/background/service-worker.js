// background/service-worker.js
import { log } from '../utils/logger.js';
import { getScripts, getDefaultScriptId, setDefaultScriptId, saveScript } from '../utils/storage.js';
import { relayClickWithRetry } from '../utils/click-relay.js';

const EXEC_STATE_KEY = 'executionState';
const PENDING_PICKER_KEY = 'pendingPicker';

let enginePort = null;
let lastProgressAt = 0;

// ---------- 状态管理 ----------
async function saveExecutionState(state) {
  await chrome.storage.local.set({ [EXEC_STATE_KEY]: state });
}

async function getExecutionState() {
  const result = await chrome.storage.local.get(EXEC_STATE_KEY);
  return result[EXEC_STATE_KEY] || null;
}

async function clearExecutionState() {
  await chrome.storage.local.remove(EXEC_STATE_KEY);
}

// 拾取中的待处理脚本状态存于 session，SW 被回收后不丢失
async function setPendingPicker(scriptId, continuous) {
  await chrome.storage.session.set({ [PENDING_PICKER_KEY]: { scriptId, continuous } });
}

async function getPendingPicker() {
  const result = await chrome.storage.session.get(PENDING_PICKER_KEY);
  return result[PENDING_PICKER_KEY] || null;
}

async function clearPendingPicker() {
  await chrome.storage.session.remove(PENDING_PICKER_KEY);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- offscreen 执行引擎 ----------
async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.some(c => c.documentUrl === chrome.runtime.getURL('offscreen/engine.html'))) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen/engine.html',
      reasons: ['DOM_SCRAPING'],
      justification: '后台运行点击脚本执行引擎（定时器与消息循环）'
    });
  } catch (e) {
    log('ERROR', '[BG]', `创建 offscreen 文档失败: ${e.message}`);
    throw e;
  }
}

async function connectEngine() {
  for (let i = 0; i < 10; i++) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'engine' });
    } catch (e) {
      await sleep(200);
      continue;
    }
    const pong = await Promise.race([
      new Promise(resolve => {
        port.onMessage.addListener(msg => {
          if (msg.type === 'pong') resolve(true);
        });
        try { port.postMessage({ type: 'ping' }); } catch (e) {}
      }),
      sleep(1000).then(() => null)
    ]);
    if (pong) return port;
    try { port.disconnect(); } catch (e) {}
    await sleep(200);
  }
  throw new Error('执行引擎连接超时');
}

function setupEnginePort(port) {
  enginePort = port;
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'call') {
      let result;
      try {
        result = await handleEngineCall(msg.payload, port);
      } catch (e) {
        result = { success: false, error: e.message };
      }
      try { port.postMessage({ type: 'callResponse', id: msg.id, result }); } catch (e) {}
    }
  });
  port.onDisconnect.addListener(() => {
    if (enginePort === port) {
      enginePort = null;
      getExecutionState().then(state => {
        if (state && state.tabId) {
          chrome.tabs.sendMessage(state.tabId, { type: 'barHide' }).catch(() => {});
        }
      });
    }
  });
}

async function handleEngineCall(payload, port) {
  const state = await getExecutionState();

  switch (payload.type) {
    case 'getExecutionState': {
      if (!state) return { success: false, error: '无执行状态' };
      return { success: true, state };
    }

    case 'performClick': {
      if (!state) return { success: false, error: '无执行状态' };
      return await relayClickWithRetry({
        injectPlayer: async (tabId) => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['content/player.js']
            });
          } catch (e) {}
        },
        sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
        isTabAlive: async (tabId) => {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          return !!tab;
        },
        isAborted: () => enginePort !== port,
        wait: sleep
      }, {
        tabId: state.tabId,
        target: payload.target,
        index: payload.index,
        total: payload.total
      });
    }

    case 'progress': {
      if (state) {
        const now = Date.now();
        const isLast = payload.index === (state.totalSteps || 0) - 1;
        if (isLast || now - lastProgressAt >= 500) {
          lastProgressAt = now;
          state.currentIndex = payload.index;
          await saveExecutionState(state);
        }
      }
      return { success: true };
    }

    case 'barUpdate': {
      if (state) {
        chrome.tabs.sendMessage(state.tabId, {
          type: 'barUpdate',
          payload: { index: payload.index, total: payload.total, remainingMs: payload.remainingMs }
        }).catch(() => {});
      }
      return { success: true };
    }

    case 'engineDone': {
      if (enginePort === port) {
        enginePort = null;
        if (state && state.tabId) {
          chrome.tabs.sendMessage(state.tabId, { type: 'barHide' }).catch(() => {});
        }
        await clearExecutionState();
        await chrome.offscreen.closeDocument().catch(() => {});
      }
      return { success: true };
    }

    default:
      return { success: false, error: '未知引擎调用' };
  }
}

async function startEngine(scriptId, scriptData, tabId) {
  await stopEngine();
  await clearExecutionState();
  await saveExecutionState({
    scriptId,
    scriptData,
    currentIndex: 0,
    tabId,
    totalSteps: (scriptData.actions || []).length,
    paused: false
  });
  await ensureOffscreen();
  const port = await connectEngine();
  setupEnginePort(port);
  port.postMessage({ type: 'engineStart', payload: { stateKey: EXEC_STATE_KEY } });
}

async function stopEngine() {
  const state = await getExecutionState();
  if (state && state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: 'barHide' }).catch(() => {});
  }
  if (enginePort) {
    try { enginePort.postMessage({ type: 'engineStop' }); } catch (e) {}
    try { enginePort.disconnect(); } catch (e) {}
    enginePort = null;
  }
  try { await chrome.offscreen.closeDocument(); } catch (e) {}
}

// ---------- 消息处理 ----------
async function handleMessage(message, sender) {
  const { type, payload } = message;

  // 拾取器相关
  if (type === 'preparePicker') {
    await setPendingPicker(payload.scriptId, payload.continuous || false);
    log('DEBUG', '[BG]', `准备拾取，脚本ID: ${payload.scriptId}, 连续模式: ${payload.continuous || false}`);
    return { success: true };
  }

  if (type === 'pickerConfirm') {
    const pending = await getPendingPicker();
    if (pending && pending.scriptId) {
      try {
        const scripts = await getScripts();
        const script = scripts.find(s => s.id === pending.scriptId);
        if (script) {
          if (!script.actions) script.actions = [];
          script.actions.push({ type: 'click', target: payload });
          await saveScript(script);
          log('INFO', '[BG]', `已添加点击动作到脚本 "${script.name}"（当前共 ${script.actions.length} 个动作）`);
          chrome.runtime.sendMessage({
            type: 'actionSaved',
            payload: { scriptId: script.id }
          }).catch(() => {});
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
              await chrome.tabs.sendMessage(tab.id, {
                type: 'showToast',
                payload: { message: `✅ 已添加点击 (${script.actions.length})` }
              });
            }
          } catch (_) {}
          if (!pending.continuous) {
            await clearPendingPicker();
          }
        } else {
          log('WARN', '[BG]', '未找到对应的脚本');
          await clearPendingPicker();
        }
      } catch (err) {
        log('ERROR', '[BG]', `保存动作失败: ${err.message}`);
        await clearPendingPicker();
      }
    } else {
      log('WARN', '[BG]', '收到拾取数据但没有待处理的脚本ID');
    }
    return { success: true };
  }

  if (type === 'pickerCancel') {
    await clearPendingPicker();
    log('DEBUG', '[BG]', '拾取已取消');
    return { success: true };
  }

  // 脚本执行
  if (type === 'runScript') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('未找到活动标签页');
    await startEngine(payload.scriptId, payload.scriptData, tab.id);
    log('INFO', '[BG]', `脚本 "${payload.scriptData.name}" 已启动`);
    return { success: true };
  }

  if (type === 'stopScript') {
    await stopEngine();
    await clearExecutionState();
    log('INFO', '[BG]', '脚本已停止');
    return { success: true };
  }

  // 暂停/继续
  if (type === 'pauseScript' || type === 'resumeScript') {
    const state = await getExecutionState();
    if (!state) return { success: false, error: '没有正在运行的脚本' };
    const pausing = type === 'pauseScript';
    state.paused = pausing;
    await saveExecutionState(state);
    if (enginePort) {
      try { enginePort.postMessage({ type: pausing ? 'enginePause' : 'engineResume' }); } catch (e) {}
    }
    if (state.tabId) {
      chrome.tabs.sendMessage(state.tabId, {
        type: 'syncPauseState',
        payload: { paused: pausing }
      }).catch(() => {});
    }
    log('INFO', '[BG]', pausing ? '脚本已暂停' : '脚本已继续');
    return { success: true };
  }

  // 查询当前标签页是否有脚本在运行（浮窗重连/弹窗状态条用）
  if (type === 'getRunningState') {
    const state = await getExecutionState();
    if (state && (!sender?.tab || sender.tab.id === state.tabId)) {
      return {
        success: true,
        running: true,
        tabId: state.tabId,
        scriptName: state.scriptData?.name || '未命名',
        currentIndex: state.currentIndex ?? 0,
        totalSteps: state.totalSteps ?? 0,
        paused: !!state.paused
      };
    }
    return { success: true, running: false };
  }

  // 日志转发
  if (type === 'log') {
    log(payload.level, payload.tag, payload.message);
    return { success: true };
  }

  return { success: false, error: '未知消息类型' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

// ---------- 快捷键监听 ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-script') {
    log('INFO', '[BG]', '收到快捷键: 启动脚本');
    try {
      const scripts = await getScripts();
      if (scripts.length === 0) {
        log('WARN', '[BG]', '没有可用的脚本');
        return;
      }
      const defaultId = await getDefaultScriptId();
      let script = scripts.find(s => s.id === defaultId);
      if (!script) {
        script = scripts[0];
        await setDefaultScriptId(script.id);
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('未找到活动标签页');
      await startEngine(script.id, script, tab.id);
    } catch (err) {
      log('ERROR', '[BG]', `快捷键启动失败: ${err.message}`);
    }
  } else if (command === 'stop-script') {
    log('INFO', '[BG]', '收到快捷键: 停止脚本');
    await stopEngine();
    await clearExecutionState();
  }
});

// 浏览器启动时清理残留的执行状态（引擎已随关闭销毁）
chrome.runtime.onStartup.addListener(() => {
  clearExecutionState().catch(() => {});
});

// 运行中的标签页刷新完成后自动重注入播放器，恢复浮窗显示
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const state = await getExecutionState();
  if (!state || state.tabId !== tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/player.js']
    });
  } catch (e) {}
});