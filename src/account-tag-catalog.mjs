import { readFile } from "node:fs/promises";
import { DEFAULT_TAG_OPTIONS, TAG_OPTION_KEYS, readAccountTags } from "../shared/account-tags.mjs";
import { writePrivateJsonAtomic } from "./account-history.mjs";

const creatableOptions = Object.entries(TAG_OPTION_KEYS).filter(([field]) => field !== "validity");
const catalogKeys = Object.values(TAG_OPTION_KEYS);

// Keep custom choices available to other accounts even after the original
// account changes labels. Serialize updates made under different email locks.
export function createAccountTagCatalog(file) {
  let pending = Promise.resolve();
  async function read() {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return DEFAULT_TAG_OPTIONS; throw error; }
  }
  function sets(saved = {}) {
    return Object.fromEntries(catalogKeys.map(key => [key, new Set(saved[key] ?? [])]));
  }
  function serialize(options) { return Object.fromEntries(catalogKeys.map(key => [key, [...options[key]]])); }
  function update(change) {
    const write = pending.then(async () => {
      const saved = await read();
      const choices = sets(saved);
      const removed = sets(saved.removed);
      if (change(choices, removed)) {
        await writePrivateJsonAtomic(file, { ...serialize(choices), removed: serialize(removed) });
      }
    });
    pending = write.catch(() => {});
    return write;
  }
  return {
    remember(patch, tags) {
      if (!creatableOptions.some(([field]) => Object.hasOwn(patch, field) && tags[field])) return;
      return update((choices, removed) => {
        let changed = false;
        for (const [field, key] of creatableOptions) {
          const value = tags[field];
          if (!Object.hasOwn(patch, field) || !value) continue;
          const wasRemoved = removed[key].delete(value);
          if (wasRemoved || (!choices[key].has(value) && !DEFAULT_TAG_OPTIONS[key].includes(value))) {
            choices[key].add(value);
            changed = true;
          }
        }
        return changed;
      });
    },
    remove(field, value) {
      return update((choices, removed) => {
        const key = TAG_OPTION_KEYS[field];
        if (removed[key].has(value)) return false;
        choices[key].delete(value);
        removed[key].add(value);
        return true;
      });
    },
    async list(jobs) {
      await pending;
      const saved = await read();
      const options = sets(DEFAULT_TAG_OPTIONS);
      const removed = sets(saved.removed);
      for (const key of catalogKeys) {
        for (const value of saved[key] ?? []) options[key].add(value);
      }
      for (const job of jobs) {
        if (job.deleted) continue;
        const tags = readAccountTags(job.remark, job.accountTagsCleared);
        for (const [field, key] of creatableOptions) {
          if (tags[field]) options[key].add(tags[field]);
        }
      }
      for (const key of catalogKeys) {
        for (const value of removed[key]) options[key].delete(value);
      }
      return serialize(options);
    },
  };
}
