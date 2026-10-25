// Wraps client-src/client.js into the dsh client-module facade (lib/client.js),
// mirroring the official inventory client's shape:
// window.__ModuleLoader__.load({ id, factory: (require) => { var module={exports:{}}; ...; return module.exports } }).
// The body gets React from the platform module table via the factory's require.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const body = readFileSync(new URL("../client-src/client.js", import.meta.url), "utf8");
const { name } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tconst React = require("react");
\t\t${body}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`;
mkdirSync(new URL("../lib", import.meta.url), { recursive: true });
writeFileSync(new URL("../lib/client.js", import.meta.url), out);
console.log("lib/client.js written (" + out.length + " bytes)");
