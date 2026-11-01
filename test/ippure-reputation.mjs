import assert from "node:assert/strict";
import { normalizeReputation } from "../src/proxy-quality.mjs";

const pure = normalizeReputation({ fraudScore: 0, isResidential: true, isBroadcast: false,
  country: "Fixture", countryCode: "ZZ", region: "Test Region", city: "Test City",
  asn: 64500, asOrganization: "Fixture ISP" });
assert.equal(pure.riskScore, 0, "IPPure zero fraud score is preserved");
assert.equal(pure.riskLevel, "low");
assert.equal(pure.residential, true);
assert.equal(pure.broadcast, false);
assert.equal(pure.provider, "Fixture ISP");
assert.equal(pure.asn, "AS64500");
assert.equal(pure.proxy, null, "IPPure residential flag is not a proxy/VPN verdict");
assert.equal(pure.hosting, null, "non-residential alone does not imply a datacenter");
assert.equal(normalizeReputation({ fraudScore: 95 }).riskLevel, "high");
for (const fraudScore of [undefined, null, "", true, false, -1, 101, "unknown"]) {
  assert.equal(normalizeReputation({ fraudScore }).riskScore, null, "unknown score never becomes zero");
}
console.log("PASS: IPPure fraud score, zero/unknown values, native field mapping and no inferred proxy flags");
