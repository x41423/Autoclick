// background/service-worker.js
// 后台常驻脚本：消息中转、快捷键监听

import { log } from '../utils/logger.js';
import { getScripts, getDefaultScriptId, saveScript } from '../utils/storage.js';

// 监听来自 popup 或 content 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  if (type === 'pickerConfirm' || type === 'pickerCancel') {
    chrome.runtime.sendMessage(message); // 转发给 popup
    sendResponse({ success: true });
    return true;
  }

  if (type === 'runScript') {
    // 执行脚本：向当前活动标签页注入 player 并启动
    runScriptOnActiveTab(payload.scriptId, payload.scriptData)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 异步响应
  }

  if (type === 'stopScript') {
    // 停止脚本：向当前活动标签页发送停止信号
    stopScriptOnActiveTab()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 其他消息（如日志转发）
  if (type === 'log') {
    // 内容脚本发来的日志，直接调用 log 工具
    log(payload.level, payload.tag, payload.message);
    sendResponse({ success: true });
    return false;
  }

  // 未处理的消息
  sendResponse({ success: false, error: '未知消息类型' });
  return false;
});

// 快捷键监听
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-script') {
    log('INFO', '[BG]', '收到快捷键: 启动脚本');
    try {
      const scripts = await getScripts();
      if (scripts.length === 0) {
        log('WARN', '[BG]', '没有可用的脚本，请先在插件面板创建');
        return;
      }
      const defaultId = await getDefaultScriptId();
      let script = scripts.find(s => s.id === defaultId);
      if (!script) {
        script = scripts[0]; // 如果默认不存在，取第一个
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

/**
 * 向当前活动标签页注入 player 并执行脚本
 */
async function runScriptOnActiveTab(scriptId, scriptData) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    throw new Error('未找到活动标签页');
  }

  // 先注入 player.js（如果已经注入，会报错但不影响，我们 catch 后继续）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/player.js'],
    });
  } catch (e) {
    // 可能已经注入，忽略
    log('DEBUG', '[BG]', 'player.js 注入（可能已存在）');
  }

  // 发送执行指令
  await chrome.tabs.sendMessage(tab.id, {
    type: 'executeScript',
    payload: {
      scriptId,
      scriptData,
    },
  });
}

/**
 * 停止当前标签页的脚本
 */
async function stopScriptOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'stopScript',
      payload: {},
    });
  } catch (e) {
    // 可能页面没有注入 content，忽略
  }
}