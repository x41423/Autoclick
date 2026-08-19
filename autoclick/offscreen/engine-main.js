// offscreen/engine-main.js
// 引擎胶水层：连接后台端口，驱动执行循环

import { runEngine, createAbortableSleep } from './engine.js';

const sleepCtrl = createAbortableSleep();

let port = null;
const pending = new Map();
let seq = 0;

function callSW(payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!port) return resolve({ success: false, error: '引擎端口未连接' });
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ success: false, error: '后台响应超时' });
    }, timeoutMs);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      port.postMessage({ type: 'call', id, payload });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ success: false, error: e.message });
    }
  });
}

function log(level, message) {
  chrome.runtime.sendMessage({ type: 'log', payload: { level, tag: '[ENGINE]', message } }).catch(() => {});
}

async function startEngine() {
  const res = await callSW({ type: 'getExecutionState' });
  if (!res || !res.success || !res.state) throw new Error(res?.error || '无执行状态');
  const state = res.state;
  log('INFO', `开始执行脚本: ${state.scriptData?.name || '未命名'}${state.currentIndex > 0 ? `（从第 ${state.currentIndex + 1} 步继续）` : ''}`);

  const deps = {
    performClick: (tabId, target, index, total) => callSW({ type: 'performClick', tabId, target, index, total }),
    saveProgress: (index) => callSW({ type: 'progress', index }, 5000),
    log,
    sleep: (ms, onTick) => sleepCtrl.sleep(ms, onTick),
    onTick: (index, total, remainingMs) => callSW({ type: 'barUpdate', index, total, remainingMs }, 5000),
    isAborted: () => port === null || sleepCtrl.isAborted(),
    waitIfPaused: () => sleepCtrl.waitIfPaused()
  };

  const { completed } = await runEngine(state, deps);
  if (completed) {
    log('INFO', '脚本执行完成');
  } else {
    log('WARN', '脚本执行已停止');
  }
  callSW({ type: 'engineDone' }).catch(() => {});
}

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'engine') return;
  port = p;
  p.onMessage.addListener((msg) => {
    if (msg.type === 'ping') {
      try { p.postMessage({ type: 'pong' }); } catch (e) {}
    }
    if (msg.type === 'callResponse') {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg.result);
      }
    }
    if (msg.type === 'engineStart') {
      startEngine().catch((err) => {
        if (sleepCtrl.isAborted()) {
          log('WARN', '脚本执行已停止');
        } else {
          log('ERROR', `引擎启动失败: ${err.message}`);
        }
        callSW({ type: 'engineDone' }).catch(() => {});
      });
    }
    if (msg.type === 'engineStop') {
      sleepCtrl.abort();
    }
    if (msg.type === 'enginePause') {
      sleepCtrl.pause();
      log('INFO', '脚本已暂停');
    }
    if (msg.type === 'engineResume') {
      sleepCtrl.resume();
      log('INFO', '脚本已继续');
    }
  });
  p.onDisconnect.addListener(() => {
    port = null;
    sleepCtrl.abort();
    for (const [, resolve] of pending) {
      resolve({ success: false, error: '后台连接已断开' });
    }
    pending.clear();
  });
});