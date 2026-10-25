// Nano Market — Plugins 页的专属页签（plugins.tab，与官方 Discover 同机制）。
// 层级：列表（已安装插件 + 真启用开关，市场插件标注状态）→ 点行进入插件详情（本插件 = 远程访问完整管理页）。
// 实现注意：plugins.tab 的组件由 plugin-manager 以普通函数方式调用——不能用 React hooks，
// 采用"挂载点 + vanilla DOM 应用"模式；pm 经闭包传递（props 保持可序列化）。
// listBundles/setBundleEnabled 已实测可用（官方 remote.pluginManager 服务）。
const { createElement: h } = React;

const API_BASE = location.port === "3080" ? "http://127.0.0.1:4080" : "";
const MARKET_INDEX = "https://oh-summy.github.io/dsh-nano-market/index.json";
const SELF = "@oh-summy/dsh-remote";

function rcApi(path, options) {
  return fetch(API_BASE + path, { credentials: "include", ...options }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "HTTP " + res.status);
    return json;
  });
}

function nmEsc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NM_CSS = `
.nm { font-family: system-ui,-apple-system,sans-serif; color: #1f2328; max-width: 760px; margin: 0 auto; font-size: 14px; }
.nm-sec { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; margin: 18px 0 8px; }
.nm-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 4px 14px; margin-bottom: 12px; }
.nm-bare { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }
.nm-row { display: flex; align-items: center; gap: 10px; padding: 11px 0; border-bottom: 1px solid #f3f4f6; cursor: pointer; }
.nm-row:last-child { border-bottom: none; }
.nm-row-plain { cursor: default; }
.nm-icon { width: 38px; height: 38px; border-radius: 10px; background: #eef2ff; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
.nm-name { font-weight: 600; font-size: 14px; }
.nm-ver { color: #9ca3af; font-size: 12px; margin-left: 6px; font-family: ui-monospace,monospace; }
.nm-desc { color: #6b7280; font-size: 12.5px; line-height: 1.5; }
.nm-badge { background: #eef2ff; color: #4f46e5; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
.nm-badge-g { background: #f3f4f6; color: #6b7280; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
.nm-label { min-width: 84px; color: #6b7280; font-size: 13px; flex-shrink: 0; }
.nm-dot-on { color: #16a34a; font-weight: 600; font-size: 13px; }
.nm-dot-off { color: #9ca3af; font-weight: 600; font-size: 13px; }
.nm-link { color: #2563eb; word-break: break-all; text-decoration: none; }
.nm-code { background: #f3f4f6; border-radius: 6px; padding: 3px 10px; font-family: ui-monospace,monospace; font-size: 13px; }
.nm-btn { background: #fff; border: 1px solid #d1d5db; border-radius: 8px; padding: 5px 14px; font-size: 13px; cursor: pointer; color: #1f2328; }
.nm-btn-p { background: #2563eb; border: 1px solid #2563eb; border-radius: 8px; padding: 5px 14px; font-size: 13px; cursor: pointer; color: #fff; }
.nm-btn-d { background: #fff; border: 1px solid #fca5a5; border-radius: 8px; padding: 5px 14px; font-size: 13px; cursor: pointer; color: #dc2626; }
.nm-input { flex: 1; min-width: 220px; border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 10px; font-size: 13px; box-sizing: border-box; }
.nm-note { color: #9ca3af; font-size: 12px; line-height: 1.7; margin: 10px 0 0; }
.nm-msg { color: #2563eb; font-size: 13px; margin: 6px 0; min-height: 18px; }
.nm-events { border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; max-height: 200px; overflow: auto; font-size: 12px; color: #6b7280; }
.nm-event { padding: 2px 0; word-break: break-all; border-bottom: 1px solid #f3f4f6; }
.nm-empty { color: #9ca3af; font-size: 13px; padding: 16px 0; text-align: center; }
.nm-sw { width: 40px; height: 22px; border-radius: 999px; background: #1f2328; position: relative; cursor: pointer; flex-shrink: 0; border: none; }
.nm-sw.off { background: #d1d5db; }
.nm-sw i { position: absolute; top: 2px; left: 20px; width: 18px; height: 18px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.nm-sw.off i { left: 2px; }
.nm-remote .nm-row-plain { cursor: default; }
`;

// ---------- vanilla 渲染辅助 ----------

function nmShell(root) {
  root.innerHTML = `<style>${NM_CSS}</style><div class="nm"></div>`;
  return root.querySelector(".nm");
}

// ---------- 远程访问详情（本插件专属管理页） ----------

function renderRemoteDetail(container, initialMsg) {
  container.innerHTML = `
    <div class="nm-remote">
      <div class="nm-card">
        <div class="nm-row nm-row-plain" id="rc-runrow"><span class="nm-dot-off">○ 隧道状态读取中…</span></div>
        <div id="rc-urlrow"></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">访问密码</span><span class="nm-code" id="rc-pw">••••</span>
          <button class="nm-btn" id="rc-reveal">显示</button>
          <button class="nm-btn-d" id="rc-reset">重置密码</button></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">飞书通知</span><span id="rc-ch" style="font-size:13px">-</span>
          <button class="nm-btn" id="rc-test" style="display:none">发送测试</button></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">webhook URL</span><input class="nm-input" id="rc-hook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">App Secret</span><input class="nm-input" id="rc-sec" type="password" placeholder="app secret">
          <button class="nm-btn" id="rc-save">保存凭据</button></div>
        <div class="nm-msg" id="rc-msg">${nmEsc(initialMsg || "")}</div>
        <div class="nm-note">改配置会重启隧道并产生新链接，密码随 started 通知推送。open_id 获取：开放平台给应用加 im:message 权限后，让机器人给目标发一条消息即可从 API 调试台拿到。凭据写入 DSH 凭据缝，不落配置文件。</div>
        <div class="nm-sec">事件</div>
        <div class="nm-events" id="rc-events">（暂无）</div>
      </div>
    </div>`;
  const q = (s) => container.querySelector(s);
  let shown = false;

  async function refresh() {
    let st;
    try {
      st = await rcApi("/rc-api/state");
    } catch (e) {
      q("#rc-runrow").innerHTML = `<span class="nm-dot-off">○ 管理面未就绪：${nmEsc(e.message)}</span>`;
      return;
    }
    q("#rc-runrow").innerHTML = st.running
      ? `<span class="nm-dot-on">● 隧道运行中</span><button class="nm-btn-d" id="rc-stop">停止远程访问</button>`
      : `<span class="nm-dot-off">○ 隧道已停止</span><button class="nm-btn-p" id="rc-start">启动远程访问</button>`;
    const stopBtn = q("#rc-stop");
    const startBtn = q("#rc-start");
    if (stopBtn) stopBtn.onclick = () => act("/rc-api/toggle", "正在停止…");
    if (startBtn) startBtn.onclick = () => act("/rc-api/toggle", "正在启动…（新链接几秒后出现）");
    q("#rc-urlrow").innerHTML = st.running && st.url
      ? `<div class="nm-row nm-row-plain"><a class="nm-link" target="_blank" href="${nmEsc(st.url)}">${nmEsc(st.url)}</a><button class="nm-btn" id="rc-copy">复制链接</button></div>`
      : "";
    const copyBtn = q("#rc-copy");
    if (copyBtn) copyBtn.onclick = () => { navigator.clipboard.writeText(st.url); setMsg("已复制到剪贴板"); };
    q("#rc-pw").textContent = shown ? st.password : st.passwordMask;
    q("#rc-reveal").textContent = shown ? "隐藏" : "显示";
    q("#rc-ch").textContent = st.channel === "off" ? "关闭" : st.channel === "webhook" ? "群机器人" + (st.hasWebhook ? " ✓" : "（URL 未配置）") : "开放平台 app" + (st.hasAppSecret ? " ✓" : "（Secret 未配置）");
    q("#rc-test").style.display = st.channel === "off" ? "none" : "";
    q("#rc-events").innerHTML = st.events.length === 0 ? "（暂无）" : st.events.map((e) => `<div class="nm-event">${nmEsc(e.time)} · ${nmEsc(e.type)} · ${nmEsc(e.detail)}</div>`).join("");
  }

  function setMsg(m) { const el = q("#rc-msg"); if (el) el.textContent = m; }

  async function act(path, pendingMsg, body) {
    setMsg(pendingMsg || "…");
    try { await rcApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); setMsg("完成"); }
    catch (e) { setMsg("失败：" + e.message); }
    setTimeout(refresh, 400);
  }

  q("#rc-reveal").onclick = async () => {
    if (shown) { shown = false; return refresh(); }
    try { const r = await rcApi("/rc-api/reveal", { method: "POST" }); shown = true; q("#rc-pw").textContent = r.password; setTimeout(() => { shown = false; refresh(); }, 30000); }
    catch (e) { setMsg("失败：" + e.message); }
  };
  q("#rc-reset").onclick = () => { if (confirm("重置密码？所有已登录会话将失效，新密码随 started 通知推送。")) act("/rc-api/reset", "密码已重置"); };
  q("#rc-test").onclick = () => act("/rc-api/test", "测试已发送，结果看事件流");
  q("#rc-save").onclick = () => act("/rc-api/notify-secret", "凭据已保存", {
    webhookUrl: q("#rc-hook").value.trim() || undefined,
    appSecret: q("#rc-sec").value.trim() || undefined,
  });

  refresh();
  const poll = setInterval(refresh, 5000);
  return () => clearInterval(poll);
}

// ---------- Nano Market 主视图（列表 + 详情） ----------

function mountNanoMarket(container, pm) {
  const shell = nmShell(container);
  let selected = null;
  let bundles = null;
  let market = { loading: true };
  let msg = "";
  let cleanupRemote = null;

  async function load() {
    try {
      const r = await pm.listBundles();
      bundles = (r && (r.value ?? r.result)) || [];
      if (!Array.isArray(bundles)) bundles = [];
    } catch (e) { bundles = []; msg = "读取已安装插件失败：" + (e.message || e); }
    try {
      const j = await (await fetch(MARKET_INDEX, { signal: AbortSignal.timeout(10000) })).json();
      market = { plugins: j.plugins || [] };
    } catch (e) { market = { error: String(e.message || e) }; }
    render();
  }

  async function setBundle(b, on) {
    msg = b.name + (on ? " 启用中…" : " 停用中…");
    render();
    try { await pm.setBundleEnabled(b.name, on); msg = b.name + (on ? " 已启用" : " 已停用"); }
    catch (e) { msg = "失败：" + (e.message || e); }
    await load();
  }

  function text(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") return String(v.zh || v.en || "");
    return String(v);
  }
  function title(b) { return text(b.meta && b.meta.title) || b.name; }

  function render() {
    if (cleanupRemote) { cleanupRemote(); cleanupRemote = null; }
    if (selected) return renderDetail();
    renderList();
  }

  function renderList() {
    // 官方包（@deepseek-ai/*）是 DSH 宿主自己的组成件，不属于市场；本机插件 = 其余 bundles
    const mine = (bundles || []).filter((b) => !String(b.name).startsWith("@deepseek-ai/"));
    const mineRows = mine.map((b) => `
      <div class="nm-row" data-open="${nmEsc(b.name)}">
        <div class="nm-icon">🧩</div>
        <div style="flex:1">
          <div><span class="nm-name">${nmEsc(title(b))}</span>${b.version ? `<span class="nm-ver">v${nmEsc(b.version)}</span>` : ""}${b.source && String(b.source).indexOf("link:") === 0 ? `<span class="nm-badge">开发中</span>` : ""}${b.error ? `<span class="nm-badge-g">加载错误</span>` : ""}</div>
          <div class="nm-desc">${nmEsc(text(b.meta && b.meta.description) || text(b.description) || b.name)}</div>
        </div>
        <button class="nm-sw${b.enabled ? "" : " off"}" data-sw="${nmEsc(b.name)}" aria-label="${b.enabled ? "停用" : "启用"}"><i></i></button>
      </div>`).join("");
    const plist = market.plugins || [];
    const mrows = plist.map((p) => {
      const installed = (bundles || []).some((b) => b.name === p.name);
      const ptitle = text(p.title) || p.name;
      const ver = p.versions && p.versions[0] ? p.versions[0].version : "";
      return `<div class="nm-row nm-row-plain">
        <div class="nm-icon">🧩</div>
        <div style="flex:1">
          <div><span class="nm-name">${nmEsc(ptitle)}</span>${ver ? `<span class="nm-ver">v${nmEsc(ver)}</span>` : ""}${installed ? `<span class="nm-badge">已安装</span>` : `<span class="nm-badge-g">未上架</span>`}</div>
          <div class="nm-desc">${nmEsc(text(p.description))}</div>
        </div>
        ${installed ? `<button class="nm-btn" data-open="${nmEsc(p.name)}">管理</button>` : `<span class="nm-badge-g">发布后可安装</span>`}
      </div>`;
    }).join("");
    const marketBody = market.loading ? `<div class="nm-empty">读取市场索引…</div>`
      : market.error ? `<div class="nm-empty">市场索引读取失败：${nmEsc(market.error)}</div>`
      : plist.length === 0 ? `<div class="nm-empty">市场还没有注册插件。发布流程（tag v0.4.0 → 市场上架）走完后，@oh-summy/dsh-remote 会作为第一个插件在这里出现。</div>`
      : mrows;
    shell.innerHTML = `
      <div class="nm-sec">市场插件</div>
      <div class="nm-card">${marketBody}</div>
      <div class="nm-sec">本机插件（未上架）</div>
      <div class="nm-card">${mine.length === 0 ? `<div class="nm-empty">（没有本机插件）</div>` : mineRows}</div>
      <div class="nm-msg">${nmEsc(msg)}</div>
      <div class="nm-note">开关 = 插件的启用/停用，关了即不可用；点行进入管理。索引：https://oh-summy.github.io/dsh-nano-market/index.json</div>`;
    for (const el of shell.querySelectorAll("[data-open]")) {
      el.addEventListener("click", () => { selected = el.getAttribute("data-open"); render(); });
    }
    for (const el of shell.querySelectorAll("[data-sw]")) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const b = (bundles || []).find((x) => x.name === el.getAttribute("data-sw"));
        if (b) setBundle(b, !b.enabled);
      });
    }
  }

  function renderDetail() {
    const b = (bundles || []).find((x) => x.name === selected);
    if (selected === SELF) {
      shell.innerHTML = `<button class="nm-btn" id="nm-back" style="margin-bottom:12px">← 返回 Nano Market</button><div id="nm-detail"></div>`;
      shell.querySelector("#nm-back").onclick = () => { selected = null; render(); };
      cleanupRemote = renderRemoteDetail(shell.querySelector("#nm-detail"), msg);
      return;
    }
    shell.innerHTML = `
      <button class="nm-btn" id="nm-back" style="margin-bottom:12px">← 返回 Nano Market</button>
      <div class="nm-bare">
        <div class="nm-row nm-row-plain"><div class="nm-icon">🧩</div>
          <div style="flex:1"><div><span class="nm-name">${nmEsc(b ? title(b) : selected)}</span>${b && b.version ? `<span class="nm-ver">v${nmEsc(b.version)}</span>` : ""}</div>
          <div class="nm-desc">${nmEsc(b ? ((b.meta && b.meta.description) || b.description || "") : "")}</div></div></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">启用</span>
          <button class="nm-sw${b && b.enabled ? "" : " off"}" id="nm-sw"><i></i></button>
          <span class="nm-desc">${b && b.enabled ? "启用中——关闭后插件不可用" : "已停用"}</span></div>
      </div>`;
    shell.querySelector("#nm-back").onclick = () => { selected = null; render(); };
    shell.querySelector("#nm-sw").onclick = async () => { if (b) await setBundle(b, !b.enabled); };
  }

  load(); // 拉取已安装列表 + 市场索引
  render();
}

// ---------- 槽位注册 ----------

const inject = ["slots", "remote", "remote.pluginManager"];
let NM_PM = null; // pluginManager remote（apply 时捕获，挂载时经闭包使用）

function apply(ctx) {
  if (!ctx.slots || !ctx.remote) return;
  const pm = ctx.remote.pluginManager;
  if (!pm) { console.warn("[dsh-remote] remote.pluginManager 不可用"); return; }
  NM_PM = pm;
  ctx.slots.inject("plugins.tab", () => ctx.slots.register({
    name: "plugins.tab",
    id: "nano-market",
    label: () => "Nano Market",
  }, function NanoMarketTab(mountArg) {
    // plugin-manager 以普通函数调用本组件：兼容"传挂载元素"与"要求返回 React 元素"两种形态；
    // 真正的应用延迟到 commit 后挂载（ref 回调里同步异常会炸掉整棵树），全程 try/catch 显示错误。
    if (mountArg instanceof Element) { try { mountNanoMarket(mountArg, NM_PM); } catch (e) { mountArg.innerHTML = "Nano Market 挂载失败：" + nmEsc((e && e.message) || e); } return null; }
    return h("div", { style: { display: "contents" }, ref: nmTabRef });
  }));
}

// 稳定的具名 ref：内联箭头 ref 会在父组件每次重渲染时重新触发挂载（死循环卡死页面，第 4 轮实测）。
// dataset 守卫保证每个节点只挂载一次；挂载全程 try/catch，错误显示在页面里。
function nmTabRef(node) {
  if (!node || node.dataset.nmMounted) return;
  node.dataset.nmMounted = "1";
  setTimeout(() => {
    try { mountNanoMarket(node, NM_PM); }
    catch (e) {
      node.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px;white-space:pre-wrap">Nano Market 挂载失败：${nmEsc((e && e.stack) || e)}</div>`;
    }
  }, 0);
}
