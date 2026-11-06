import React from "react";
import { createRoot } from "react-dom/client";
import { HelpTip } from "../web/src/help-tip.jsx";

export function mount() {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  root.render(<div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 100 }}>
    <HelpTip label="Long edge help" title="配置说明">
      {Array.from({ length: 18 }, (_, i) => <div key={i}>第 {i + 1} 项配置：检测任务使用当前账号与代理，按保存的间隔执行。</div>)}
    </HelpTip>
  </div>);
  return () => { root.unmount(); node.remove(); };
}
