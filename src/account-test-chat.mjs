const problem = (status, message) => Object.assign(Error(message), { status });
const validId = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const turnColumns = "id, remote, model, question, answer, state, created, error, image_type AS imageType";
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
        `SELECT ${turnColumns} FROM chats WHERE account=? ORDER BY created DESC,rowid DESC LIMIT 80`,
      )
      .all(account)
      .reverse();
  }
  conversation(account, pool, remote, requested) {
    if (requested !== null && requested !== "legacy" && !validId(requested)) throw problem(400, "无效的对话标识");
    const db = this.book.db;
    const conversations = db.prepare(`
      SELECT coalesce(conversation,'legacy') AS id, min(created) AS created
      FROM chats WHERE account=? AND pool=? AND remote=?
      GROUP BY conversation ORDER BY max(rowid) DESC
    `).all(account, pool, remote);
    const conversationId = requested ?? conversations[0]?.id ?? null;
    const turns = conversationId ? db.prepare(`
      SELECT ${turnColumns} FROM chats WHERE account=? AND pool=? AND remote=? AND conversation IS ?
      ORDER BY created, rowid
    `).all(account, pool, remote, conversationId === "legacy" ? null : conversationId) : [];
    return { conversations, conversationId, turns, busy: this.work.has(account) };
  }
  image(account, pool, id) {
    return this.book.db.prepare("SELECT image_type AS mime, image FROM chats WHERE account=? AND pool=? AND id=? AND image IS NOT NULL")
      .get(account, pool, id);
  }
  async start(account, target, body) {
    const { id, model } = body, conversation = body.conversationId ?? id,
      imageRequested = body.generateImage === true ? 1 : 0,
      question = String(body.question || "").trim();
    if (
      !validId(id) || !validId(conversation) ||
      typeof model !== "string" || !model.trim() || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model) ||
      !question ||
      question.length > 8000
    )
      throw problem(400, "请选择模型并输入 1–8000 字的问题");
    const existing = this.book.db
      .prepare(
        "SELECT account,pool,remote,model,question,conversation,image_requested FROM chats WHERE id=?",
      )
      .get(id);
    if (existing) {
      if (
        existing.account !== account ||
        existing.pool !== target.pool ||
        existing.remote !== target.id ||
        existing.model !== model ||
        existing.question !== question || (existing.conversation ?? id) !== conversation || existing.image_requested !== imageRequested
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
      if (body.manualModel === true && !/^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(model))
        throw problem(400, "请输入有效的上游模型 ID");
      if (body.manualModel !== true && !(await this.catalog(target)).includes(model))
        throw problem(400, "该模型不在此账号当前的上游模型目录");
      if (this.closing) throw problem(503, "服务正在关闭");
      const prior = this.book.db
        .prepare(
          "SELECT question,answer FROM chats WHERE account=? AND pool=? AND remote=? AND conversation=? AND state='completed' ORDER BY created DESC,rowid DESC LIMIT 8",
        )
        .all(account, target.pool, target.id, conversation);
      const messages = [];
      let budget = 24000 - question.length;
      for (const r of prior) {
        const size = r.question.length + r.answer.length;
        if (size > budget) break;
        budget -= size;
        messages.unshift(
          { role: "user", content: r.question },
          { role: "assistant", content: r.answer || "[已生成图片]" },
        );
      }
      messages.push({ role: "user", content: question });
      this.book.db
        .prepare(
          "INSERT INTO chats(id,account,pool,remote,model,question,state,created,conversation,image_requested) VALUES(?,?,?,?,?,?,'running',?,?,?)",
        )
        .run(id, account, target.pool, target.id, model, question, this.now(), conversation, imageRequested);
      this.book.db
        .prepare(
          "DELETE FROM chats WHERE account=? AND id NOT IN (SELECT id FROM chats WHERE account=? ORDER BY created DESC,rowid DESC LIMIT 80)",
        )
        .run(account, account);
      reservation.done = Promise.resolve()
        .then(() =>
          this.send(target, model, question, controller.signal, messages, imageRequested === 1),
        )
        .then((result) => {
          const text = typeof result === "string" ? result : result?.text ?? "";
          const image = result?.image;
          if (!text.trim() && !image) throw Error("empty");
          this.book.db
            .prepare("UPDATE chats SET state='completed', answer=?, image_type=?, image=? WHERE id=?")
            .run(text.slice(0, 100000), image?.mime ?? null, image?.bytes ?? null, id);
        })
        .catch((error) => {
          this.book.db
            .prepare("UPDATE chats SET state='failed',error=? WHERE id=?")
            .run(error?.chatMessage || "该账号本轮请求未完成；未切换账号或自动重发", id);
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
