import { registerHooks } from "node:module";

// This HTTP fixture tests transport, persistence and unknown-result handling,
// not model attribution. Retain real SDK prompts/parsing without a CDN dependency.
// Scoring/admission behavior is covered separately in model-fingerprint.mjs.
const sdk = import.meta.resolve("lmfpd-sdk");
const fixture = "data:text/javascript," + encodeURIComponent(`
  import assert from "node:assert/strict";
  import { parseNumbers } from ${JSON.stringify(sdk)};
  export { generateChallenges, parseNumbers } from ${JSON.stringify(sdk)};
  export async function loadDetector() {
    return { builtAt: "fixture-console-transport", analyze(outputs, options) {
      assert.equal(options.strict, true);
      assert.equal(outputs.length, 3);
      for (const output of outputs) assert.equal(parseNumbers(output.text).length, 332);
      return { used_outputs: 3, decision: "unknown", probability_status: "fixture_uncalibrated",
        prediction: null, probability: null, results: [] };
    } };
  }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lmfpd-sdk" && context.parentURL?.endsWith("/src/model-fingerprint.mjs")) return { url: fixture, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
