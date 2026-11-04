import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";

try {
  const source = await fs.readFile(process.env.UI_POLISH_MAIN || "web/src/main.jsx", "utf8");
  const css = await fs.readFile(process.env.UI_POLISH_CSS || "web/src/styles.css", "utf8");
  const start = source.indexOf("const usageCreditBalanceFormatter");
  const fnStart = source.indexOf("function formatUsageCreditBalance(");
  assert(fnStart >= 0, "balance formatter missing");
  const end = source.indexOf("function AccountUsageCell(", fnStart);
  const format = vm.runInNewContext(source.slice(start >= 0 ? start : fnStart, end) + "\nformatUsageCreditBalance;", { Intl, Number });
  for (const [input, expected] of [["1.005", "1.01"], ["2.675", "2.68"], [1.005, "1.01"], [2.675, "2.68"], ["250.0000000000", "250.00"], ["961.5884507500", "961.59"], [0, "0.00"], ["0", "0.00"], ["9007199254740993.005", "9007199254740993.01"], ["未知", "未知"]]) assert.equal(format(input), expected, `decimal rounding failed for ${input}`);
  for (const input of [null, undefined, true, false, "", " ", "invalid", Infinity, NaN, "0x10"]) assert.equal(format(input), null);
  const ipRule = css.match(/\.session-login-ip\s*\{([^}]+)\}/)?.[1] || "";
  const codeRule = css.match(/\.session-login-ip code\s*\{([^}]+)\}/)?.[1] || "";
  assert(/min-width:\s*0\s*;/.test(ipRule) && /max-width:\s*100%\s*;/.test(ipRule), "IP pill must stay inside its flex column");
  assert(/overflow-wrap:\s*anywhere\s*;/.test(codeRule), "IPv6 must wrap without truncating data");
  const actionStart = source.indexOf('<span className={`workspace-item-action');
  const actionEnd = source.indexOf("\n                </button>", actionStart);
  assert(actionStart >= 0 && actionEnd > actionStart);
  const jsx = `function renderAction({ selected, disabled, action='', workspace={id:'current'}, disabledActionText='已停用' }) { return (${source.slice(actionStart, actionEnd).trim()}); }`;
  const compiled = await transformWithEsbuild(jsx, "workspace-action.jsx", { loader: "jsx", jsx: "transform" });
  const icon = () => React.createElement("svg");
  const renderAction = vm.runInNewContext(compiled.code + "\nrenderAction;", { React, Check: icon, Ban: icon, LoaderCircle: icon });
  const render = props => renderToStaticMarkup(renderAction(props));
  const blocked = render({ selected: true, disabled: true });
  assert(blocked.includes('workspace-item-action disabled') && blocked.includes("已停用") && !blocked.includes("当前空间"), "disabled current workspace must not look healthy");
  assert(render({ selected: true, disabled: false }).includes("workspace-item-action current"));
  assert(render({ selected: false, disabled: false }).includes("workspace-item-action switchable"));
  assert(render({ selected: true, disabled: true, action: "current" }).includes("workspace-item-action switching"));
  console.log("UI_POLISH_PASS decimal-rounding; invalid/zero/large-values; IPv6-wrap; disabled-current-priority; action-states");
} catch (error) { console.error("UI_POLISH_FAIL: " + error.message.split("\n")[0]); process.exitCode = 1; }
