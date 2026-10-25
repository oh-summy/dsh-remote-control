window.__ModuleLoader__.load({
	id: "@oh-summy/dsh-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		// Nano Market client — 最小探针版（定位 plugins.tab 挂载阻塞问题用）
const { createElement: h } = React;

const inject = ["slots", "remote", "remote.pluginManager"];
let NM_PM = null;
let NM_ERRS = [];

window.__RC_ERRS__ = NM_ERRS;
const origErr = console.error;
console.error = (...a) => { NM_ERRS.push(a.map(x => String(x?.stack || x?.message || x)).join("|").slice(0, 600)); origErr(...a); };
window.addEventListener("error", (e) => NM_ERRS.push("onerror: " + e.message));

function apply(ctx) {
  try {
    if (!ctx.slots || !ctx.remote) return;
    const pm = ctx.remote.pluginManager;
    if (!pm) { NM_ERRS.push("no pluginManager"); return; }
    NM_PM = pm;
    ctx.slots.inject("plugins.tab", () => ctx.slots.register({
      name: "plugins.tab",
      id: "nano-market",
      label: () => "Nano Market",
    }, function NanoMarketTab(mountArg) {
      const mount = (node) => {
        try {
          node.innerHTML = '<div style="padding:20px;font-size:14px;font-family:system-ui">NANO MARKET TAB MOUNTED ✓ <button id="nm-probe-list">listBundles</button> <pre id="nm-probe-out" style="white-space:pre-wrap;font-size:12px"></pre></div>';
          const out = node.querySelector("#nm-probe-out");
          node.querySelector("#nm-probe-list").onclick = async () => {
            out.textContent = "listBundles() 调用中…";
            try {
              const r = await NM_PM.listBundles();
              const rows = (r && (r.value ?? r.result)) || r;
              out.textContent = JSON.stringify(Array.isArray(rows) ? rows.map(b => ({ name: b.name, enabled: b.enabled, installed: b.installed })) : rows, null, 1).slice(0, 800);
            } catch (e) { out.textContent = "listBundles 失败: " + (e.message || e); }
          };
        } catch (e) {
          node.innerHTML = "MOUNT FAIL: " + String((e && e.stack) || e);
          NM_ERRS.push("mount fail: " + String((e && e.stack) || e));
        }
      };
      if (mountArg instanceof Element) { mount(mountArg); return null; }
      return h("div", { ref: (node) => { if (node) setTimeout(() => mount(node), 0); }, style: { display: "contents" } });
    }));
  } catch (e) {
    NM_ERRS.push("apply threw: " + String((e && e.stack) || e));
  }
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
