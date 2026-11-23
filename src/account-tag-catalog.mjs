import { readFile } from "node:fs/promises";
import { DEFAULT_TAG_OPTIONS, readAccountTags } from "../shared/account-tags.mjs";
import { writePrivateJsonAtomic } from "./account-history.mjs";

// Keep custom choices available to other accounts even after the original
// account changes labels. Serialize updates made under different email locks.
export function createAccountTagCatalog(file) {
  let pending = Promise.resolve();
  async function read() {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return DEFAULT_TAG_OPTIONS; throw error; }
  }
  function add(options, { merchant, trip }) {
    if (merchant) options.merchants.add(merchant);
    if (trip) options.trips.add(trip);
  }
  function sets(saved) {
    return {
      merchants: new Set([...DEFAULT_TAG_OPTIONS.merchants, ...saved.merchants]),
      trips: new Set([...DEFAULT_TAG_OPTIONS.trips, ...saved.trips]),
    };
  }
  function serialize(options) { return { merchants: [...options.merchants], trips: [...options.trips] }; }
  return {
    remember(tags) {
      const write = pending.then(async () => {
        const saved = await read();
        const options = sets(saved);
        if ((!tags.merchant || options.merchants.has(tags.merchant)) && (!tags.trip || options.trips.has(tags.trip))) return;
        add(options, tags);
        await writePrivateJsonAtomic(file, serialize(options));
      });
      pending = write.catch(() => {});
      return write;
    },
    async list(jobs) {
      await pending;
      const options = sets(await read());
      for (const job of jobs) if (!job.deleted) add(options, readAccountTags(job.remark, job.accountTagsCleared));
      return serialize(options);
    },
  };
}
