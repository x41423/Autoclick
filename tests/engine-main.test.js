import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

describe('engine-main 胶水层（端口握手与调用往返）', () => {
  let connectListener;
  let sent = [];

  before(async () => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg);
          return { success: true };
        },
        onConnect: { addListener: (fn) => { connectListener = fn; } }
      }
    };
    await import('../autoclick/offscreen/engine-main.js');
  });

  function makePort(name) {
    const msgListeners = [];
    const discListeners = [];
    return {
      name,
      postMessage(msg) {
        queueMicrotask(() => {
          for (const fn of [...msgListeners]) fn(msg);
        });
      },
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      onDisconnect: { addListener: (fn) => discListeners.push(fn) },
      disconnect() {
        queueMicrotask(() => {
          for (const fn of [...discListeners]) fn();
        });
      }
    };
  }

  test('引擎经端口完成 getExecutionState/performClick 往返并发送 engineDone', async () => {
    assert.ok(connectListener, 'engine-main 应注册 onConnect 监听');

    const state = {
      scriptId: 's1',
      tabId: 7,
      currentIndex: 0,
      scriptData: {
        name: '集成测试',
        actions: [
          { type: 'click', target: { documentX: 100, documentY: 200 } },
          { type: 'click', target: { documentX: 300, documentY: 400 } }
        ]
      }
    };

    const clicks = [];
    let doneReceived = null;

    const port = makePort('engine');
    port.onMessage.addListener((msg) => {
      if (msg.type === 'ping') {
        port.postMessage({ type: 'pong' });
        return;
      }
      if (msg.type !== 'call') return;
      let result;
      switch (msg.payload.type) {
        case 'getExecutionState':
          result = { success: true, state };
          break;
        case 'performClick':
          clicks.push(msg.payload);
          result = { success: true };
          break;
        case 'progress':
        case 'barUpdate':
          result = { success: true };
          break;
        case 'engineDone':
          doneReceived = msg.payload;
          result = { success: true };
          break;
        default:
          result = { success: false, error: '未知调用: ' + msg.payload.type };
      }
      port.postMessage({ type: 'callResponse', id: msg.id, result });
    });

    connectListener(port);
    port.postMessage({ type: 'engineStart' });

    const deadline = Date.now() + 5000;
    while (!doneReceived && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.ok(doneReceived, '引擎应完成执行并发送 engineDone（callResponse 握手生效）');
    assert.equal(clicks.length, 2);
    assert.equal(clicks[0].index, 0);
    assert.equal(clicks[0].target.documentX, 100);
    assert.equal(clicks[1].index, 1);
    assert.equal(clicks[1].target.documentX, 300);
  });

  test('收到 enginePause/engineResume 时记录日志并切换状态', async () => {
    sent = [];
    const port = makePort('engine');
    port.onMessage.addListener(() => {});
    connectListener(port);

    port.postMessage({ type: 'enginePause' });
    await new Promise(r => setTimeout(r, 30));
    assert.ok(
      sent.some(m => m.type === 'log' && /脚本已暂停/.test(m.payload?.message || '')),
      'enginePause 应记录暂停日志'
    );

    port.postMessage({ type: 'engineResume' });
    await new Promise(r => setTimeout(r, 30));
    assert.ok(
      sent.some(m => m.type === 'log' && /脚本已继续/.test(m.payload?.message || '')),
      'engineResume 应记录继续日志'
    );
  });

  test('端口断开时未决调用立即以错误 resolve', async () => {
    sent = [];

    const port = makePort('engine');
    port.onMessage.addListener(() => {});

    connectListener(port);
    port.postMessage({ type: 'engineStart' });
    port.disconnect();

    const deadline = Date.now() + 5000;
    while (!sent.some(m => m.type === 'log' && /脚本执行已停止|后台连接已断开/.test(m.payload?.message || '')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.ok(
      sent.some(m => m.type === 'log' && /脚本执行已停止|后台连接已断开/.test(m.payload?.message || '')),
      '断开后引擎应立即停止（不应等待 15s 超时）'
    );
    assert.ok(
      !sent.some(m => /后台响应超时/.test(m.payload?.message || '')),
      '不应出现后台响应超时'
    );
  });
});