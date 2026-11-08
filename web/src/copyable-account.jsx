import React from "react";
import { notify } from "./toast-events.mjs";

export function CopyableAccount({ email, className = "", children }) {
  if (!email) return null;
  return <button type="button" className={`copyable-account ${className}`.trim()}
    title={`点击复制账号 ${email}`} aria-label={`复制账号名 ${email}`}
    onClick={async event => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(email);
        notify("账号已复制");
      } catch {
        notify("账号复制失败，请手动选择复制", { tone: "error" });
      }
    }}>{children || email}</button>;
}

// Keep surrounding text intact, including whitespace in protocol/credential logs.
export function AccountText({ text }) {
  if (typeof text !== "string") return text;
  return text.split(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi).map((part, index) =>
    index % 2 ? <CopyableAccount key={index} email={part} /> : part);
}
