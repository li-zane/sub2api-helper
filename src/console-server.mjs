#!/usr/bin/env node
import { createConsoleApp } from "./console-app.mjs";

function readOption(flag) {
  const prefix = `${flag}=`;
  const inline = process.argv.find(item => item.startsWith(prefix));
  const index = process.argv.indexOf(flag);
  return inline?.slice(prefix.length) || (index >= 0 ? process.argv[index + 1] : "");
}

const host = String(readOption("--host") || process.env.ONBOARDING_HOST || "127.0.0.1").trim();
const port = Number(readOption("--port") || 4399);
if (!host || host.startsWith("--")) throw new Error("--host must be a valid hostname or IP address");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

const app = createConsoleApp({ host, port });
let stopping;
function removeSignalHandlers() {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
function stop() {
  stopping ??= app.stop().catch(error => {
    console.error(`[shutdown] ${error.message}`);
    process.exitCode = 1;
  }).finally(removeSignalHandlers);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const { urls, outputRoot, wildcard } = await app.start();
  if (!stopping) {
    console.log(`[ok] ChatGPT onboarding console: ${urls[0]}`);
    for (const url of urls.slice(1)) console.log(`[ok] LAN access: ${url}`);
    console.log(`[info] Output directory: ${outputRoot}`);
    console.log(wildcard
      ? "[note] LAN access is enabled without authentication. Keep downloaded OAuth files private."
      : "[note] This server only listens on the configured host. Keep downloaded OAuth files private.");
  }
} catch (error) {
  removeSignalHandlers();
  throw error;
}
