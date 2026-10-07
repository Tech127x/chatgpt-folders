const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../App/layoutState.js'), 'utf8');

// Minimal DOM stand-ins: layoutState.save() serializes exclusively from the
// tree structure (children, classList, matches, querySelector), so these are
// enough to reproduce the pending-assignment data-loss scenario.
function makeNode() {
  return {
    parentNode: null,
    children: [],
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index !== -1) this.children.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    querySelector() { return null; }
  };
}

function makeChatRow(id) {
  const link = { getAttribute: name => (name === 'href' ? `/c/${id}` : null) };
  return {
    __glynChatItem: { id: `/c/${id}` },
    matches: selector => selector === '[role="listitem"]',
    querySelector: selector => (selector.includes('a[href') ? link : null)
  };
}

function makeLayout(folderChildren) {
  const documentStub = {
    createElement: () => {
      const el = makeNode();
      el.className = '';
      el.dataset = {};
      el.textContent = '';
      return el;
    }
  };
  const context = vm.createContext({ window: {}, console, document: documentStub });
  vm.runInContext(source, context);

  const folder = {
    id: 'folder-2',
    data: { name: 'First test', color: null },
    contentsEl: makeNode()
  };
  folderChildren.forEach(child => folder.contentsEl.appendChild(child));

  const wrapper = {
    classList: { contains: cls => cls === 'glyn-folder-wrapper' },
    __glynFolderItem: folder,
    dataset: { glynFolderId: 'folder-2' }
  };
  const historyDiv = makeNode();
  historyDiv.appendChild(wrapper);

  const saves = [];
  const storage = {
    saveKeys(setObj, removals) {
      saves.push({ setObj, removals: removals || [] });
      return Promise.resolve(true);
    }
  };
  const layoutState = new context.window.GlynGPT.LayoutState(storage, {
    historyDiv,
    folders: [{
      id: 'folder-2',
      wrapperEl: wrapper,
      folderItem: folder,
      contentsEl: folder.contentsEl
    }]
  }, null);
  return { layoutState, saves, historyDiv, folder };
}

function childIds(payload) {
  const entries = payload && Array.isArray(payload.ch) ? payload.ch : [];
  return entries.map(entry => `${entry.t}:${entry.i}`).join(',');
}

function makeFolder(id, name) {
  return { id, data: { name, color: null }, contentsEl: makeNode() };
}

function makeWrapper(folder, id) {
  return {
    classList: { contains: cls => cls === 'glyn-folder-wrapper' },
    __glynFolderItem: folder,
    dataset: { glynFolderId: id }
  };
}

function makeSerializationLayout(rootChildren) {
  const documentStub = { createElement: () => makeNode() };
  const context = vm.createContext({ window: {}, console, document: documentStub });
  vm.runInContext(source, context);
  const historyDiv = makeNode();
  rootChildren.forEach(child => historyDiv.appendChild(child));
  const saves = [];
  const storage = {
    saveKeys(setObj, removals) {
      saves.push({ setObj, removals: removals || [] });
      return Promise.resolve(true);
    }
  };
  const layoutState = new context.window.GlynGPT.LayoutState(
    storage,
    { historyDiv, folders: [] },
    null
  );
  return { layoutState, saves, historyDiv };
}

(async () => {
  // 1. Restored assignment whose sidebar row has not rendered yet: the
  //    placeholder must not cause the folder payload to lose its chat.
  {
    const f = makeLayout([]);
    f.layoutState._registerPendingChat('chat-1', f.folder.contentsEl, f.folder);
    assert.equal(f.folder.contentsEl.children.length, 1, 'placeholder registered');

    await f.layoutState.save();
    const { setObj, removals } = f.saves[f.saves.length - 1];
    assert.ok(setObj.f2 && typeof setObj.f2 === 'object', 'folder payload written');
    assert.equal(setObj.f2.n, 'First test', 'folder metadata preserved');
    assert.equal(childIds(setObj.f2), 'c:chat-1', 'pending chat must survive serialization');
    assert.ok(!Array.from(removals).includes('f2'), 'folder base key must not be removed');
    console.log('PASS pending: unrendered chat preserved during save');
  }

  // 2. Hydrated row plus a still-registered pending entry (hydration ordering
  //    race) must serialize exactly once.
  {
    const f = makeLayout([makeChatRow('chat-1')]);
    f.layoutState._registerPendingChat('chat-1', f.folder.contentsEl, f.folder);

    await f.layoutState.save();
    const { setObj } = f.saves[f.saves.length - 1];
    assert.equal(childIds(setObj.f2), 'c:chat-1', 'hydrated chat must not be duplicated');
    console.log('PASS pending: hydrated chat not duplicated');
  }

  // 3. Root-level pending placeholders have no folder assignment and must not
  //    be attached to a folder (root chats are intentionally not persisted).
  {
    const f = makeLayout([]);
    f.layoutState._registerPendingChat('chat-root', f.historyDiv, null);

    await f.layoutState.save();
    const { setObj } = f.saves[f.saves.length - 1];
    assert.ok(setObj.f2, 'folder still saved');
    assert.equal(setObj.f2.ch, undefined, 'root pending must not leak into folders');
    console.log('PASS pending: root pending does not leak into folders');
  }

  // 4. Canonical nested layout round-trips: root ch lists only folder-1, the
  //    global fi index keeps both ids, and folder-2 stays nested.
  {
    const f1 = makeFolder('folder-1', 'New Folder');
    const f2 = makeFolder('folder-2', 'First test');
    f2.contentsEl.appendChild(makeChatRow('chat-1'));
    f1.contentsEl.appendChild(makeWrapper(f2, 'folder-2'));
    const f = makeSerializationLayout([makeWrapper(f1, 'folder-1')]);

    await f.layoutState.save();
    const { setObj } = f.saves[f.saves.length - 1];
    assert.equal(childIds(setObj.f0), 'f:1', 'root ch lists only the root folder');
    assert.equal(Array.from(setObj.f0.fi).join(','), '1,2', 'fi keeps the global index');
    assert.equal(childIds(setObj.f1), 'f:2', 'folder-2 serialized nested');
    assert.equal(childIds(setObj.f2), 'c:chat-1', 'chat serialized under folder-2');
    console.log('PASS serialization: nested folder round-trips without root duplication');
  }

  // 5. Two wrappers for the same logical id (root + nested) must not serialize
  //    as a contradictory root+nested representation.
  {
    const f1 = makeFolder('folder-1', 'New Folder');
    const f2root = makeFolder('folder-2', 'Root copy');
    f2root.contentsEl.appendChild(makeChatRow('chat-1'));
    const f2nested = makeFolder('folder-2', 'Nested copy');
    f1.contentsEl.appendChild(makeWrapper(f2nested, 'folder-2'));
    const f = makeSerializationLayout([
      makeWrapper(f2root, 'folder-2'),
      makeWrapper(f1, 'folder-1')
    ]);

    await f.layoutState.save();
    const { setObj } = f.saves[f.saves.length - 1];
    const references = [];
    ['f0', 'f1', 'f2'].forEach(key => {
      const payload = setObj[key];
      const ch = payload && Array.isArray(payload.ch) ? payload.ch : [];
      ch.forEach(entry => {
        if (entry && entry.t === 'f' && entry.i === 2) references.push(key);
      });
    });
    assert.equal(references.length, 1, 'folder-2 referenced exactly once across the graph');
    assert.equal(setObj.f2.n, 'Root copy', 'first traversal occurrence wins');
    console.log('PASS serialization: duplicate wrappers cannot contradict the graph');
  }

  console.log('PASS layoutState pending-assignment persistence');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
