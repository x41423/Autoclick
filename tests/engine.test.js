import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, createAbortableSleep } from '../autoclick/offscreen/engine.js';

function makeDeps(overrides = {}) {
  const calls = [];
  let aborted = false;
  const deps = {
    performClick: async (tabId, target, index, total) => {
      calls.push(['click', tabId, target, index, total]);
      return { success: true };
    },
    saveProgress: async (index) => { calls.push(['progress', index]); },
    log: async (level, message) => { calls.push(['log', level, message]); },
    sleep: async (ms) => { calls.push(['sleep', ms]); },
    isAborted: () => aborted,
    setAborted() { aborted = true; },
    ...overrides
  };
  return { deps, calls };
}

const clickAction = (target = { x: 1 }) => ({ type: 'click', target });
const delayAction = (value = 100) => ({ type: 'delay', value });

function stateOf(actions, currentIndex = 0) {
  return { scriptId: 's1', tabId: 7, currentIndex, scriptData: { name: '测试', actions } };
}

describe('runEngine', () => {
  test('按顺序执行动作并传递正确的参数', async () => {
    const { deps, calls } = makeDeps();
    const actions = [clickAction({ x: 10 }), delayAction(500), clickAction({ x: 20 })];
    const result = await runEngine(stateOf(actions), deps);

    assert.equal(result.completed, true);
    assert.deepEqual(calls, [
      ['progress', 0],
      ['click', 7, { x: 10 }, 0, 3],
      ['progress', 1],
      ['sleep', 500],
      ['progress', 2],
      ['click', 7, { x: 20 }, 2, 3]
    ]);
  });

  test('从 currentIndex 继续执行', async () => {
    const { deps, calls } = makeDeps();
    const actions = [clickAction(), delayAction(), clickAction()];
    const result = await runEngine(stateOf(actions, 1), deps);

    assert.equal(result.completed, true);
    assert.deepEqual(calls, [
      ['progress', 1],
      ['sleep', 100],
      ['progress', 2],
      ['click', 7, { x: 1 }, 2, 3]
    ]);
  });

  test('点击失败时抛出带步骤信息的错误', async () => {
    const { deps } = makeDeps({
      performClick: async () => ({ success: false, error: '页面元素不存在' })
    });
    await assert.rejects(
      () => runEngine(stateOf([clickAction()]), deps),
      /页面元素不存在/
    );
  });

  test('未知动作类型记录 WARN 日志并继续', async () => {
    const { deps, calls } = makeDeps();
    const actions = [{ type: 'hover', value: 1 }, clickAction()];
    const result = await runEngine(stateOf(actions), deps);

    assert.equal(result.completed, true);
    const logCall = calls.find(c => c[0] === 'log');
    assert.ok(logCall, '应记录未知动作日志');
    assert.equal(logCall[1], 'WARN');
    assert.match(logCall[2], /未知动作类型: hover/);
  });

  test('执行中中止后提前结束并返回未完成', async () => {
    const { deps, calls } = makeDeps({
      performClick: async (tabId, target, index, total) => {
        calls.push(['click', tabId, target, index, total]);
        deps.setAborted();
        return { success: true };
      }
    });
    const actions = [clickAction(), delayAction(), clickAction()];
    const result = await runEngine(stateOf(actions), deps);

    assert.equal(result.completed, false);
    assert.equal(calls.filter(c => c[0] === 'click').length, 1, '中止后不应继续执行后续动作');
  });

  test('暂停时在步骤边界挂起，恢复后继续执行', async () => {
    const { deps, calls } = makeDeps();
    let paused = true;
    const waitIfPaused = async () => {
      while (paused) await new Promise(r => setTimeout(r, 10));
    };
    const p = runEngine(stateOf([clickAction(), clickAction()]), { ...deps, waitIfPaused });

    await new Promise(r => setTimeout(r, 50));
    assert.equal(calls.length, 0, '暂停期间不应执行任何步骤');

    paused = false;
    const result = await p;
    assert.equal(result.completed, true);
    assert.equal(calls.filter(c => c[0] === 'click').length, 2);
  });

  test('无效脚本数据时抛出错误', async () => {
    const { deps } = makeDeps();
    await assert.rejects(() => runEngine({ scriptData: { actions: 'oops' } }, deps), /无效的脚本数据/);
    await assert.rejects(() => runEngine({ scriptData: null }, deps), /无效的脚本数据/);
  });
});

describe('createAbortableSleep', () => {
  test('超时后正常 resolve', async () => {
    const sleep = createAbortableSleep();
    const start = Date.now();
    await sleep.sleep(30);
    assert.ok(Date.now() - start >= 25, '应等待至少约 30ms');
  });

  test('abort 后立即 resolve', async () => {
    const sleep = createAbortableSleep();
    const start = Date.now();
    sleep.abort();
    await sleep.sleep(10000);
    assert.ok(Date.now() - start < 1000, '中止后应快速返回');
  });

  test('长延迟期间触发 onTick 回调', async () => {
    const sleep = createAbortableSleep();
    let ticks = 0;
    await sleep.sleep(2200, () => { ticks++; });
    assert.ok(ticks >= 1, '延迟超过 1s 应触发至少一次 tick');
  });

  test('暂停期间计时冻结，恢复后按剩余时间继续', async () => {
    const sleep = createAbortableSleep();
    const start = Date.now();
    const p = sleep.sleep(200);

    await new Promise(r => setTimeout(r, 80));
    sleep.pause();
    assert.equal(sleep.isPaused(), true);

    // 暂停 150ms：这段时间不应计入计时
    await new Promise(r => setTimeout(r, 150));
    sleep.resume();
    assert.equal(sleep.isPaused(), false);

    await p;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 300, `暂停时间不应计入计时 (elapsed=${elapsed}ms)`);
  });

  test('暂停中 abort 后 waitIfPaused 立即返回', async () => {
    const sleep = createAbortableSleep();
    sleep.pause();
    const start = Date.now();
    sleep.abort();
    await sleep.waitIfPaused();
    assert.ok(Date.now() - start < 1000, 'abort 后等待应快速返回');
  });
});