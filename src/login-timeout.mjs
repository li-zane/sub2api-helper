export class LoginTimeouts {
  constructor({ getMinutes, onTimeout, minuteMs = 60_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { getMinutes, onTimeout, minuteMs, now, setTimer, clearTimer });
    this.entries = new Map();
  }
  start(job, mode) {
    this.stop(job);
    const entry = { job, mode, startedAt: this.now(), elapsedMs: 0, paused: false, serial: 0 };
    this.entries.set(job.id, entry);
    this.arm(entry);
  }
  arm(entry) {
    this.clearTimer(entry.timer);
    const serial = ++entry.serial;
    entry.minutes = this.getMinutes();
    if (entry.paused) return;
    const remaining = entry.minutes * this.minuteMs - entry.elapsedMs - (this.now() - entry.startedAt);
    entry.timer = this.setTimer(() => {
      if (this.entries.get(entry.job.id) !== entry || serial !== entry.serial) return;
      this.stop(entry.job);
      this.onTimeout(entry.job, entry);
    }, Math.max(0, remaining));
    entry.timer?.unref?.();
  }
  pause(job) {
    const entry = this.entries.get(job.id);
    if (!entry || entry.paused) return;
    entry.elapsedMs += this.now() - entry.startedAt;
    entry.paused = true;
    entry.serial++;
    this.clearTimer(entry.timer);
  }
  resume(job, mode) {
    const entry = this.entries.get(job.id);
    if (!entry?.paused) { this.start(job, mode); return; }
    entry.mode = mode;
    entry.paused = false;
    entry.startedAt = this.now();
    this.arm(entry);
  }
  stop(job) {
    const entry = this.entries.get(job.id);
    if (entry) this.clearTimer(entry.timer);
    this.entries.delete(job.id);
  }
  reschedule() { for (const entry of this.entries.values()) this.arm(entry); }
  close() { for (const entry of [...this.entries.values()]) this.stop(entry.job); }
}
