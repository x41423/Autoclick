import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupChromeMock } from './helpers/chrome-mock.js';
import { log, getLogs, clearLogs } from '../autoclick/utils/logger.js';

const { local } = setupChromeMock();

beforeEach(() => {
  local._reset();
});

const originalConsoleLog = console.log;

describe('logger', () => {
  beforeEach(() => {
    console.log = () => {};
  });
  after(() => {
    console.log = originalConsoleLog;
  });

  test('log 写入带时间戳/级别/标签/消息的格式化日志', async () => {
    await log('INFO', '[BG]', '测试消息');
    const logs = await getLogs();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\] \[BG\] 测试消息$/);
  });

  test('日志队列超过 200 条时循环截断（保留最新）', async () => {
    for (let i = 0; i < 250; i++) {
      await log('DEBUG', '[T]', `第${i}条`);
    }
    const logs = await getLogs();
    assert.equal(logs.length, 200);
    assert.match(logs[199], /第249条$/);
    assert.doesNotMatch(logs[0], /第0条$/);
  });

  test('clearLogs 清空日志队列', async () => {
    await log('WARN', '[T]', '待清理');
    await clearLogs();
    assert.deepEqual(await getLogs(), []);
  });
});