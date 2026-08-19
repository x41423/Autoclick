// utils/storage.js
// 脚本存储管理（增删改查）

const SCRIPTS_KEY = 'scripts';
const DEFAULT_SCRIPT_KEY = 'defaultScriptId';

/**
 * 获取所有脚本列表
 */
export async function getScripts() {
  const result = await chrome.storage.local.get(SCRIPTS_KEY);
  return result[SCRIPTS_KEY] || [];
}

/**
 * 保存或更新脚本（如果id存在则更新，否则新增）
 * @param {object} script - { id, name, actions, version? }
 */
export async function saveScript(script) {
  const scripts = await getScripts();
  const idx = scripts.findIndex(s => s.id === script.id);
  if (idx >= 0) {
    scripts[idx] = { ...scripts[idx], ...script };
  } else {
    if (!script.id) {
      script.id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }
    scripts.push(script);
  }
  await chrome.storage.local.set({ [SCRIPTS_KEY]: scripts });
  return script;
}

/**
 * 删除脚本
 */
export async function deleteScript(id) {
  const scripts = await getScripts();
  const filtered = scripts.filter(s => s.id !== id);
  await chrome.storage.local.set({ [SCRIPTS_KEY]: filtered });
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
  const newScripts = [];
  for (const s of data.scripts) {
    if (existingIds.has(s.id) && strategy === 'rename') {
      // 生成新 id 并修改名称
      const newId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      s.id = newId;
      s.name = s.name + ' (导入)';
    }
    newScripts.push(s);
  }
  // 合并（覆盖或新增）
  const map = new Map(existing.map(s => [s.id, s]));
  for (const s of newScripts) {
    map.set(s.id, s);
  }
  const merged = Array.from(map.values());
  await chrome.storage.local.set({ [SCRIPTS_KEY]: merged });
  return merged;
}