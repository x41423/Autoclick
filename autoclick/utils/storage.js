// utils/storage.js
// 脚本存储管理（增删改查）
// 存储结构：每个脚本独立键 script:<id>，scriptIds 记录顺序，支持旧版整数组迁移

const LEGACY_SCRIPTS_KEY = 'scripts';
const SCRIPT_PREFIX = 'script:';
const SCRIPT_IDS_KEY = 'scriptIds';
const DEFAULT_SCRIPT_KEY = 'defaultScriptId';

/**
 * 迁移旧版数据（整数组 scripts 键 → 按脚本独立存储）
 */
async function migrateLegacyData() {
  const legacy = await chrome.storage.local.get(LEGACY_SCRIPTS_KEY);
  const list = legacy[LEGACY_SCRIPTS_KEY];
  if (!list || !Array.isArray(list)) return;
  const items = {};
  for (const script of list) {
    if (script && script.id) items[SCRIPT_PREFIX + script.id] = script;
  }
  items[SCRIPT_IDS_KEY] = list.filter(s => s && s.id).map(s => s.id);
  await chrome.storage.local.set(items);
  await chrome.storage.local.remove(LEGACY_SCRIPTS_KEY);
}

/**
 * 获取所有脚本列表
 */
export async function getScripts() {
  await migrateLegacyData();
  const result = await chrome.storage.local.get(SCRIPT_IDS_KEY);
  const ids = result[SCRIPT_IDS_KEY] || [];
  if (ids.length === 0) return [];
  const scripts = await chrome.storage.local.get(ids.map(id => SCRIPT_PREFIX + id));
  return ids
    .map(id => scripts[SCRIPT_PREFIX + id])
    .filter(Boolean);
}

/**
 * 保存或更新脚本（如果id存在则更新，否则新增）
 * @param {object} script - { id, name, actions, version? }
 */
export async function saveScript(script) {
  await migrateLegacyData();
  if (!script.id) {
    script.id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }
  const result = await chrome.storage.local.get(SCRIPT_IDS_KEY);
  const ids = result[SCRIPT_IDS_KEY] || [];
  const isNew = !ids.includes(script.id);
  if (isNew) {
    ids.push(script.id);
  }
  await chrome.storage.local.set({
    [SCRIPT_PREFIX + script.id]: script,
    [SCRIPT_IDS_KEY]: ids
  });
  return script;
}

/**
 * 删除脚本
 */
export async function deleteScript(id) {
  await migrateLegacyData();
  const result = await chrome.storage.local.get(SCRIPT_IDS_KEY);
  const ids = result[SCRIPT_IDS_KEY] || [];
  await chrome.storage.local.set({
    [SCRIPT_IDS_KEY]: ids.filter(sid => sid !== id)
  });
  await chrome.storage.local.remove(SCRIPT_PREFIX + id);
}

/**
 * 获取默认脚本ID（如果未设置，返回第一个）
 */
export async function getDefaultScriptId() {
  const result = await chrome.storage.local.get(DEFAULT_SCRIPT_KEY);
  let id = result[DEFAULT_SCRIPT_KEY];
  if (!id) {
    const scripts = await getScripts();
    if (scripts.length > 0) {
      id = scripts[0].id;
      await chrome.storage.local.set({ [DEFAULT_SCRIPT_KEY]: id });
    }
  }
  return id;
}

/**
 * 设置默认脚本
 */
export async function setDefaultScriptId(id) {
  await chrome.storage.local.set({ [DEFAULT_SCRIPT_KEY]: id });
}

/**
 * 导出脚本数据（用于下载）
 */
export async function exportScripts() {
  const scripts = await getScripts();
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    scripts: scripts
  };
  return JSON.stringify(data, null, 2);
}

/**
 * 导入脚本数据
 * @param {string} jsonStr - JSON 字符串
 * @param {string} strategy - 'rename' 或 'overwrite'，默认 'rename'
 */
export async function importScripts(jsonStr, strategy = 'rename') {
  const data = JSON.parse(jsonStr);
  if (!data.scripts || !Array.isArray(data.scripts)) {
    throw new Error('无效的脚本文件：缺少 scripts 数组');
  }
  const existing = await getScripts();
  const existingIds = new Set(existing.map(s => s.id));
  for (const s of data.scripts) {
    if (!s.id) {
      s.id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }
    if (existingIds.has(s.id) && strategy === 'rename') {
      s.id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      s.name = s.name + ' (导入)';
    }
    await saveScript(s);
  }
  return getScripts();
}