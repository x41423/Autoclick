import { before } from 'node:test';

export function createStorageMock() {
  const store = new Map();

  const area = {
    async get(keys) {
      if (keys === undefined || keys === null) {
        return Object.fromEntries(store);
      }
      if (typeof keys === 'string') {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) {
          result[key] = store.get(key);
        }
        return result;
      }
      if (typeof keys === 'object') {
        const result = {};
        for (const key of Object.keys(keys)) {
          result[key] = store.has(key) ? store.get(key) : keys[key];
        }
        return result;
      }
      return {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, structuredClone(value));
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        store.delete(key);
      }
    },
    _raw() {
      return Object.fromEntries(store);
    },
    _reset() {
      store.clear();
    }
  };

  return area;
}

export function setupChromeMock() {
  const local = createStorageMock();
  const session = createStorageMock();

  globalThis.chrome = {
    storage: { local, session },
    runtime: {
      sendMessage: async () => ({ success: true })
    }
  };

  return { local, session };
}

export function installChromeMock() {
  let mock;
  before(() => {
    mock = setupChromeMock();
  });
  return {
    get local() { return mock.local; },
    get session() { return mock.session; },
    get chrome() { return mock; }
  };
}