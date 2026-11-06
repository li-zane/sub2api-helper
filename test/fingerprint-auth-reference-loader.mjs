import { registerHooks } from "node:module";

// These two HTTP tests exercise AUTH/BANNED recovery, never attribution. Keep
// the real SDK challenge generator/parser, but remove the public CDN download
// prerequisite so a reference outage cannot hide the authentication response.
const sdk = import.meta.resolve("lmfpd-sdk");
const fixture = "data:text/javascript," + encodeURIComponent(`
  export { generateChallenges, parseNumbers } from ${JSON.stringify(sdk)};
  export async function loadDetector() {
    return { builtAt: "fixture-auth-recovery",
      analyze() { throw new Error("AUTH/BANNED fixtures must stop before scoring"); } };
  }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lmfpd-sdk" && context.parentURL?.endsWith("/src/model-fingerprint.mjs")) return { url: fixture, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
