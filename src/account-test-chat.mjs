const problem = (status, message) => Object.assign(Error(message), { status });
// No polling callbacks re-submit a turn. Only an explicit operator POST starts
// one request, scoped to one pool account, with no automatic fallback or retry.
export class AccountTestChat {
  constructor(book, { catalog, send, now = () => new Date().toISOString() }) {
    Object.assign(this, { book, catalog, send, now });
    this.work = new Map();
    this.closing = false;
  }
  list(account) {
    return this.book.db
      .prepare(
        "SELECT id, remote, model, question,answer,state,created,error FROM chats WHERE account=? ORDER BY created DESC,rowid DESC LIMIT 80",
      )
      .all(account)
      .reverse();
  }
  async start(account, target, body) {
    const { id, model } = body,
      question = String(body.question || "").trim();
    if (
      typeof id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(id) ||
      typeof model !== "string" ||
      !question ||
      question.length > 8000
    )
      throw problem(400, "请选择模型并输入 1–8000 字的问题");
    const existing = this.book.db
      .prepare(
        "SELECT account,pool,remote,model,question FROM chats WHERE id=?",
      )
      .get(id);
    if (existing) {
      if (
        existing.account !== account ||
        existing.pool !== target.pool ||
        existing.remote !== target.id ||
        existing.model !== model ||
        existing.question !== question
      )
        throw problem(409, "请求标识已被其他会话使用");
      return { id };
    }
    if (this.closing || this.work.size >= 4)
      throw problem(429, "正在运行的对话较多，请稍后重试");
    if (this.work.has(account)) throw problem(409, "上一轮对话仍在进行");
    // Reserve before the first await, including model validation.
    const controller = new AbortController(),
      reservation = { controller, done: null };
    this.work.set(account, reservation);
    let admitted = false;
    try {
      if (!(await this.catalog(target)).includes(model))
        throw problem(400, "该模型不在此账号当前的上游模型目录");
      if (this.closing) throw problem(503, "服务正在关闭");
      const prior = this.book.db
        .prepare(
          "SELECT question,answer FROM chats WHERE account=? AND pool=? AND remote=? AND state='completed' ORDER BY created DESC,rowid DESC LIMIT 8",
        )
        .all(account, target.pool, target.id);
      const messages = [];
      let budget = 24000 - question.length;
      for (const r of prior) {
        const size = r.question.length + r.answer.length;
        if (size > budget) break;
        budget -= size;
        messages.unshift(
          { role: "user", content: r.question },
          { role: "assistant", content: r.answer },
        );
      }
      messages.push({ role: "user", content: question });
      this.book.db
        .prepare(
          "INSERT INTO chats(id,account,pool,remote,model,question,state,created) VALUES(?,?,?,?,?,?,'running',?)",
        )
        .run(id, account, target.pool, target.id, model, question, this.now());
      this.book.db
        .prepare(
          "DELETE FROM chats WHERE account=? AND id NOT IN (SELECT id FROM chats WHERE account=? ORDER BY created DESC,rowid DESC LIMIT 80)",
        )
        .run(account, account);
      reservation.done = Promise.resolve()
        .then(() =>
          this.send(target, model, question, controller.signal, messages),
        )
        .then((answer) => {
          if (typeof answer !== "string" || !answer.trim())
            throw Error("empty");
          this.book.db
            .prepare("UPDATE chats SET state='completed', answer=? WHERE id=?")
            .run(answer.slice(0, 100000), id);
        })
        .catch(() => {
          this.book.db
            .prepare("UPDATE chats SET state='failed',error=? WHERE id=?")
            .run("该账号本轮请求未完成；未切换账号或自动重发", id);
        })
        .finally(() => this.work.delete(account));
      admitted = true;
      return { id };
    } finally {
      if (!admitted) this.work.delete(account);
    }
  }
  async stop() {
    this.closing = true;
    const work = [...this.work.values()];
    for (const w of work) w.controller.abort();
    await Promise.allSettled(work.map((w) => w.done).filter(Boolean));
  }
}
