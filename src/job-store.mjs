// The private account email is stable for the lifetime of a job; login aliases
// and mutable fields (e.g. status, deleted) are deliberately not indexed.
export class JobStore {
  #jobs = new Map();
  #idsByEmail = new Map();

  get(id) { return this.#jobs.get(id); }
  has(id) { return this.#jobs.has(id); }
  values() { return this.#jobs.values(); }

  set(id, job) {
    const key = job.email.toLowerCase();
    const previous = this.get(id);
    if (previous && previous.email.toLowerCase() !== key) this.#detach(id, previous);
    let ids = this.#idsByEmail.get(key);
    if (!ids) this.#idsByEmail.set(key, ids = new Set());
    ids.add(id);
    this.#jobs.set(id, job);
  }

  delete(id) {
    const job = this.get(id);
    if (!job) return false;
    this.#detach(id, job);
    return this.#jobs.delete(id);
  }

  #detach(id, job) {
    const key = job.email.toLowerCase(), ids = this.#idsByEmail.get(key);
    ids.delete(id);
    if (!ids.size) this.#idsByEmail.delete(key);
  }

  *forAccount(email) {
    const ids = this.#idsByEmail.get(String(email || "").trim().toLowerCase());
    if (ids) for (const id of ids) yield this.get(id);
  }
}
