const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../App/folderManager.js'), 'utf8');

function makeNode() {
  return {
    parentNode: null,
    children: [],
    dataset: {},
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
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector() { return null; }
  };
}

const context = vm.createContext({ window: {}, console });
vm.runInContext(source, context);
const FolderManager = context.window.GlynGPT.FolderManager;

const historyDiv = makeNode();
const wrappers = [];
historyDiv.querySelectorAll = () => wrappers.filter(node => node.parentNode === historyDiv);

const manager = new FolderManager(historyDiv, null, null);
const trackedWrapper = makeNode();
manager.folders.push({
  id: 'folder-2',
  wrapperEl: trackedWrapper,
  folderItem: {},
  contentsEl: makeNode()
});

// 1. A duplicate wrapper that contains a conversation row must be retained.
const duplicateWithChat = makeNode();
duplicateWithChat.dataset.glynFolderId = 'folder-2';
const chatLink = { matches: selector => selector === 'a.__menu-item' };
duplicateWithChat.querySelector = selector => (selector.includes('a[href') ? chatLink : null);
historyDiv.appendChild(duplicateWithChat);
wrappers.push(duplicateWithChat);

manager.removeDuplicateWrappers();
assert.equal(
  duplicateWithChat.parentNode,
  historyDiv,
  'duplicate wrapper containing a chat must not be removed'
);
console.log('PASS cleanup: duplicate wrapper with chats is retained');

// 2. An empty duplicate wrapper is still removable.
const emptyDuplicate = makeNode();
emptyDuplicate.dataset.glynFolderId = 'folder-2';
emptyDuplicate.querySelector = () => null;
historyDiv.appendChild(emptyDuplicate);
wrappers.push(emptyDuplicate);

manager.removeDuplicateWrappers();
assert.equal(emptyDuplicate.parentNode, null, 'empty duplicate wrapper is removed');
console.log('PASS cleanup: empty duplicate wrapper is removed');

// 3. An untracked wrapper that contains a conversation row is also retained.
const untrackedWithChat = makeNode();
untrackedWithChat.dataset.glynFolderId = 'folder-9';
const untrackedLink = { matches: selector => selector === 'a.__menu-item' };
untrackedWithChat.querySelector = selector => (selector.includes('a[href') ? untrackedLink : null);
historyDiv.appendChild(untrackedWithChat);
wrappers.push(untrackedWithChat);

manager.removeDuplicateWrappers();
assert.equal(
  untrackedWithChat.parentNode,
  historyDiv,
  'untracked wrapper containing a chat must not be removed'
);
console.log('PASS cleanup: untracked wrapper with chats is retained');

console.log('PASS folderManager duplicate-wrapper cleanup guard');
