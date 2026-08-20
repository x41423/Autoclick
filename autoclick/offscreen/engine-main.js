// offscreen/engine-main.js
// 引擎胶水层：连接后台端口，驱动执行循环

import { runEngine, createAbortableSleep } from './engine.js';
import { createMonitorManager } from './monitor.js';
import { validateMonitorAction } from './monitor-logic.js';
import { initOcrOnce, recognizeOnce } from './ocr.js';

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

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let audioCtx = null;
function playAlertSound() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.3;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } catch (e) {
    log('WARN', `提示音播放失败: ${e.message}`);
  }
}

function makeMonitorManager() {
  return createMonitorManager({
    captureVisibleTab: async (region) => {
      const res = await callSW({ type: 'captureVisibleTab' }, 20000);
      if (!res || !res.success || !res.dataUrl) {
        const e = new Error(res?.error || '截屏失败');
        e.code = 'CAPTURE';
        throw e;
      }
      if (!region) return res.dataUrl;
      const scale = region.scale || 1;
      const img = await loadImage(res.dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.round(region.w * scale);
      c.height = Math.round(region.h * scale);
      c.getContext('2d').drawImage(img, -region.x * scale, -region.y * scale);
      return c.toDataURL('image/jpeg', 0.9);
    },
    loadImage,
    ocrReady: () => initOcrOnce(),
    ocrRecognize: async (img) => {
      const res = await recognizeOnce(img);
      return (res && res.text) || [];
    },
    alert: (kind, payload) => {
      if (payload.way === 'sound' || payload.way === 'both') playAlertSound();
      callSW({ type: 'monitorAlert', kind, payload }, 5000).catch(() => {});
    },
    now: () => Date.now(),
    sleep,
    log,
    onStatus: (status) => {
      callSW({ type: 'monitorStatus', status }, 5000).catch(() => {});
    }
  });
}

let monitorManager = makeMonitorManager();

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
    waitIfPaused: () => sleepCtrl.waitIfPaused(),
    startMonitor: async (index, action) => {
      const r = validateMonitorAction(action);
      if (!r.ok) throw new Error(`monitor 动作无效: ${r.errors.join('; ')}`);
      monitorManager.startMonitor(index, action);
      monitorManager.start(index);
    },
    stopMonitors: async () => { monitorManager.stopAll(); }
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
    monitorManager.stopAll();
    for (const [, resolve] of pending) {
      resolve({ success: false, error: '后台连接已断开' });
    }
    pending.clear();
  });
});