import { FinanceTrend } from "./finance-trend.jsx";
import React, { useEffect, useState, useRef, useId } from "react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { X, RefreshCw, Send, MessageSquare, Calculator } from "lucide-react";
import "./ops-dialogs.css";

function newRequestId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
        v.toString(16).padStart(2, "0"),
      )
        .join("")
        .replace(
          /^(........)(....)(....)(....)(............)$/,
          "$1-$2-$3-$4-$5",
        );
}
const money = (n) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
      }).format(n / 100);
const beijingTime = (t) =>
  t
    ? new Date(t).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "—";
const today = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10);
function Header({ id, title, icon, onClose, help }) {
  return (
    <div className="ops-head">
      <div>
        <h2 id={id}>
          {icon}
          {title}
        </h2>
        <p>{help}</p>
      </div>
      <button
        className="icon-button"
        type="button"
        aria-label="关闭"
        onClick={onClose}
      >
        <X size={17} />
      </button>
    </div>
  );
}
export function FinanceDialog({ request, onClose }) {
  const id = useId(),
    [day, setDay] = useState(today),
    [data, setData] = useState(null),
    [err, setErr] = useState(""),
    [busy, setBusy] = useState(false);
  const seq = useRef(0);
  async function read(d, refresh = false) {
    const n = ++seq.current;
    setBusy(true);
    setErr("");
    try {
      const result = await request(
        "/api/finance/daily?day=" + d,
        refresh ? { method: "POST", body: "{}" } : {},
      );
      if (n === seq.current) setData(result);
    } catch (e) {
      if (n === seq.current) setErr(e.message);
    } finally {
      if (n === seq.current) setBusy(false);
    }
  }
  useEffect(() => {
    setData(null);
    void read(day);
    return () => {
      ++seq.current;
    };
  }, [day, request]);
  return (
    <AccessibleDialog
      className="batch-dialog ops-dialog"
      labelledBy={id}
      onClose={onClose}
    >
      <Header
        id={id}
        title="每日收支"
        icon={<Calculator size={20} />}
        onClose={onClose}
        help="OAuth 号池 · 人民币 · 北京时间自然日"
      />
      <div className="ops-main">
        <div className="ops-toolbar">
          <label>
            统计日期{" "}
            <input
              aria-label="统计日期"
              type="date"
              max={today()}
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </label>
          {day === today() ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => read(day, true)}
            >
              <RefreshCw size={14} />
              同步今日
            </button>
          ) : (
            <span className="ops-chip">历史库存 · 只读</span>
          )}
        </div>
        {err && <p role="alert">{err}</p>}
        {busy && <p role="status">正在读取…</p>}
        {data && <FinanceTrend points={data.trend} />}
        {data && !data.exists ? (
          <div className="ops-empty">
            <strong>这一天尚无库存记录</strong>
            <p>
              {data.readOnly
                ? "历史日期不回查号池，也不按零元计。"
                : "点击「同步今日」或等待定时采集。"}
            </p>
          </div>
        ) : (
          data && (
            <>
              <div className="ops-metrics">
                {[
                  ["当日收入", data.incomeCents],
                  ["新增成本", data.costCents],
                  ["当日利润", data.profitCents],
                ].map(([l, n]) => (
                  <div key={l}>
                    <span>{l}</span>
                    <strong>{money(n)}</strong>
                  </div>
                ))}
              </div>
              <dl className="ops-break">
                <div>
                  <dt>新增 OAuth 账号 · {data.accountCount} 个</dt>
                  <dd>{money(data.accountCostCents)}</dd>
                </div>
                <div>
                  <dt>新增代理 IP · {data.ipCount} 个</dt>
                  <dd>{money(data.ipCostCents)}</dd>
                </div>
              </dl>
              <p className="ops-note">
                收入取所有号池 OAuth
                账号当天的实际消费，再按售价倍率换算；库存账号和 IP
                不重复计成本。
                {data.complete
                  ? "当前采样完整。"
                  : "采样尚不完整，金额仅代表已取得的记录。"}
              </p>
              <small>
                {data.closedAt
                  ? "已结账 · "
                  : data.readOnly
                    ? "库存快照 · "
                    : ""}
                最近采样 {beijingTime(data.sampled)} · 有金额记录 {data.known}/
                {data.count}
              </small>
            </>
          )
        )}
      </div>
    </AccessibleDialog>
  );
}
export function ChatDialog({ job, request, onClose }) {
  const title = useId(),
    ids = (
      job.sub2apiAccountIds?.length
        ? job.sub2apiAccountIds
        : [job.sub2apiAccountId]
    )
      .filter(Boolean)
      .map(String);
  const [remote, setRemote] = useState(ids[0] || ""),
    [models, setModels] = useState([]),
    [model, setModel] = useState(""),
    [question, setQuestion] = useState(""),
    [turns, setTurns] = useState([]),
    [err, setErr] = useState(""),
    [catalogError, setCatErr] = useState(""),
    [catalogWarning, setCatalogWarning] = useState(false),
    [catalogRevision, setCatalogRevision] = useState(0),
    [loadingModels, setLoadingModels] = useState(false),
    [posting, setPosting] = useState(false),
    [reload, setReload] = useState(0);
  const busy = useRef(false),
    pending = useRef(null),
    alive = useRef(true),
    transcript = useRef(null);
  const endpoint = "/api/jobs/" + job.id + "/chat";
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let gone = false;
    setModels([]);
    setModel("");
    setCatErr("");
    setCatalogWarning(false);
    setLoadingModels(Boolean(remote));
    if (remote)
      request(endpoint + "/models", {
        method: "POST",
        body: JSON.stringify({ remoteId: remote }),
      })
        .then((r) => {
          if (!gone) {
            setModels(r.models);
            setCatalogWarning(r.hasWarnings === true);
            // The native list can start with a review-only model. Let the
            // operator choose rather than selecting it for a conversation.
            setModel(r.models.length === 1 ? r.models[0] : "");
          }
        })
        .catch((e) => {
          if (!gone) setCatErr(e.message);
        }).finally(()=>{if(!gone)setLoadingModels(false);});
    return () => {
      gone = true;
    };
  }, [remote, endpoint, request, catalogRevision]);
  useEffect(() => {
    let gone = false,
      timer;
    async function read() {
      let again = false;
      try {
        const r = await request(endpoint);
        if (!gone) {
          setTurns(r.turns);
          again = r.turns.some((t) => t.state === "running");
        }
      } catch (e) {
        if (!gone) setErr(e.message);
        again = true;
      } finally {
        if (!gone && again) timer = setTimeout(read, 1600);
      }
    }
    void read();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [endpoint, request, reload]);
  useEffect(() => {
    if (transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [turns]);
  async function submit(e) {
    e.preventDefault();
    if (busy.current || !question.trim() || !model) return;
    busy.current = true;
    setPosting(true);
    setErr("");
    const sig = JSON.stringify([remote, model, question]);
    if (pending.current?.sig !== sig)
      pending.current = { sig, id: newRequestId() };
    try {
      await request(endpoint, {
        method: "POST",
        body: JSON.stringify({
          id: pending.current.id,
          remoteId: remote,
          model,
          question,
        }),
      });
      pending.current = null;
      if (alive.current) {
        setQuestion("");
        setReload((x) => x + 1);
      }
    } catch (e) {
      if (alive.current) {
        setErr(e.message);
        setReload((x) => x + 1);
      }
    } finally {
      busy.current = false;
      if (alive.current) setPosting(false);
    }
  }
  const running = turns.some((t) => t.state === "running");
  return (
    <AccessibleDialog
      className="batch-dialog ops-dialog"
      labelledBy={title}
      onClose={onClose}
    >
      <Header
        id={title}
        title="账号对话测试"
        icon={<MessageSquare size={20} />}
        onClose={onClose}
        help={job.email}
      />
      <div className="ops-main">
        <div className="ops-toolbar">
          <label>
            号池 ID{" "}
            <select value={remote} onChange={(e) => setRemote(e.target.value)}>
              {ids.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            模型{" "}
            <select
              value={model}
              disabled={!models.length}
              onChange={(e) => setModel(e.target.value)}
            >
              {model === "" && <option value="">{loadingModels ? "正在读取上游…" : models.length ? "请选择模型" : "暂无可选模型"}</option>}
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        <small>
          使用选中账号的检测通道直连上游，不经号池计费网关。关闭窗口不影响后台回答。
        </small>
        <div className="upstream-catalog-tools"><small>目录来自 Sub2API 对所选号池账号执行的「获取上游模型」。</small>
        <button type="button" className="secondary-button" disabled={loadingModels||!remote} onClick={()=>setCatalogRevision(v=>v+1)}><RefreshCw size={13}/>刷新上游模型</button></div>
        {catalogWarning && <p role="status">Sub2API 返回了目录提示；详情请查看该账号的「获取上游模型」结果。</p>}
        {catalogError && <p role="alert">{catalogError}</p>}
        <div className="ops-transcript" ref={transcript} aria-label="对话记录">
          {!turns.length ? (
            <div className="ops-empty">
              暂无对话。发送第一条消息后可以关闭窗口。
            </div>
          ) : (
            turns.map((t) => (
              <article key={t.id}>
                <small>
                  {t.model} · #{t.remote} · {beijingTime(t.created)}
                </small>
                <b>你</b>
                <p>{t.question}</p>
                <b>回答</b>
                <p role={t.state === "running" ? "status" : undefined}>
                  {t.answer ||
                    t.error ||
                    (t.state === "running" ? "正在后台生成…" : "未返回文本")}
                </p>
              </article>
            ))
          )}
        </div>
        {err && <p role="alert">{err}</p>}
        <form onSubmit={submit}>
          <label className="ops-prompt">
            消息
            <textarea
              maxLength={8000}
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="输入要发给这个账号的问题"
            />
          </label>
          <div className="ops-end">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              关闭窗口
            </button>
            <button
              className="primary-button"
              disabled={posting || running || !model || !question.trim()}
            >
              <Send size={14} />
              发送
            </button>
          </div>
        </form>
      </div>
    </AccessibleDialog>
  );
}
