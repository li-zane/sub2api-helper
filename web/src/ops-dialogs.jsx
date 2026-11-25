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
  const ids = (
      job.sub2apiAccountIds?.length
        ? job.sub2apiAccountIds
        : [job.sub2apiAccountId]
    )
      .filter(Boolean)
      .map(String);
  const [remote, setRemote] = useState(ids[0] || "");
  return <ChatConversation key={remote} {...{ job, request, onClose, ids, remote, setRemote }} />;
}

function ChatImage({ endpoint, turn, request }) {
  const [preview, setPreview] = useState(null);
  const location = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      request(`${endpoint}/images/${turn.id}`, { signal: controller.signal })
        .then(({ mime, base64 }) => {
          if (mime === turn.imageType && ["image/png", "image/jpeg", "image/webp"].includes(mime)) {
            setPreview({ src: `data:${mime};base64,${base64}` });
          } else setPreview({ error: "图片格式不受支持" });
        })
        .catch(() => { if (!controller.signal.aborted) setPreview({ error: "对话图片加载失败" }); });
    });
    observer.observe(location.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [endpoint, request, turn.id, turn.imageType]);
  return <div className="ops-chat-image" ref={location}>
    {preview?.src ? <img src={preview.src} alt="对话生成的图片" />
      : <small role={preview?.error ? "alert" : "status"}>{preview?.error || "图片待加载…"}</small>}
  </div>;
}

function chatSvgPreview(answer) {
  if (!answer || answer.length > 100000) return null;
  const svg = answer.match(/^\s*```(?:svg|xml|html)?[ \t]*\r?\n\s*(<svg\b[\s\S]*?<\/svg\s*>)\s*```/mi)?.[1]
    || answer.match(/^\s*(<svg\b[\s\S]*?<\/svg\s*>)\s*$/i)?.[1];
  // SVG is loaded in the browser's image-only context. Never embed it as HTML,
  // an iframe, or a navigable document.
  if (!svg) return null;
  const src = /^<svg\b[^>]*\sxmlns\s*=/i.test(svg) ? svg : svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src.toWellFormed())}`;
}

function ChatConversation({ job, request, onClose, ids, remote, setRemote }) {
  const title = useId();
  const [models, setModels] = useState([]),
    [model, setModel] = useState(""),
    [manualModel, setManualModel] = useState(""),
    [generateImage, setGenerateImage] = useState(false),
    [question, setQuestion] = useState(""),
    [selection, setSelection] = useState(null),
    [view, setView] = useState(null),
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
  const conversation = selection ?? view?.conversationId ?? null;
  const turns = view?.conversationId === conversation ? view.turns : [];
  const chosenModel = models.length ? model : manualModel.trim();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let gone = false;
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
            setModel(previous => r.models.includes(previous) ? previous : r.models.length === 1 ? r.models[0] : "");
          }
        })
        .catch((e) => {
          if (!gone) { setModels([]); setCatErr(e.message); }
        }).finally(()=>{if(!gone)setLoadingModels(false);});
    return () => {
      gone = true;
    };
  }, [remote, endpoint, request, catalogRevision]);
  useEffect(() => {
    if (!remote) return;
    let gone = false,
      timer;
    const query = new URLSearchParams({ remoteId: remote });
    if (selection) query.set("conversationId", selection);
    async function read() {
      let again = false;
      try {
        const r = await request(`${endpoint}?${query}`);
        if (!gone) {
          setView(r);
          again = r.busy || r.turns.some((t) => t.state === "running");
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
  }, [endpoint, remote, request, reload, selection]);
  useEffect(() => {
    if (transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [turns]);
  async function submit(e) {
    e.preventDefault();
    if (busy.current || !question.trim() || !chosenModel || !remote) return;
    busy.current = true;
    setPosting(true);
    setErr("");
    const sig = JSON.stringify([remote, chosenModel, question, generateImage, !models.length]);
    if (pending.current?.sig !== sig)
      pending.current = { sig, id: newRequestId(), conversationId: conversation && conversation !== "legacy" ? conversation : newRequestId() };
    const turn = pending.current;
    try {
      await request(endpoint, {
        method: "POST",
        body: JSON.stringify({
          id: turn.id,
          conversationId: turn.conversationId,
          remoteId: remote,
          model: chosenModel,
          manualModel: !models.length,
          generateImage,
          question,
        }),
      });
      pending.current = null;
      if (alive.current) {
        setQuestion("");
        setSelection(turn.conversationId);
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
  function selectConversation(id) {
    pending.current = null;
    setErr("");
    setQuestion("");
    setSelection(id);
  }
  const running = view?.busy || turns.some((t) => t.state === "running");
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
            <select value={remote} disabled={posting} onChange={(e) => setRemote(e.target.value)}>
              {ids.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            模型{" "}
            {models.length || loadingModels ? <select
              value={model}
              disabled={!models.length}
              onChange={(e) => setModel(e.target.value)}
            >
              {model === "" && <option value="">{loadingModels ? "正在读取上游…" : models.length ? "请选择模型" : "暂无可选模型"}</option>}
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select> : <input value={manualModel} disabled={!remote} maxLength={200} spellCheck={false}
              onChange={e => setManualModel(e.target.value)} placeholder="输入上游模型 ID" />}
          </label>
        </div>
        <small>
          使用选中账号的检测通道直连上游，不经号池计费网关。关闭窗口不影响后台回答。
        </small>
        <div className="upstream-catalog-tools"><small>目录来自 Sub2API 对所选号池账号执行的「获取上游模型」。</small>
        <button type="button" className="secondary-button" disabled={loadingModels||!remote} onClick={()=>setCatalogRevision(v=>v+1)}><RefreshCw size={13}/>刷新上游模型</button></div>
        {catalogWarning && <p role="status">Sub2API 返回了目录提示；详情请查看该账号的「获取上游模型」结果。</p>}
        {catalogError && <p role="alert">{catalogError}</p>}
        <div className="ops-chat-controls">
          <label>对话{" "}<select value={conversation || ""} disabled={posting || !remote} onChange={e => selectConversation(e.target.value)}>
            {!(view?.conversations || []).some(item => item.id === conversation) && <option value={conversation || ""}>新对话</option>}
            {(view?.conversations || []).map(item => <option key={item.id} value={item.id}>{item.id === "legacy" ? "旧版记录" : beijingTime(item.created)}</option>)}
          </select></label>
          <button type="button" className="secondary-button" disabled={posting || !remote} onClick={() => selectConversation(newRequestId())}>新建对话</button>
        </div>
        {conversation === "legacy" && <small>从旧版记录发送消息会开启独立的新对话。</small>}
        <div className="ops-transcript" ref={transcript} aria-label="对话记录">
          {!turns.length ? (
            <div className="ops-empty">
              暂无对话。发送第一条消息后可以关闭窗口。
            </div>
          ) : (
            turns.map((t) => {
              const svg = !t.imageType && chatSvgPreview(t.answer);
              return (
              <article key={t.id}>
                <small>
                  {t.model} · #{t.remote} · {beijingTime(t.created)}
                </small>
                <b>你</b>
                <p>{t.question}</p>
                <b>回答</b>
                {t.answer && (svg ? <details><summary>回答原文</summary><p>{t.answer}</p></details> : <p>{t.answer}</p>)}
                {t.imageType && <ChatImage endpoint={endpoint} turn={t} request={request} />}
                {svg && <img className="ops-chat-image" src={svg} alt="对话生成的 SVG 预览" />}
                {!t.answer && !t.imageType && <p role={t.error ? "alert" : t.state === "running" ? "status" : undefined}>
                  {t.error || (t.state === "running" ? "正在后台生成…" : "未返回文本")}
                </p>}
              </article>
              );
            })
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
            <label className="ops-chat-image-choice"><input type="checkbox" checked={generateImage} disabled={posting} onChange={e => setGenerateImage(e.target.checked)} /> 生成图片</label>
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              关闭窗口
            </button>
            <button
              className="primary-button"
              disabled={posting || running || loadingModels || !remote || !chosenModel || !question.trim()}
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
