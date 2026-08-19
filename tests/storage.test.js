import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupChromeMock } from './helpers/chrome-mock.js';
import {
  getScripts,
  saveScript,
  deleteScript,
  getDefaultScriptId,
  setDefaultScriptId,
  exportScripts,
  importScripts
} from '../autoclick/utils/storage.js';

const { local } = setupChromeMock();

function makeScript(overrides = {}) {
  return { id: 's1', name: '脚本A', actions: [], ...overrides };
}

beforeEach(() => {
  local._reset();
});

describe('getScripts', () => {
  test('返回空数组（无任何数据时）', async () => {
    assert.deepEqual(await getScripts(), []);
  });

  test('迁移旧版 scripts 数组数据到按脚本独立存储', async () => {
    const s1 = makeScript({ id: 'old1', name: '旧脚本1' });
    const s2 = makeScript({ id: 'old2', name: '旧脚本2' });
    await local.set({ scripts: [s1, s2] });

    const scripts = await getScripts();

    assert.deepEqual(scripts, [s1, s2]);
    const raw = local._raw();
    assert.equal(raw.scripts, undefined, '迁移后应删除旧版 scripts 键');
    assert.deepEqual(raw.scriptIds, ['old1', 'old2']);
    assert.deepEqual(raw['script:old1'], s1);
    assert.deepEqual(raw['script:old2'], s2);
  });
});

describe('saveScript', () => {
  test('无 id 时生成 id 并新增脚本', async () => {
    const saved = await saveScript({ name: '新脚本', actions: [] });
    assert.ok(saved.id);
    const scripts = await getScripts();
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].id, saved.id);
  });

  test('更新已存在脚本时合并字段', async () => {
    await saveScript(makeScript());
    await saveScript(makeScript({ name: '改名', actions: [{ type: 'delay', value: 100 }] }));

    const scripts = await getScripts();
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].name, '改名');
    assert.deepEqual(scripts[0].actions, [{ type: 'delay', value: 100 }]);
  });

  test('脚本独立存储到 script:<id> 键，不产生整数组 scripts 键', async () => {
    const s = makeScript({ id: 'k1' });
    await saveScript(s);

    const raw = local._raw();
    assert.equal(raw.scripts, undefined, '不应再写入整数组 scripts 键');
    assert.deepEqual(raw['script:k1'], s);
    assert.deepEqual(raw.scriptIds, ['k1']);
  });

  test('新增第二个脚本不影响第一个脚本的数据', async () => {
    await saveScript(makeScript({ id: 'k1', name: 'A' }));
    await saveScript(makeScript({ id: 'k2', name: 'B' }));

    const raw = local._raw();
    assert.deepEqual(raw['script:k1'], makeScript({ id: 'k1', name: 'A' }));
    assert.deepEqual(raw.scriptIds, ['k1', 'k2']);
  });
});

describe('deleteScript', () => {
  test('删除脚本及其 id 记录', async () => {
    await saveScript(makeScript({ id: 'k1' }));
    await saveScript(makeScript({ id: 'k2' }));

    await deleteScript('k1');

    const scripts = await getScripts();
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].id, 'k2');
    const raw = local._raw();
    assert.equal(raw['script:k1'], undefined);
    assert.deepEqual(raw.scriptIds, ['k2']);
  });
});

describe('getDefaultScriptId', () => {
  test('无脚本时返回 undefined', async () => {
    assert.equal(await getDefaultScriptId(), undefined);
  });

  test('未设置时回退到第一个脚本并持久化', async () => {
    await saveScript(makeScript({ id: 'k1' }));
    await saveScript(makeScript({ id: 'k2' }));

    const id = await getDefaultScriptId();
    assert.equal(id, 'k1');
    assert.equal(local._raw().defaultScriptId, 'k1');
  });

  test('返回已设置的默认脚本 id', async () => {
    await saveScript(makeScript({ id: 'k1' }));
    await saveScript(makeScript({ id: 'k2' }));
    await setDefaultScriptId('k2');
    assert.equal(await getDefaultScriptId(), 'k2');
  });
});

describe('setDefaultScriptId', () => {
  test('持久化默认脚本 id', async () => {
    await setDefaultScriptId('xyz');
    assert.equal(local._raw().defaultScriptId, 'xyz');
  });
});

describe('exportScripts', () => {
  test('导出包含 version、exportedAt 和 scripts 数组', async () => {
    await saveScript(makeScript({ id: 'k1' }));
    const json = await exportScripts();
    const data = JSON.parse(json);
    assert.equal(data.version, 1);
    assert.ok(data.exportedAt);
    assert.equal(data.scripts.length, 1);
    assert.equal(data.scripts[0].id, 'k1');
  });
});

describe('importScripts', () => {
  test('缺少 scripts 数组时抛出错误', async () => {
    await assert.rejects(() => importScripts('{"foo": 1}'), /无效的脚本文件/);
  });

  test('导入新脚本并与已有脚本合并', async () => {
    await saveScript(makeScript({ id: 'k1', name: '已有' }));
    const imported = await importScripts(JSON.stringify({
      scripts: [makeScript({ id: 'k2', name: '导入的' })]
    }));
    assert.equal(imported.length, 2);
    const scripts = await getScripts();
    assert.deepEqual(scripts.map(s => s.id), ['k1', 'k2']);
  });

  test('id 冲突时 rename 策略生成新 id 并追加名称', async () => {
    await saveScript(makeScript({ id: 'k1', name: '冲突' }));
    const imported = await importScripts(JSON.stringify({
      scripts: [makeScript({ id: 'k1', name: '冲突' })]
    }));
    assert.equal(imported.length, 2);
    const renamed = imported.find(s => s.id !== 'k1');
    assert.ok(renamed, '应生成新 id');
    assert.equal(renamed.name, '冲突 (导入)');
  });

  test('id 冲突时 overwrite 策略覆盖已有脚本', async () => {
    await saveScript(makeScript({ id: 'k1', name: '原有名字' }));
    const imported = await importScripts(JSON.stringify({
      scripts: [makeScript({ id: 'k1', name: '覆盖名字' })]
    }), 'overwrite');
    assert.equal(imported.length, 1);
    assert.equal(imported[0].name, '覆盖名字');
  });
});