import { parseNumber, checkThreshold } from './monitor-logic.js';

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_MS = 30000;

export function createMonitorManager(deps) {
  const monitors = new Map();

  function log(level, message, ctx = {}) {
    try { deps.log(level, message, ctx); } catch { /* 日志自身失败不阻断 */ }
  }

  function snapshot(m) {
    return {
      id: m.id,
      name: m.action.name,
      actionIndex: m.actionIndex,
      status: m.status,
      lastValue: m.lastValue,
      lastRawText: m.lastRawText,
      lastCheckAt: m.lastCheckAt,
      lastAlertAt: m.lastAlertAt,
      alertState: m.alertState,
      consecutiveFailures: m.consecutiveFailures
    };
  }

  async function runOneRound(m) {
    const { action } = m;
    if (m.stopped) return;
    const started = deps.now();
    let doWait = true;
    try {
      const dataUrl = await deps.captureVisibleTab();
      const img = await deps.loadImage(dataUrl);
      await deps.ocrReady();
      const lines = await deps.ocrRecognize(img);
      const rawText = lines.join('');
      m.lastRawText = rawText;
      m.lastCheckAt = deps.now();
      if (action.parse === 'text') {
        m.lastValue = rawText;
        m.consecutiveFailures = 0;
        m.status = 'active';
        log('INFO', `检查完成 ${action.name}：原文=${rawText}`, { id: m.id, actionIndex: m.actionIndex });
      } else {
        const value = parseNumber(rawText);
        if (value === null) {
          log('WARN', `解析失败（原文：${rawText || '<空>'}），本轮跳过比较`, { id: m.id, actionIndex: m.actionIndex });
          m.consecutiveFailures++;
        } else {
          m.lastValue = value;
          const newState = checkThreshold(value, action.thresholds);
          const now = deps.now();
          if (newState !== m.alertState) {
            if (newState === 'normal') {
              deps.alert('recover', { id: m.id, name: action.name, value, rawText, way: action.alert.way, message: `${action.name ?? '监控'}已恢复正常（${value}）` });
              m.lastAlertAt = now;
              m.alertState = newState;
              log('INFO', `恢复提醒 ${action.name}：${value}`, { id: m.id, actionIndex: m.actionIndex });
            } else if (m.lastAlertAt === 0 || now - m.lastAlertAt >= action.alert.cooldownSec * 1000) {
              deps.alert('enter', { id: m.id, name: action.name, value, rawText, state: newState, way: action.alert.way, message: `${action.name ?? '监控'}${newState === 'high' ? '高于上限' : '低于下限'}（${value}）` });
              m.lastAlertAt = now;
              m.alertState = newState;
              log('WARN', `越界提醒 ${action.name}：${value}（${newState === 'high' ? '高' : '低'}）`, { id: m.id, actionIndex: m.actionIndex });
            }
          }
          m.consecutiveFailures = 0;
          m.status = 'active';
          log('INFO', `检查完成 ${action.name}：值=${value} 状态=${newState}`, { id: m.id, actionIndex: m.actionIndex });
        }
      }
    } catch (err) {
      m.consecutiveFailures++;
      const level = err?.code === 'CAPTURE' ? 'WARN' : 'ERROR';
      log(level, `本轮失败（${err?.code ?? err?.message ?? err}）：${err?.stack ?? ''}`, { id: m.id, actionIndex: m.actionIndex });
      if (m.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        m.status = 'error';
        log('ERROR', `连续失败 ${m.consecutiveFailures} 次，哨兵暂停 ${BACKOFF_MS / 1000}s`, { id: m.id, actionIndex: m.actionIndex });
        deps.alert('error', { id: m.id, name: action.name, way: action.alert.way, message: `${action.name ?? '监控'}连续失败，已暂停 30 秒` });
        if (!m.stopped) await deps.sleep(BACKOFF_MS);
        m.status = 'active';
        doWait = false;
      }
    }
    try { deps.onStatus(snapshot(m)); } catch { /* 状态上报失败不阻断 */ }
    if (doWait && !m.stopped) {
      const elapsed = deps.now() - started;
      const wait = Math.max(0, action.intervalSec * 1000 - elapsed);
      await deps.sleep(wait);
    }
  }

  async function scheduler(m) {
    m.status = 'active';
    log('INFO', `哨兵启动 ${m.id}（${m.action.name ?? ''}，间隔 ${m.action.intervalSec}s，区域 ${JSON.stringify(m.action.region)}）`, { id: m.id, actionIndex: m.actionIndex });
    while (!m.stopped) {
      await runOneRound(m);
    }
    m.status = 'stopped';
    log('INFO', `哨兵停止 ${m.id}`, { id: m.id, actionIndex: m.actionIndex });
  }

  function findById(index) {
    return [...monitors.values()].find(m => m.actionIndex === index) ?? null;
  }

  return {
    startMonitor(actionIndex, action) {
      const id = `monitor_${actionIndex}`;
      const m = {
        id,
        actionIndex,
        action,
        status: 'waiting',
        lastValue: null,
        lastRawText: '',
        lastCheckAt: 0,
        lastAlertAt: 0,
        alertState: 'normal',
        consecutiveFailures: 0,
        stopped: false
      };
      monitors.set(id, m);
      return id;
    },
    start(index) {
      const m = findById(index);
      if (m && !m.stopped && m.status === 'waiting') scheduler(m);
      return m?.id;
    },
    startAll() {
      for (const m of monitors.values()) {
        if (!m.stopped && m.status === 'waiting') scheduler(m);
      }
    },
    stopAll() {
      for (const m of monitors.values()) {
        m.stopped = true;
        m.status = 'stopped';
      }
    },
    getStatus(index) {
      const m = findById(index);
      return m ? snapshot(m) : null;
    },
    allStatus() {
      return [...monitors.values()].map(snapshot);
    },
    isActive() {
      return [...monitors.values()].some(m => !m.stopped && m.status !== 'stopped');
    },
    _advance(index) {
      const m = findById(index);
      return m ? runOneRound(m) : Promise.resolve();
    }
  };
}