// background/service-worker.js
import { log } from '../utils/logger.js';
import { getScripts, getDefaultScriptId, setDefaultScriptId, saveScript } from '../utils/storage.js';

// ---------- 关键变量 ----------
let pendingPickerScriptId = null;
let pendingContinuous = false;
const EXEC_STATE_KEY = 'executionState';

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

// ---------- 页面加载完成后自动恢复 ----------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 添加详细日志，便于调试
  console.log('[BG] onUpdated:', changeInfo.status, tab.url);
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
    const state = await getExecutionState();
    console.log('[BG] state after complete:', state);
    if (state && state.tabId === tabId && !state.resumed) {
      log('INFO', '[BG]', `检测到页面刷新，自动恢复脚本执行 (${state.scriptData?.name})`);
      setTimeout(async () => {
        try {
          // 确保 player.js 已注入
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/player.js']
          }).catch(() => {});
          // 发送恢复指令
          await chrome.tabs.sendMessage(tabId, {
            type: 'resumeExecution',
            payload: {
              scriptId: state.scriptId,
              scriptData: state.scriptData,
              startIndex: state.currentIndex
            }
          });
          log('INFO', '[BG]', '恢复指令已发送');
        } catch (e) {
          log('WARN', '[BG]', `自动恢复失败: ${e.message}`);
        }
      }, 1000);
    }
  }
});

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  const { type, payload } = message;

  // 拾取器相关
  if (type === 'preparePicker') {
    pendingPickerScriptId = payload.scriptId;
    pendingContinuous = payload.continuous || false;
    log('DEBUG', '[BG]', `准备拾取，脚本ID: ${pendingPickerScriptId}, 连续模式: ${pendingContinuous}`);
    sendResponse({ success: true });
    return true;
  }

  if (type === 'pickerConfirm') {
    if (pendingPickerScriptId) {
      try {
        const scripts = await getScripts();
        const script = scripts.find(s => s.id === pendingPickerScriptId);
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
          if (!pendingContinuous) {
            pendingPickerScriptId = null;
          }
        } else {
          log('WARN', '[BG]', '未找到对应的脚本');
          pendingPickerScriptId = null;
        }
      } catch (err) {
        log('ERROR', '[BG]', `保存动作失败: ${err.message}`);
        pendingPickerScriptId = null;
      }
    } else {
      log('WARN', '[BG]', '收到拾取数据但没有待处理的脚本ID');
    }
    sendResponse({ success: true });
    return true;
  }

  if (type === 'pickerCancel') {
    pendingPickerScriptId = null;
    pendingContinuous = false;
    log('DEBUG', '[BG]', '拾取已取消');
    sendResponse({ success: true });
    return true;
  }

  // 脚本执行
  if (type === 'runScript') {
    // 清除旧状态
    await clearExecutionState();
    // 保存新状态（初始进度为 0）
    await saveExecutionState({
      scriptId: payload.scriptId,
      scriptData: payload.scriptData,
      currentIndex: 0,
      tabId: sender.tab?.id || 0,
      resumed: false,
      totalSteps: payload.scriptData.actions.length
    });
    // 执行
    runScriptOnActiveTab(payload.scriptId, payload.scriptData)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (type === 'stopScript') {
    stopScriptOnActiveTab()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 进度更新
  if (type === 'updateProgress') {
    const state = await getExecutionState();
    if (state) {
      state.currentIndex = payload.index;
      await saveExecutionState(state);
    }
    sendResponse({ success: true });
    return false;
  }

  if (type === 'markResumed') {
    const state = await getExecutionState();
    if (state) {
      state.resumed = true;
      await saveExecutionState(state);
    }
    sendResponse({ success: true });
    return false;
  }

  if (type === 'clearExecutionState') {
    await clearExecutionState();
    sendResponse({ success: true });
    return false;
  }

  // 日志转发
  if (type === 'log') {
    log(payload.level, payload.tag, payload.message);
    sendResponse({ success: true });
    return false;
  }

  sendResponse({ success: false, error: '未知消息类型' });
  return false;
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
      runScriptOnActiveTab(script.id, script);
    } catch (err) {
      log('ERROR', '[BG]', `快捷键启动失败: ${err.message}`);
    }
  } else if (command === 'stop-script') {
    log('INFO', '[BG]', '收到快捷键: 停止脚本');
    stopScriptOnActiveTab();
  }
});

// ---------- 核心函数 ----------
async function runScriptOnActiveTab(scriptId, scriptData) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('未找到活动标签页');
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/player.js'],
    });
  } catch (e) {
    log('DEBUG', '[BG]', 'player.js 注入（可能已存在）');
  }
  await chrome.tabs.sendMessage(tab.id, {
    type: 'executeScript',
    payload: { scriptId, scriptData },
  });
}

async function stopScriptOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'stopScript',
      payload: {},
    });
  } catch (e) {}
}