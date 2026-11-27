import { parentPort, workerData } from "node:worker_threads";

try {
  parentPort.postMessage({ matched: new RegExp(workerData.pattern, workerData.flags).test(workerData.text) });
} catch {
  parentPort.postMessage({ error: true });
}
