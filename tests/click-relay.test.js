import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { relayClickWithRetry } from '../autoclick/utils/click-relay.js';

function makeDeps(overrides = {}) {
  const calls = [];
  let sendAttempt = 0;
  let alive = true;
  let aborted = false;
  const deps = {
    injectPlayer: async (tabId) => { calls.push(['inject', tabId]); },
    sendToTab: async (tabId, message) => {
      calls.push(['send', tabId, message]);
      sendAttempt++;
      if (sendAttempt <= (deps.failFirst || 0)) {
        throw new Error('Receiving end does not exist');
      }
      return { success: true };
    },
    isTabAlive: async (tabId) => { calls.push(['alive', tabId]); return alive; },
    isAborted: () => aborted,
    wait: async (ms) => { calls.push(['wait', ms]); },
    setAlive(v) { alive = v; },
    setAborted(v) { aborted = v; },
    ...overrides
  };
  return { deps, calls };
}

const params = { tabId: 42, target: { x: 5 }, index: 3, total: 10 };

describe('relayClickWithRetry', () => {
  test('首次尝试成功时只注入并发送一次', async () => {
    const { deps, calls } = makeDeps();
    const result = await relayClickWithRetry(deps, params);

    assert.deepEqual(result, { success: true });
    assert.equal(calls.filter(c => c[0] === 'inject').length, 1);
    assert.equal(calls.filter(c => c[0] === 'send').length, 1);
    assert.equal(calls.filter(c => c[0] === 'wait').length, 0);
  });

  test('发送失败后重试直到成功', async () => {
    const { deps, calls } = makeDeps();
    deps.failFirst = 2;
    const result = await relayClickWithRetry(deps, params);

    assert.deepEqual(result, { success: true });
    assert.equal(calls.filter(c => c[0] === 'inject').length, 3);
    assert.equal(calls.filter(c => c[0] === 'wait').length, 2);
  });

  test('标签页已关闭时立即放弃', async () => {
    const { deps, calls } = makeDeps();
    deps.failFirst = 999;
    deps.setAlive(false);
    const result = await relayClickWithRetry(deps, params);

    assert.equal(result.success, false);
    assert.equal(result.aborted, true);
    assert.match(result.error, /标签页/);
    assert.equal(calls.filter(c => c[0] === 'alive').length, 1, '确认标签页死亡后不应继续重试');
    assert.equal(calls.filter(c => c[0] === 'wait').length, 0);
  });

  test('重试耗尽后返回失败', async () => {
    const { deps, calls } = makeDeps();
    deps.failFirst = 999;
    const result = await relayClickWithRetry(deps, { ...params, retries: 2 });

    assert.equal(result.success, false);
    assert.equal(result.aborted, undefined);
    assert.equal(calls.filter(c => c[0] === 'send').length, 3, '应尝试 3 次（重试 2 次）');
    assert.equal(calls.filter(c => c[0] === 'wait').length, 2);
  });

  test('页面返回失败结果时不重试并透传错误', async () => {
    const { deps, calls } = makeDeps({
      sendToTab: async (tabId, message) => {
        calls.push(['send', tabId, message]);
        return { success: false, error: '点击坐标处无有效元素' };
      }
    });
    const result = await relayClickWithRetry(deps, params);

    assert.equal(result.success, false);
    assert.match(result.error, /无有效元素/);
    assert.equal(calls.filter(c => c[0] === 'send').length, 1, '页面已响应不应重试');
    assert.equal(calls.filter(c => c[0] === 'wait').length, 0);
  });

  test('重试期间中止后停止重试', async () => {
    const { deps, calls } = makeDeps();
    deps.sendToTab = async (tabId, message) => {
      calls.push(['send', tabId, message]);
      deps.setAborted(true);
      throw new Error('Receiving end does not exist');
    };
    const result = await relayClickWithRetry(deps, params);

    assert.equal(result.success, false);
    assert.equal(result.aborted, true);
    assert.equal(calls.filter(c => c[0] === 'send').length, 1, '中止后不应继续重试');
  });
});