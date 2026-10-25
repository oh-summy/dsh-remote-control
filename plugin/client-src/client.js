// Nano Market — Plugins 页的专属页签（plugins.tab，与官方 Discover 同机制）。
// 层级：列表（已安装插件 + 真启用开关，市场插件标注状态）→ 点行进入插件详情（本插件 = 远程访问完整管理页）。
// 实现注意：plugins.tab 的组件由 plugin-manager 以普通函数方式调用——不能用 React hooks，
// 采用"挂载点 + vanilla DOM 应用"模式；pm 经闭包传递（props 保持可序列化）。
// listBundles/setBundleEnabled 已实测可用（官方 remote.pluginManager 服务）。
const { createElement: h } = React;

// 本机页面（3080）直连常驻管理面 9091（隧道停了也能操作）；远端页面（经隧道进来）同源走 Caddy。
const API_BASE = location.port === "3080" ? "http://127.0.0.1:9091" : "";
const MARKET_INDEX = "https://oh-summy.github.io/dsh-nano-market/index.json";
const SELF = "@oh-summy/dsh-remote";

function rcApi(path, options) {
  // 默认 8s 超时：条目重启时 9091 短暂下线，socket 半开会让无超时的 fetch 挂到浏览器上限
  const opts = { credentials: "include", ...options };
  if (!opts.signal) opts.signal = AbortSignal.timeout(8000);
  return fetch(API_BASE + path, opts).then(async (res) => {
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
.nm-sec { font-size: 11px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: .05em; margin: 22px 0 6px; }
.nm-card { background: #fff; border: 1px solid #eef0f3; border-radius: 14px; padding: 8px 22px; margin-bottom: 14px; }
.nm-bare { background: #fff; border: 1px solid #eef0f3; border-radius: 14px; padding: 18px 22px; margin-bottom: 14px; }
.nm-row { display: flex; align-items: center; gap: 10px; padding: 14px 0; cursor: pointer; }
.nm-row-plain { cursor: default; }
.nm-lrow .nm-desc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nm-name { font-weight: 500; font-size: 13.5px; }
.nm-ver { color: #9ca3af; font-size: 12px; margin-left: 6px; font-family: ui-monospace,monospace; }
.nm-desc { color: #8b949e; font-size: 12px; line-height: 1.5; }
.nm-badge { background: #eef2ff; color: #4f46e5; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
.nm-badge-g { background: #f3f4f6; color: #9ca3af; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
.nm-label { min-width: 96px; color: #6b7280; font-size: 13px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; }
.nm-dot-on { color: #16a34a; font-weight: 600; font-size: 13px; }
.nm-dot-off { color: #9ca3af; font-weight: 600; font-size: 13px; }
.nm-link { color: #2563eb; word-break: break-all; text-decoration: none; }
.nm-code { background: #f6f7f9; border-radius: 6px; padding: 3px 10px; font-family: ui-monospace,monospace; font-size: 13px; }
.nm-btn { background: transparent; border: 1px solid #e5e7eb; border-radius: 8px; padding: 5px 13px; font-size: 13px; cursor: pointer; color: #4b5563; }
.nm-btn:hover { border-color: #d1d5db; background: #fafbfc; }
.nm-btn-p { background: #2563eb; border: 1px solid #2563eb; border-radius: 8px; padding: 5px 13px; font-size: 13px; cursor: pointer; color: #fff; }
.nm-btn-d { background: transparent; border: 1px solid #f3d4d4; border-radius: 8px; padding: 5px 13px; font-size: 13px; cursor: pointer; color: #dc2626; }
.nm-btn-d:hover { background: #fdf5f5; }
.nm-input { flex: 1; min-width: 220px; border: 1px solid #e8eaed; border-radius: 8px; padding: 6px 10px; font-size: 13px; box-sizing: border-box; background: #fafbfc; color: #4b5563; }
.nm-input:focus { background: #fff; outline: none; border-color: #bfdbfe; }
.nm-note { color: #9ca3af; font-size: 12px; line-height: 1.7; margin: 8px 0 0; }
.nm-msg { color: #2563eb; font-size: 13px; margin: 4px 0 0; min-height: 18px; }
.nm-events { border: 1px solid #eef0f3; border-radius: 10px; padding: 10px 12px; max-height: 200px; overflow: auto; font-size: 12px; color: #9ca3af; background: #fafbfc; }
.nm-event { padding: 3px 0; word-break: break-all; }
.nm-empty { color: #9ca3af; font-size: 13px; padding: 18px 0; text-align: center; }
.nm-sw { width: 30px; height: 17px; border-radius: 999px; background: #1f2328; position: relative; cursor: pointer; flex-shrink: 0; border: none; }
.nm-sw.off { background: #d8dbe0; }
.nm-sw i { position: absolute; top: 2px; left: 15px; width: 13px; height: 13px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.15); transition: left .15s; }
.nm-sw.off i { left: 2px; }
.nm-remote .nm-row-plain { cursor: default; }
.nm-seg { background: transparent; border: 1px solid #e5e7eb; border-radius: 8px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: #6b7280; }
.nm-seg.on { background: #1f2328; border-color: #1f2328; color: #fff; font-weight: 500; }
.nm-eye { background: none; border: none; padding: 3px; cursor: pointer; display: inline-flex; align-items: center; color: #9ca3af; border-radius: 6px; }
.nm-eye:hover { color: #1f2328; background: #f3f4f6; }
.nm-eye svg { width: 17px; height: 17px; display: block; }
.nm-info { position: relative; cursor: help; color: #c3c8cf; width: 17px; height: 17px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.nm-info:hover { color: #2563eb; }
.nm-info svg { width: 15px; height: 15px; display: block; }
.nm-info .nm-tip { display: none; position: absolute; top: 135%; left: -6px; width: 240px; background: #1f2328; color: #fff; font-size: 12px; font-weight: 400; line-height: 1.7; padding: 8px 11px; border-radius: 8px; z-index: 30; box-shadow: 0 4px 14px rgba(0,0,0,.18); text-align: left; }
.nm-info:hover .nm-tip { display: block; }
.nm-chk { font-size: 12.5px; margin-right: 12px; }
.nm-chk.ok { color: #16a34a; }
.nm-chk.bad { color: #dc2626; }
.nm-skel { height: 13px; border-radius: 6px; margin: 16px 0; background: linear-gradient(90deg,#f1f3f5 25%,#e9ecef 50%,#f1f3f5 75%); background-size: 200% 100%; animation: nmsk 1.1s infinite linear; }
.nm-skel.w60 { width: 60%; }
@keyframes nmsk { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
`;

// 密码显隐 = 小眼睛图标（无文字按钮）
const EYE_ON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
// 复制反馈：✓ 在按钮本体上闪现（不占独立提示行）
function flashOk(btn, ms = 1500) {
  if (!btn) return;
  const old = btn.innerHTML;
  btn.innerHTML = `<span style="color:#16a34a;display:inline-flex">${CHECK_SVG}</span>`;
  btn.title = "已复制";
  setTimeout(() => { btn.innerHTML = old; btn.title = btn.dataset.title || btn.title; }, ms);
}
const INFO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
// 行内 ⓘ：紧跟标签文字，悬停浮窗说明——页面本体不放说明长文
function infoTip(text) {
  return `<span class="nm-info">${INFO_SVG}<span class="nm-tip">${text}</span></span>`;
}

// ---------- vanilla 渲染辅助 ----------

function nmShell(root) {
  root.innerHTML = `<style>${NM_CSS}</style><div class="nm"></div>`;
  return root.querySelector(".nm");
}

// 任何一步都不允许永久 pending（页面重载后 RPC 偶发不返回）：超时即报错继续渲染
function withTimeout(p, ms, tag) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(tag)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// ---------- 远程访问详情（本插件专属管理页） ----------

function renderRemoteDetail(container, initialMsg) {
  container.innerHTML = `
    <div class="nm-remote">
      <div class="nm-card">
        <div class="nm-row nm-row-plain" id="rc-runrow"><span class="nm-dot-off">○ 隧道状态读取中…</span></div>
        <div id="rc-urlrow"></div>
        <div id="rc-pwrow"></div>
        <div class="nm-msg" id="rc-msg">${nmEsc(initialMsg || "")}</div>
        <div class="nm-row nm-row-plain"><span class="nm-label">飞书通知${infoTip("开启后选择群聊或私聊；链接变化时自动推送新地址和完整密码")}</span>
          <button class="nm-sw off" id="rc-ntfy"><i></i></button>
          <span id="rc-chrow" style="display:inline-flex;gap:6px;align-items:center"></span>
          <span style="flex:1"></span>
          <span id="rc-testslot"></span>
        </div>
        <div id="rc-chform"></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">会话有效期${infoTip("远程登录保持登录的天数，可选 1–30 天")}</span>
          <select class="nm-input" id="rc-days" style="flex:0 0 120px">
            <option value="1">1 天</option><option value="3">3 天</option><option value="7">7 天</option>
            <option value="14">14 天</option><option value="30">30 天</option>
          </select></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">自动重启${infoTip("临时隧道进程意外退出后 5 秒内自动重拉")}</span>
          <button class="nm-sw" id="rc-arestart"><i></i></button></div>
        <div class="nm-sec">环境检查</div>
        <div class="nm-events" id="rc-env">读取中…</div>
        <div class="nm-sec">事件</div>
        <div class="nm-events" id="rc-events">（暂无）</div>
      </div>
    </div>`;
  const q = (s2) => container.querySelector(s2);
  let st = null;
  let shown = false;
  let cleanupRemotePoll = null;

  async function refresh() {
    try { st = await rcApi("/rc-api/state"); }
    catch (e) {
      // 条目重启窗口（改代码/装插件才会发生，设置不再触发）：轮询会自动恢复，这里给手动重试
      q("#rc-runrow").innerHTML = `<span class="nm-dot-off">○ 管理面连接中…（${nmEsc(e.message)}，数秒内自动恢复）</span><button class="nm-btn" id="rc-retry">立即重试</button>`;
      const rb = q("#rc-retry");
      if (rb) rb.onclick = () => refresh();
      return;
    }
    q("#rc-runrow").innerHTML = st.running
      ? `<span class="nm-dot-on">● 隧道运行中</span><button class="nm-btn-d" id="rc-stop">停止远程访问</button>`
      : `<span class="nm-dot-off">○ 隧道已停止——远程入口关闭，无链接也无需密码</span><button class="nm-btn-p" id="rc-start">启动远程访问</button>`;
    const stopBtn = q("#rc-stop");
    const startBtn = q("#rc-start");
    if (stopBtn) stopBtn.onclick = () => act("/rc-api/toggle", "正在停止…");
    if (startBtn) startBtn.onclick = () => act("/rc-api/toggle", "正在启动…（新链接几秒后出现）");
    q("#rc-urlrow").innerHTML = st.running && st.url
      ? `<div class="nm-row nm-row-plain"><a class="nm-link" target="_blank" href="${nmEsc(st.url)}">${nmEsc(st.url)}</a>${infoTip("临时隧道免 Cloudflare 账号配置；地址会不定期更换，新地址通过飞书通知自动送达")}<button class="nm-eye" id="rc-copy" title="复制链接" aria-label="复制链接" data-title="复制链接">${COPY_SVG}</button></div>`
      : "";
    const copyBtn = q("#rc-copy");
    if (copyBtn) copyBtn.onclick = () => { navigator.clipboard.writeText(st.url).then(() => flashOk(copyBtn)).catch(() => setMsg("复制失败：" )); };
    // 密码行只在运行时存在：停止 = 没有链接，密码无从谈起（用户要求）
    const pwrow = q("#rc-pwrow");
    if (st.running) {
      if (!pwrow.innerHTML) {
        pwrow.innerHTML = `<div class="nm-row nm-row-plain"><span class="nm-label">访问密码</span><span class="nm-code" id="rc-pw">••••</span>
          <button class="nm-eye" id="rc-reveal" title="显示密码" aria-label="显示密码">${shown ? EYE_OFF : EYE_ON}</button>
          <button class="nm-eye" id="rc-copypw" title="复制密码" aria-label="复制密码">${COPY_SVG}</button>
          <button class="nm-btn-d" id="rc-reset">重置密码</button></div>`;
        wirePwRow();
      }
      q("#rc-pw").textContent = shown ? st.password : st.passwordMask;
      setEye(shown);
    } else if (pwrow.innerHTML) {
      pwrow.innerHTML = "";
      shown = false;
    }
    const ar = q("#rc-arestart");
    ar.className = "nm-sw" + (st.autoRestart ? "" : " off");
    ar.onclick = () => act("/rc-api/config", st.autoRestart ? "正在关闭自动重启…" : "正在开启自动重启…", { autoRestart: !st.autoRestart });
    const ntfy = q("#rc-ntfy");
    const chOn = (st.channel || "off") !== "off";
    ntfy.className = "nm-sw" + (chOn ? "" : " off");
    if (chOn) lastChannel = st.channel === "dm" ? "dm" : "group";
    if (st.sessionDays) q("#rc-days").value = String(st.sessionDays);
    const chNow = st.channel || "off";
    if (chNow !== lastChRendered || !q("#rc-chrow .nm-seg")) { lastChRendered = chNow; renderChannel(); } // 值没变不重建：避免轮询打断点击
    q("#rc-events").innerHTML = st.events.length === 0 ? "（暂无）" : st.events.map((e) => `<div class="nm-event">${nmEsc(e.time)} · ${nmEsc(e.type)} · ${nmEsc(e.detail)}</div>`).join("");
  }

  // ---------- 通知设置（总开关 + 群聊/私聊，改动即保存） ----------
  let lastChRendered = null;
  let lastChannel = "group"; // 重新打开通知时回到上次的收件方式
  function renderChannel() {
    const row = q("#rc-chrow");
    const ch = st.channel || "off";
    if (ch === "off") { row.innerHTML = ""; q("#rc-testslot").innerHTML = ""; q("#rc-chform").innerHTML = ""; return; }
    row.innerHTML = [["group", "群聊"], ["dm", "私聊"]].map(([v, t2]) =>
      `<button class="nm-seg${ch === v ? " on" : ""}" data-ch="${v}">${t2}</button>`).join("");
    for (const b of row.querySelectorAll("[data-ch]")) {
      b.onclick = () => { if (b.dataset.ch !== ch) act("/rc-api/config", b.dataset.ch === "group" ? "已切到群聊" : "已切到私聊", { notifyChannel: b.dataset.ch }); };
    }
    q("#rc-testslot").innerHTML = `<button class="nm-btn" id="rc-test">发送测试</button>`;
    const tb = q("#rc-test");
    if (tb) tb.onclick = () => act("/rc-api/test", "测试中…");
    renderChannelForm();
  }

  // 掩码输入：显示「前6位••••••」示意已配置；改动才保存，掩码原样不动时不提交
  function bindMasked(input, mask, onDirty) {
    input.dataset.mask = mask || "";
    input.onfocus = () => { if (input.value && input.value === input.dataset.mask) input.value = ""; };
    input.onblur = () => { if (!input.value.trim() && input.dataset.mask) input.value = input.dataset.mask; };
    input.onchange = () => {
      const v = input.value.trim();
      if (!v || v === input.dataset.mask) { input.value = input.dataset.mask; return; }
      onDirty(v);
      input.dataset.mask = v.slice(0, 6) + "••••••";
      input.value = input.dataset.mask;
    };
  }

  // 配置体检：凭据有效 / im:message（发消息） / im:chat（拉群列表，群聊才需要）
  async function runAppCheck() {
    const box = q("#rc-appcheck");
    if (!box) return;
    box.innerHTML = `<span class="nm-chk" style="color:#9ca3af">检查中…</span>`;
    try {
      const r = await rcApi("/rc-api/appcheck");
      if (!r.token) { box.innerHTML = `<span class="nm-chk bad">✗ 凭据无效：${nmEsc(r.error || "请检查 App ID / Secret")}</span>`; return; }
      const item = (ok, label) => `<span class="nm-chk ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${label}</span>`;
      const ch = st.channel || "group";
      let html = item(true, "凭据");
      html += item(r.imMessage !== false, "im:message 发消息");
      if (ch === "group") html += item(r.imChat !== false, "im:chat 拉群列表");
      if (r.imMessage === false || (ch === "group" && r.imChat === false)) html += `<span class="nm-chk bad">缺权限：到开放平台开通后点重新检查</span>`;
      box.innerHTML = html;
    } catch (e) { box.innerHTML = `<span class="nm-chk bad">检查失败：${nmEsc(e.message)}</span>`; }
  }

  function renderChannelForm() {
    const ch = st.channel || "off";
    const form = q("#rc-chform");
    if (ch === "off") { form.innerHTML = ""; return; }
    const appRows = `
      <div class="nm-row nm-row-plain"><span class="nm-label">App ID${infoTip("开放平台 → 凭证与基础信息里的 cli_ 开头 ID")}</span><input class="nm-input" id="rc-appid" placeholder="cli_xxxx" value="${nmEsc(st.appIdMask || "")}"></div>
      <div class="nm-row nm-row-plain"><span class="nm-label">App Secret${infoTip("同一页面；只存本机凭据缝，不进仓库不进配置文件")}</span><input class="nm-input" id="rc-sec" type="password" placeholder="${st.appSecretMask ? "已配置 " + nmEsc(st.appSecretMask) + "，输入新值覆盖" : "app secret"}"></div>
      <div class="nm-row nm-row-plain"><span class="nm-label">配置检查${infoTip(ch === "group" ? "群聊需要 im:chat + im:message 权限，且机器人已被拉进群" : "私聊需要 im:message 权限")}</span>
        <span id="rc-appcheck" style="flex:1"></span><button class="nm-btn" id="rc-recheck">重新检查</button></div>`;
    if (ch === "group") {
      form.innerHTML = `
        ${appRows}
        <div class="nm-row nm-row-plain"><span class="nm-label">通知到群${infoTip("用应用身份发到选定的群；或用下面的群机器人 webhook，二选一")}</span>
          <select class="nm-input" id="rc-chat"><option value="">${st.chatId ? "已选：" + nmEsc(st.chatName || st.chatId) : "（点右侧拉取）"}</option></select>
          <button class="nm-btn" id="rc-fetchchats">拉取群列表</button></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">或群机器人${infoTip("群里加「自定义机器人」拿到 webhook 地址即可，不用 App ID")}</span><input class="nm-input" id="rc-hook" placeholder="${st.hasWebhook ? "已配置，重新粘贴即覆盖" : "webhook 地址（最简单，不用 App ID）"}"></div>`;
      wireAppRow(form);
      const chatSel = form.querySelector("#rc-chat");
      chatSel.onchange = () => {
        const opt = chatSel.options[chatSel.selectedIndex];
        act("/rc-api/config", chatSel.value ? "已通知到群：" + (opt ? opt.textContent : "") : "已取消群选择", { notifyChatId: chatSel.value, notifyChatName: opt ? opt.textContent : "" });
      };
      form.querySelector("#rc-fetchchats").onclick = async () => {
        setMsg("拉取群列表中…");
        try {
          const r = await rcApi("/rc-api/chats");
          if (!r.chats || r.chats.length === 0) { setMsg("机器人还不在任何群里——先在飞书里把它拉进一个群再试"); return; }
          chatSel.innerHTML = `<option value="">（不通知到群）</option>` + r.chats.map((c) => `<option value="${nmEsc(c.chatId)}">${nmEsc(c.name)}</option>`).join("");
          if (st.chatId) chatSel.value = st.chatId;
          setMsg("已拉到 " + r.chats.length + " 个群，选择后即保存");
        } catch (e) { setMsg("失败：" + (e.message || e)); }
      };
      const hook = form.querySelector("#rc-hook");
      hook.onchange = () => act("/rc-api/notify-secret", "webhook 地址已保存", { webhookUrl: hook.value.trim() || undefined });
      return;
    }
    // 私聊
    form.innerHTML = `
      ${appRows}
      <div class="nm-row nm-row-plain"><span class="nm-label">接收者${infoTip("open_id 或 union_id（on_ 开头）；开放平台「消息日志」里可查 open_id")}</span><input class="nm-input" id="rc-oid" placeholder="ou_xxxx / on_xxxx" value="${nmEsc(st.openIdMask || "")}"></div>`;
    wireAppRow(form);
    const oid = form.querySelector("#rc-oid");
    bindMasked(oid, st.openIdMask, (v) => act("/rc-api/config", "接收者已保存", { notifyOpenId: v }));
  }

  function wireAppRow(form) {
    const appId = form.querySelector("#rc-appid");
    const sec = form.querySelector("#rc-sec");
    bindMasked(appId, st.appIdMask, (v) => act("/rc-api/config", "App ID 已保存", { notifyAppId: v }));
    sec.onchange = () => {
      const v = sec.value.trim();
      if (v) {
        act("/rc-api/notify-secret", "App Secret 已保存", { appSecret: v });
        // 立即用刚存的值显示掩码占位（不等表单重建）
        sec.placeholder = "已配置 " + v.slice(0, 4) + "••••••，输入新值覆盖";
      }
      sec.value = "";
    };
    const rc = form.querySelector("#rc-recheck");
    if (rc) rc.onclick = () => runAppCheck();
    if (st.appIdMask && st.hasAppSecret) runAppCheck(); // 凭据齐了就自动体检
  }

  let msgTimer = null;
  function setMsg(m) {
    const el = q("#rc-msg");
    if (el) el.textContent = m;
    if (msgTimer) clearTimeout(msgTimer);
    // 消息是反馈不是状态：几秒后自动消失（失败类停留久一点），不常驻页面
    if (m) msgTimer = setTimeout(() => { const el2 = q("#rc-msg"); if (el2) el2.textContent = ""; }, String(m).includes("失败") ? 8000 : 3500);
  }

  async function act(path, pendingMsg, body) {
    setMsg(pendingMsg || "…");
    try {
      const r = await rcApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      setMsg(r && r.error ? "失败：" + r.error : (done2(r) || "完成"));
    } catch (e) { setMsg("失败：" + (e.message || e)); }
    setTimeout(refresh, 400);
  }
  function done2(r) { return r && r.detail ? String(r.detail) : (r && r.ok ? "完成" : undefined); }

  function setEye(on2) {
    const e = q("#rc-reveal");
    if (!e) return;
    e.innerHTML = on2 ? EYE_OFF : EYE_ON;
    e.title = on2 ? "隐藏密码" : "显示密码";
    e.setAttribute("aria-label", on2 ? "隐藏密码" : "显示密码");
  }
  function wirePwRow() {
    const eye = q("#rc-reveal");
    if (!eye) return;
    eye.onclick = async () => {
      if (shown) { shown = false; return refresh(); }
      try { const r = await rcApi("/rc-api/reveal", { method: "POST" }); shown = true; q("#rc-pw").textContent = r.password; setEye(true); setTimeout(() => { shown = false; refresh(); }, 30000); }
      catch (e) { setMsg("失败：" + e.message); }
    };
    q("#rc-copypw").onclick = async () => {
      try { const r = await rcApi("/rc-api/reveal", { method: "POST" }); await navigator.clipboard.writeText(r.password); flashOk(q("#rc-copypw")); }
      catch (e) { setMsg("失败：" + e.message); }
    };
    q("#rc-reset").onclick = () => { if (confirm("重置密码？所有已登录会话将失效，新密码随下次开启通知推送。")) act("/rc-api/reset", "密码已重置"); };
  }

  // 通知总开关 + 会话有效期（一次接线，状态由 refresh 刷新）
  q("#rc-ntfy").onclick = () => {
    const cur = st ? (st.channel || "off") : "off";
    const next = cur === "off" ? lastChannel : "off";
    act("/rc-api/config", next === "off" ? "通知已关闭" : "通知已开启", { notifyChannel: next });
  };
  q("#rc-days").onchange = () => act("/rc-api/config", "会话有效期已更新", { sessionDays: parseInt(q("#rc-days").value, 10) || 7 });

  // 环境检查
  rcApi("/rc-api/envcheck").then((e) => {
    const row2 = (name, ok, detail) => `<div class="nm-event">${ok ? "✓" : "✗"} ${name}${detail ? " — " + nmEsc(detail) : ""}</div>`;
    q("#rc-env").innerHTML =
      row2("cloudflared", e.cloudflared.found, e.cloudflared.version || e.cloudflared.path) +
      row2("caddy", e.caddy.found, e.caddy.version || e.caddy.path) +
      row2("Cloudflare 账号", e.cfAccount, "临时隧道免配置，无需注册") +
      (e.tunnelLink ? row2("隧道链路自检", e.tunnelLink.ok, e.tunnelLink.ok ? "HTTP " + e.tunnelLink.status + "，登录页可达" : String(e.tunnelLink.status)) : "") +
      row2("DSH 会话密钥（远程登录免二次校验）", e.dshSecret, e.dshSecret ? "" : "未读取到");
  }).catch((e) => { q("#rc-env").innerHTML = "环境检查失败：" + nmEsc(e.message); });

  refresh();
  const poll = setInterval(refresh, 5000);
  return () => { clearInterval(poll); if (cleanupRemotePoll) cleanupRemotePoll(); };
}

// ---------- Nano Market 主视图（列表 + 详情） ----------

function mountNanoMarket(container, pm0) {
  const shell = nmShell(container);
  let selected = null;
  let bundles = null;
  let market = { loading: true };
  let msg = "";
  let cleanupRemote = null;
  let remoteRunning = null; // SELF（远程访问）隧道状态：true/false；null = 管理面未就绪
  let loadFailed = false;
  let pm = pm0;

  function applyRemote(r) {
    // 隧道状态变化统一入口：值变了才提示 + 重渲染由调用方决定；首轮（null→值）不出文案
    if (r === remoteRunning) return false;
    const had = remoteRunning !== null;
    remoteRunning = r;
    if (had) msg = r ? "远程访问已开启" : "远程访问已停止";
    return true;
  }

  function acquirePm() {
    // apply 时捕获的代理在页面重载后可能已失效：挂载/重试时优先现取
    try {
      if (CTX && CTX.remote && CTX.remote.pluginManager) pm = CTX.remote.pluginManager;
    } catch { /* 保持原值 */ }
    return pm;
  }

  async function fetchBundles() {
    const p = acquirePm();
    if (!p || typeof p.listBundles !== "function") throw new Error("pluginManager 未就绪");
    const r = await withTimeout(p.listBundles(), 6000, "读取插件列表超时");
    const rows = (r && (r.value ?? r.result)) || [];
    return Array.isArray(rows) ? rows : [];
  }

  async function load() {
    loadFailed = false;
    try {
      bundles = await fetchBundles();
    } catch (e) {
      bundles = [];
      msg = "读取已安装插件失败：" + (e.message || e);
      loadFailed = true;
    }
    if (bundles.length === 0) {
      // remote 未就绪时可能拿到空列表或死调用：延迟后重试一次（通道热身）
      await new Promise((r2) => setTimeout(r2, 1500));
      try {
        const rows2 = await fetchBundles();
        if (rows2.length > 0) { bundles = rows2; msg = ""; loadFailed = false; }
      } catch { /* 保持前面的结果 */ }
    }
    try { const s = await withTimeout(rcApi("/rc-api/state"), 4000, "管理面超时"); applyRemote(!!s.running); }
    catch { remoteRunning = null; }
    try {
      const j = await (await fetch(MARKET_INDEX, { signal: AbortSignal.timeout(6000) })).json();
      market = { plugins: j.plugins || [] };
    } catch (e) { market = { error: String(e.message || e) }; }
    booted = true;
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
  const shortName = (n) => String(n).replace(/^@[^/]+\//, ""); // @oh-summy/dsh-remote → dsh-remote
  function title(b) { return text(b.meta && b.meta.title) || shortName(b.name); }

  function render() {
    if (cleanupRemote) { cleanupRemote(); cleanupRemote = null; }
    if (selected) return renderDetail();
    renderList();
  }

  let booted = false; // 首次加载完成前只显示骨架屏，不闪半成品列表（打开瞬间的观感）

  function renderList() {
    if (!booted) {
      shell.innerHTML = `<div class="nm-card"><div class="nm-skel"></div><div class="nm-skel w60"></div></div><div class="nm-card"><div class="nm-skel"></div><div class="nm-skel w60"></div></div>`;
      return;
    }
    // 官方包（@deepseek-ai/*）是 DSH 宿主自己的组成件，不属于市场；本机插件 = 其余 bundles
    const mine = (bundles || []).filter((b) => String(b.name).startsWith("@oh-summy/")); // 只有本项目的插件才进 Nano Market
    const mineRows = mine.map((b) => {
      const on = b.name === SELF ? remoteRunning === true : !!b.enabled; // SELF 开关 = 隧道启停，其余 = 插件启停
      return `
      <div class="nm-row nm-lrow" data-open="${nmEsc(b.name)}">
        <div style="flex:1;min-width:0">
          <div><span class="nm-name">${nmEsc(title(b))}</span>${b.version ? `<span class="nm-ver">v${nmEsc(b.version)}</span>` : ""}${b.source && String(b.source).indexOf("link:") === 0 ? `<span class="nm-badge">开发中</span>` : ""}${b.error ? `<span class="nm-badge-g">加载错误</span>` : ""}</div>
          <div class="nm-desc">${nmEsc(text(b.meta && b.meta.description) || text(b.description) || b.name)}</div>
        </div>
        <button class="nm-sw${on ? "" : " off"}" data-sw="${nmEsc(b.name)}" aria-label="${on ? "停用" : "启用"}"><i></i></button>
      </div>`;
    }).join("");
    const plist = market.plugins || [];
    const mrows = plist.map((p) => {
      const installed = (bundles || []).some((b) => b.name === p.name);
      const ptitle = text(p.title) || p.name;
      const ver = p.versions && p.versions[0] ? p.versions[0].version : "";
      return `<div class="nm-row nm-row-plain nm-lrow">
        <div style="flex:1;min-width:0">
          <div><span class="nm-name">${nmEsc(ptitle)}</span>${ver ? `<span class="nm-ver">v${nmEsc(ver)}</span>` : ""}${installed ? `<span class="nm-badge">已安装</span>` : `<span class="nm-badge-g">未安装</span>`}</div>
          <div class="nm-desc">${nmEsc(text(p.description))}</div>
        </div>
        ${installed ? `<button class="nm-btn" data-open="${nmEsc(p.name)}">管理</button>` : ""}
      </div>`;
    }).join("");
    const marketBody = market.loading ? `<div class="nm-empty">读取市场索引…</div>`
      : market.error ? `<div class="nm-empty">市场索引读取失败：${nmEsc(market.error)}</div>`
      : plist.length === 0 ? `<div class="nm-empty">市场还没有上架插件</div>`
      : mrows;
    const localBody = loadFailed && mine.length === 0
      ? `<div class="nm-empty">插件列表读取失败（页面重载后通道偶发未就绪）<button class="nm-btn" id="nm-retry" style="margin-left:8px">重试</button></div>`
      : mine.length === 0 ? `<div class="nm-empty">（没有本机插件）</div>` : mineRows;
    shell.innerHTML = `
      <div class="nm-sec">市场插件</div>
      <div class="nm-card">${marketBody}</div>
      <div class="nm-sec">本机插件（未上架）</div>
      <div class="nm-card">${localBody}</div>
      <div class="nm-msg">${nmEsc(msg)}</div>`;
    const retryBtn = shell.querySelector("#nm-retry");
    if (retryBtn) retryBtn.onclick = () => { msg = "正在重试…"; render(); load(); };
    for (const el of shell.querySelectorAll("[data-open]")) {
      el.addEventListener("click", () => { selected = el.getAttribute("data-open"); render(); });
    }
    for (const el of shell.querySelectorAll("[data-sw]")) {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = el.getAttribute("data-sw");
        if (name === SELF) {
          // 本插件：开关 = 远程访问启停（不能卸载插件本体——这个页面自己会消失）
          msg = remoteRunning ? "正在停止…" : "正在启动…"; render();
          try { await rcApi("/rc-api/toggle", { method: "POST" }); } catch (e2) { msg = "失败：" + (e2.message || e2); }
          await load();
          // toggle 会触发条目重启：重启窗口内读到的可能是旧状态，稍后补拉一次自愈
          setTimeout(() => { load(); }, 3500);
          return;
        }
        const b = (bundles || []).find((x) => x.name === name);
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
        <div class="nm-row nm-row-plain">
          <div style="flex:1"><div><span class="nm-name">${nmEsc(b ? title(b) : selected)}</span>${b && b.version ? `<span class="nm-ver">v${nmEsc(b.version)}</span>` : ""}</div>
          <div class="nm-desc">${nmEsc(b ? ((b.meta && b.meta.description) || b.description || "") : "")}</div></div></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">插件启用</span>
          <button class="nm-sw${b && b.enabled ? "" : " off"}" id="nm-sw"><i></i></button>
          <span class="nm-desc">${b && b.enabled ? "已启用——关闭后该插件立即不可用" : "已停用"}</span></div>
      </div>`;
    shell.querySelector("#nm-back").onclick = () => { selected = null; render(); };
    shell.querySelector("#nm-sw").onclick = () => { if (b) setBundle(b, !b.enabled); };
  }

  load(); // 拉取已安装列表 + 市场索引
  render();

  // 列表态轻轮询：仅当隧道状态真实变化时才重渲染（不重建 DOM 就不会打断点击）；
  // 条目重启窗口期读失败就跳过本轮，下一轮自愈。节点脱离文档后自行停止。
  const poll = setInterval(async () => {
    if (!container.isConnected) { clearInterval(poll); return; }
    if (selected) return; // 详情页有自己的轮询
    // 列表消息与详情页同样自动消失（进行中的「…」除外）
    if (msg && !String(msg).includes("…")) { msg = ""; render(); return; }
    try {
      const s = await rcApi("/rc-api/state");
      if (applyRemote(!!s.running)) render();
    } catch { /* 9091 重启窗口期，跳过 */ }
  }, 5000);
}

// ---------- 槽位注册 ----------

const inject = ["slots", "remote", "remote.pluginManager"];
let NM_PM = null; // pluginManager remote（apply 时捕获的初始引用）
let CTX = null; // 保存 ctx：挂载/重试时现取最新 pluginManager（页面重载后旧代理可能失效）

function apply(ctx) {
  if (!ctx.slots || !ctx.remote) return;
  CTX = ctx;
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
