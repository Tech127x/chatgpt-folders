const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../App/storageService.js'), 'utf8');
function fixture(mode) {
  const state = {}, calls = [], api = { runtime: {} }; let failure;
  function execute(method, arg) {
    calls.push(method);
    if (failure === method) { failure = null; throw new Error(`${method} failed`); }
    if (method === 'set') Object.assign(state, arg);
    if (method === 'remove') arg.forEach(k => delete state[k]);
    if (method === 'get') {
      if (arg === null) return { ...state };
      const result = Array.isArray(arg) ? {} : { ...arg };
      for (const key of Array.isArray(arg) ? arg : Object.keys(arg)) if (key in state) result[key] = state[key];
      return result;
    }
  }
  const area = {};
  for (const method of ['get', 'set', 'remove']) area[method] = mode === 'browser'
    ? async arg => execute(method, arg)
    : (arg, callback) => queueMicrotask(() => {
      let value; try { value = execute(method, arg); } catch (error) { api.runtime.lastError = { message: error.message }; }
      callback(value); delete api.runtime.lastError;
    });
  api.storage = { sync: area };
  const context = vm.createContext({ window: {}, [mode]: api }); vm.runInContext(source, context);
  const service = new context.window.GlynGPT.StorageService({ area: 'sync', storageKey: 'settings' });
  return { service, state, calls, fail: method => failure = method };
}
(async () => {
  for (const mode of ['browser', 'chrome']) {
    const f = fixture(mode);
    await f.service.saveKeys({ f1: { ch: [{ t: 'c', i: 'chat' }] }, old: 1 });
    assert.equal((await f.service.dumpAll()).f1.ch[0].i, 'chat');
    f.fail('get'); await assert.rejects(f.service.dumpAll(), /get failed/);
    f.fail('set'); const before = f.calls.length;
    await assert.rejects(f.service.saveKeys({ f1: 'replacement' }, ['old']), /set failed/);
    assert.deepEqual(f.calls.slice(before), ['set']); assert.equal(f.state.old, 1);
    await f.service.saveKeys({ f1: 'retry' }, ['old']); assert.equal(f.state.f1, 'retry'); assert.equal(f.state.old, undefined);
    f.fail('remove'); await assert.rejects(f.service.saveKeys({}, ['f1']), /remove failed/);
    await f.service.save({ a: 1 }); await f.service.save({ b: 2 }); assert.equal(f.state.settings.a, 1); assert.equal(f.state.settings.b, 2);
    f.fail('get'); await assert.rejects(f.service.save({ c: 3 }), /get failed/);
    await f.service.save({ d: 4 }); assert.equal(f.state.settings.d, 4);
    f.fail('get'); await assert.rejects(f.service.overwriteAll({ replacement: 1 }), /get failed/); assert.equal(f.state.replacement, undefined);
    console.log(`PASS ${mode}: read/write/remove failures, failed-write chunk retention, retry, merge, export/import errors`);
  }
  const context = vm.createContext({ window: { localStorage: { getItem() { throw new Error('must not use page storage'); } } } });
  vm.runInContext(source, context); const service = new context.window.GlynGPT.StorageService();
  await assert.rejects(service.dumpAll(), /unavailable/); await assert.rejects(service.saveKeys({ f1: 1 }), /unavailable/);
  console.log('PASS missing API: explicit failure, no page localStorage fallback');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../App/manifest.json'), 'utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.id, 'chatgpt-folders@tech127x');
})().catch(error => { console.error(error); process.exitCode = 1; });
