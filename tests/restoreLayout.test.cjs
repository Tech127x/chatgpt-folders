const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../App/layoutState.js'), 'utf8');

// Minimal DOM/folder/storage harness for LayoutState.restore(). The folder
// manager stub mirrors the production record semantics (first record for an id
// wins), including the pre-guard duplicate removal, so restore-level defects
// are observable without a browser. The removeDuplicateWrappers chat guard is
// covered separately in tests/folderManager.test.cjs.
function runScenario(payloads, options) {
  const opts = options || {};
  const docRoot = makeNode('DOCUMENT');
  const list = makeNode('DIV');
  list.setAttribute('role', 'list');
  docRoot.appendChild(list);

  const records = [];
  let counter = 0;

  function makeNode(tag) {
    const node = {
      tagName: tag,
      children: [],
      parentNode: null,
      attrs: {},
      dataset: {},
      style: {},
      className: '',
      textContent: '',
      __glynChatItem: null,
      __glynFolderItem: null,
      __isWrapper: false,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      matches() { return false; },
      closest() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    };
    Object.defineProperty(node, 'isConnected', {
      get() {
        let current = node;
        while (current.parentNode) current = current.parentNode;
        return current === docRoot;
      }
    });
    node.classList = { contains: (name) => name === 'glyn-folder-wrapper' && node.__isWrapper };
    return node;
  }

  const collectWrappers = (node) => {
    const found = [];
    const walk = (current) => {
      current.children.forEach((child) => {
        if (child.__isWrapper) found.push(child);
        walk(child);
      });
    };
    walk(node);
    return found;
  };

  const chatHref = '/c/chat-1';
  const link = {
    getAttribute(name) { return name === 'href' ? chatHref : null; }
  };
  const row = makeNode('DIV');
  row.setAttribute('role', 'listitem');
  row.matches = (selector) => selector === '[role="listitem"]';
  const chatItem = { id: chatHref, el: row };
  row.__glynChatItem = chatItem;
  link.__glynChatItem = chatItem;
  if (opts.rowPresent !== false) {
    list.appendChild(row);
  }
  list.querySelectorAll = () => (opts.rowPresent !== false ? [link] : []);

  const folderManager = {
    historyDiv: list,
    folders: records,
    suspendNotifications() {},
    resumeNotifications() {},
    clearAllFolders() {},
    createFolder(name, createOptions) {
      const o = createOptions || {};
      const id = o.id || `folder-${++counter}`;
      const wrapper = makeNode('DIV');
      wrapper.__isWrapper = true;
      wrapper.dataset.glynFolderId = id;
      const contentsEl = makeNode('DIV');
      wrapper.appendChild(contentsEl);
      const container = o.parentFolder && o.parentFolder.contentsEl
        ? o.parentFolder.contentsEl
        : list;
      container.appendChild(wrapper);
      const folder = makeNode('DIV');
      folder.id = id;
      folder.data = { name, color: null };
      folder.contentsEl = contentsEl;
      folder.setExpanded = () => {};
      folder.addChild = () => {};
      wrapper.__glynFolderItem = folder;
      contentsEl.__glynFolderItem = folder;
      records.push({
        id,
        wrapperEl: wrapper,
        folderItem: folder,
        contentsEl,
        parentId: o.parentFolder ? o.parentFolder.id : null
      });
      return folder;
    },
    getRecordById(id) {
      return records.find((record) => record.id === id) || null;
    },
    getRootChatLinks() { return []; },
    ensureFolderMounts() {},
    pinFoldersAtTop() {},
    removeDuplicateWrappers() {
      collectWrappers(list).forEach((node) => {
        const id = node.dataset.glynFolderId;
        if (!id) return;
        const record = records.find((entry) => entry.id === id);
        if (!record) { node.remove(); return; }
        if (record.wrapperEl !== node) { node.remove(); }
      });
    }
  };

  const historyManager = {
    suspendNotifications() {},
    resumeNotifications() {},
    resetFromLinks() {}
  };

  const storage = {
    loadKeys(keys) {
      const result = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(payloads, key)) {
          result[key] = payloads[key];
        }
      });
      return Promise.resolve(result);
    }
  };

  const documentStub = {
    createElement: () => makeNode('DIV'),
    querySelectorAll: () => []
  };

  const context = vm.createContext({ window: {}, console, document: documentStub });
  vm.runInContext(source, context);
  const layoutState = new context.window.GlynGPT.LayoutState(
    storage,
    folderManager,
    historyManager
  );

  return layoutState.restore().then(() => ({
    layoutState,
    records,
    list,
    row,
    collectWrappers
  }));
}

const malformedPayloads = {
  f0: { ch: [{ t: 'f', i: 1 }], fi: [1, 2], v: 2 },
  f1: { ch: [{ t: 'f', i: 2 }], n: 'New Folder' },
  f2: { ch: [{ t: 'c', i: 'chat-1' }], n: 'First test' }
};

(async () => {
  // 1. Malformed-but-globally-indexed graph: f2 is transitively reachable
  //    through f1.ch and must materialize exactly once, nested under f1.
  {
    const state = await runScenario(malformedPayloads);
    const folderOne = state.records.filter((record) => record.id === 'folder-1');
    const folderTwo = state.records.filter((record) => record.id === 'folder-2');
    assert.equal(folderOne.length, 1, 'folder-1 materialized exactly once');
    assert.equal(folderTwo.length, 1, 'folder-2 materialized exactly once');
    assert.equal(
      folderTwo[0].wrapperEl.parentNode,
      folderOne[0].contentsEl,
      'folder-2 restored nested under folder-1'
    );
    assert.equal(
      folderTwo[0].contentsEl.children.filter((child) => child === state.row).length,
      1,
      'chat applied exactly once'
    );
    console.log('PASS restore: malformed fi graph materializes each folder once');
  }

  // 2. Same graph: the moved chat row must remain connected after the
  //    restore cleanup (duplicate removal) runs.
  {
    const state = await runScenario(malformedPayloads);
    assert.equal(state.row.isConnected, true, 'chat row remains connected');
    assert.equal(
      state.records.filter((record) => record.id === 'folder-2')[0].contentsEl.parentNode.parentNode,
      state.records.filter((record) => record.id === 'folder-1')[0].contentsEl,
      'chat row lives in the single nested folder-2'
    );
    console.log('PASS restore: chat row stays connected through cleanup');
  }

  // 3. Missing chat row: exactly one pending assignment and placeholder.
  {
    const state = await runScenario(malformedPayloads, { rowPresent: false });
    const folderTwo = state.records.filter((record) => record.id === 'folder-2');
    assert.equal(folderTwo.length, 1, 'folder-2 materialized exactly once');
    assert.equal(state.layoutState.pendingAssignments.size, 1, 'one pending assignment');
    assert.equal(
      folderTwo[0].contentsEl.children.filter(
        (child) => child.className === 'glyn-chat-placeholder'
      ).length,
      1,
      'one placeholder inside the single folder-2'
    );
    console.log('PASS restore: absent chat yields exactly one pending placeholder');
  }

  // 4. Legitimate fi-only folder (no ch reference anywhere) still restores at
  //    the root.
  {
    const state = await runScenario({
      f0: { ch: [{ t: 'f', i: 1 }], fi: [1, 2], v: 2 },
      f1: { ch: [], n: 'New Folder' },
      f2: { ch: [{ t: 'c', i: 'chat-1' }], n: 'First test' }
    });
    const folderTwo = state.records.filter((record) => record.id === 'folder-2');
    assert.equal(folderTwo.length, 1, 'orphan folder restored exactly once');
    assert.equal(folderTwo[0].wrapperEl.parentNode, state.list, 'orphan restored at root');
    assert.equal(state.row.isConnected, true, 'orphan chat row connected');
    console.log('PASS restore: fi-only orphan folder restores at root');
  }

  // 5. Duplicate/cyclic references cannot create duplicate logical folders.
  {
    const state = await runScenario({
      f0: { ch: [{ t: 'f', i: 1 }], fi: [1, 2, 3], v: 2 },
      f1: { ch: [{ t: 'f', i: 2 }], n: 'One' },
      f2: { ch: [{ t: 'f', i: 3 }, { t: 'f', i: 3 }], n: 'Two' },
      f3: { ch: [{ t: 'c', i: 'chat-1' }], n: 'Three' }
    });
    assert.equal(state.records.filter((record) => record.id === 'folder-1').length, 1);
    assert.equal(state.records.filter((record) => record.id === 'folder-2').length, 1);
    assert.equal(state.records.filter((record) => record.id === 'folder-3').length, 1);
    const folderTwo = state.records.find((record) => record.id === 'folder-2');
    const folderThree = state.records.find((record) => record.id === 'folder-3');
    assert.equal(folderThree.wrapperEl.parentNode, folderTwo.contentsEl, 'folder-3 stays nested');
    assert.equal(state.row.isConnected, true, 'chat row connected');
    console.log('PASS restore: duplicate/cyclic references stay single-instance');
  }

  console.log('PASS restore layout contract suite');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
