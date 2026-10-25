window.__ModuleLoader__.load({
	id: "@oh-summy/dsh-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		// client page body — wrapped by scripts/build-client.mjs into lib/client.js
// (window.__ModuleLoader__.load facade; React required from the platform module table).
// Data comes from the plugin's own listener: /rc-api/* via caddy (loopback direct, remote behind the gate).
const { createElement: h, useState, useEffect } = React;

const API_BASE = location.port === "3080" ? "http://127.0.0.1:4080" : "";

async function api(path, options) {
  const res = await fetch(API_BASE + path, { credentials: "include", ...options });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "HTTP " + res.status);
  return json;
}

function App() {
  const [state, setState] = useState(null);
  const [msg, setMsg] = useState("");
  const [shownPassword, setShownPassword] = useState(null);

  const refresh = () => api("/rc-api/state").then(setState).catch(() => setMsg("插件未启用或正在启动…（Settings 表单里勾选 enabled）"));
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);

  const act = (path, body, done) => {
    setMsg("…");
    api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then((r) => { setMsg(done || "完成"); refresh(); return r; })
      .catch((e) => setMsg("失败：" + e.message));
  };

  if (!state) return h("div", { style: styles.box }, msg || "加载中…");

  const copy = (text) => navigator.clipboard.writeText(text).then(() => setMsg("已复制"));
  const reveal = () => api("/rc-api/reveal", { method: "POST" })
    .then((r) => { setShownPassword(r.password); setTimeout(() => setShownPassword(null), 30000); })
    .catch((e) => setMsg("失败：" + e.message));

  return h("div", { style: styles.box },
    h("h3", { style: styles.h }, "远程访问（Cloudflare 临时链接）"),
    h("div", { style: styles.row },
      h("span", { style: state.running ? styles.on : styles.off }, state.running ? "● 运行中" : "○ 已停止"),
      state.url && h("a", { href: state.url, target: "_blank", style: styles.link }, state.url),
      state.url && h("button", { style: styles.btn, onClick: () => copy(state.url) }, "复制链接")),
    h("div", { style: styles.row },
      h("span", { style: styles.label }, "访问密码"),
      h("code", { style: styles.code }, shownPassword || state.passwordMask),
      h("button", { style: styles.btn, onClick: shownPassword ? () => setShownPassword(null) : reveal },
        shownPassword ? "隐藏" : "显示"),
      h("button", { style: styles.btnWarn, onClick: () => { if (confirm("重置密码？所有已登录会话将失效。")) act("/rc-api/reset", null, "密码已重置"); } }, "重置密码")),
    h("div", { style: styles.row },
      h("span", { style: styles.label }, "飞书通知"),
      h("span", null, state.channel === "off" ? "关闭" : state.channel === "webhook" ? "群机器人 webhook" + (state.hasWebhook ? " ✓" : "（URL 未配置）") : "开放平台 app" + (state.hasAppSecret ? " ✓" : "（Secret 未配置）")),
      h("button", { style: styles.btn, onClick: () => act("/rc-api/test", null, "测试通知已发送，看事件流") }, "发送测试")),
    h("div", { style: styles.row },
      h("span", { style: styles.label }, "webhook URL"),
      h("input", { style: styles.input, id: "rc-hook", placeholder: state.hasWebhook ? "已配置（留空保持不变）" : "https://open.feishu.cn/open-apis/bot/v2/hook/…" })),
    h("div", { style: styles.row },
      h("span", { style: styles.label }, "App Secret"),
      h("input", { style: styles.input, id: "rc-sec", type: "password", placeholder: state.hasAppSecret ? "已配置（留空保持不变）" : "app secret" }),
      h("button", { style: styles.btn, onClick: () => act("/rc-api/notify-secret", {
        webhookUrl: document.getElementById("rc-hook").value.trim() || undefined,
        appSecret: document.getElementById("rc-sec").value.trim() || undefined,
      }, "凭据已保存（通道/App ID/open_id 在下方设置表单里改）") }, "保存凭据")),
    h("p", { style: styles.note }, "通道、App ID、接收者 open_id、密码档位在 Settings → 远程访问 的设置表单里修改（改配置会重启隧道并产生新链接，密码会随 started 通知推送）。open_id 获取：开放平台给应用加 im:message 权限后，让机器人给目标发一条消息即可从 API 调试台拿到。"),
    msg && h("p", { style: styles.msg }, msg),
    h("h4", { style: styles.h }, "事件"),
    h("div", { style: styles.events },
      state.events.length === 0 ? "（暂无）" :
      state.events.map((e, i) => h("div", { key: i, style: styles.event }, e.time + " · " + e.type + " · " + e.detail))));
}

const styles = {
  box: { fontFamily: "system-ui", maxWidth: 640, fontSize: 14, lineHeight: 1.7 },
  h: { margin: "14px 0 6px" },
  row: { display: "flex", alignItems: "center", gap: 8, margin: "8px 0", flexWrap: "wrap" },
  label: { minWidth: 90, color: "#666" },
  on: { color: "#0a0" }, off: { color: "#999" },
  link: { wordBreak: "break-all" },
  code: { background: "#f4f4f5", padding: "2px 8px", borderRadius: 4 },
  input: { flex: 1, minWidth: 220, padding: "6px 8px", boxSizing: "border-box" },
  btn: { padding: "4px 12px", cursor: "pointer" },
  btnWarn: { padding: "4px 12px", cursor: "pointer", color: "#c00" },
  note: { color: "#888", fontSize: 12 },
  msg: { color: "#06c" },
  events: { maxHeight: 220, overflow: "auto", fontSize: 12, color: "#555", border: "1px solid #eee", borderRadius: 6, padding: 8 },
  event: { whiteSpace: "pre-wrap", wordBreak: "break-all" },
};

// host-side mount: register the page as a tab in Settings → Built-in plugins
const inject = ["slots"];

function apply(ctx) {
  if (!ctx.slots) return;
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
    name: "settings.plugins.tab",
    id: "dsh-remote",
    order: 99,
    label: () => "远程访问",
  }, App));
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
