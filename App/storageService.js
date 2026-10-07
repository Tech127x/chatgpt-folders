(function () {
    // @meta StorageService provides shared extension storage with explicit errors.
    const ns = (window.GlynGPT = window.GlynGPT || {});
    class StorageService {
        constructor(options) {
            const opts = options || {};
            this.area = opts.area || "sync";
            this.storageKey = opts.storageKey || "glynFoldersData";
            this._promiseAPI = typeof browser !== "undefined" && browser.storage && browser.storage[this.area] ? browser : null;
            this._callbackAPI = !this._promiseAPI && typeof chrome !== "undefined" && chrome.storage && chrome.storage[this.area] ? chrome : null;
            this._storage = this._promiseAPI ? this._promiseAPI.storage[this.area]
                : this._callbackAPI ? this._callbackAPI.storage[this.area] : null;
            this._saveQueue = Promise.resolve();
        }

        _call(method, argument) {
            if (!this._storage) return Promise.reject(new Error(`Extension storage.${this.area} unavailable`));
            if (this._promiseAPI) return Promise.resolve().then(() => this._storage[method](argument));
            return new Promise((resolve, reject) => {
                this._storage[method](argument, result => {
                    // lastError must be read while the callback runs.
                    const error = this._callbackAPI.runtime && this._callbackAPI.runtime.lastError;
                    if (error) reject(new Error(error.message || String(error)));
                    else resolve(result);
                });
            });
        }

        _enqueue(operation) {
            const result = this._saveQueue.then(operation);
            // Reject the caller while allowing later writes to retry.
            this._saveQueue = result.catch(() => {});
            return result;
        }

        async load(defaultValue) {
            const result = await this.loadKeys({ [this.storageKey]: defaultValue || null });
            return result ? result[this.storageKey] : defaultValue || null;
        }

        save(patch) {
            if (!patch || typeof patch !== "object") return Promise.resolve(false);
            return this._enqueue(() => this._applyPatch(patch));
        }

        async loadKeys(keys) {
            return (await this._call("get", keys)) || {};
        }

        saveKeys(setObj, removeKeys) {
            return this._enqueue(async () => {
                if (!this._storage) throw new Error(`Extension storage.${this.area} unavailable`);
                if (setObj && Object.keys(setObj).length) await this._call("set", setObj);
                // Retain old chunks when writing their replacement fails.
                if (removeKeys && removeKeys.length) await this._call("remove", removeKeys);
                return true;
            });
        }

        dumpAll() {
            return this.loadKeys(null);
        }

        async overwriteAll(map) {
            const existing = await this.dumpAll();
            const incomingKeys = map ? Object.keys(map) : [];
            const toRemove = Object.keys(existing || {}).filter(key => !incomingKeys.includes(key));
            return this.saveKeys(map || {}, toRemove);
        }

        async _applyPatch(patch) {
            const result = await this.loadKeys({ [this.storageKey]: {} });
            const current = result && typeof result[this.storageKey] === "object" ? result[this.storageKey] : {};
            await this._call("set", { [this.storageKey]: Object.assign({}, current, patch) });
            return true;
        }
    }
    ns.StorageService = StorageService;
})();
