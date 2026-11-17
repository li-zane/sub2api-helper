import assert from "node:assert/strict";
import {shareSnapshot,shareJobList} from "../web/src/polling-snapshot.mjs";
const jobs=Array.from({length:20},(_,i)=>({id:String(i),status:"completed",usage:{tokens:100,stale:false},monitor:{points:[1,2,3],enabled:true}}));
const copy=structuredClone(jobs);assert.equal(shareJobList(jobs,copy),jobs);
copy[7].usage.tokens=101;const changed=shareJobList(jobs,copy);assert.notEqual(changed,jobs);assert.notEqual(changed[7],jobs[7]);assert.equal(changed[7].monitor,jobs[7].monitor);assert.equal(changed.filter((j,i)=>j===jobs[i]).length,19);
const reversed=shareJobList(jobs,structuredClone(jobs).reverse());assert.equal(reversed[0],jobs[19]);assert.equal(reversed[19],jobs[0]);
assert.deepEqual(shareJobList(jobs,[]),[]);const withMissing={x:1};assert.notEqual(shareSnapshot(withMissing,{x:1,y:undefined}),withMissing);assert.deepEqual(shareSnapshot({x:1,y:2},{x:1}),{x:1});
assert.equal(shareSnapshot(null,null),null);assert.equal(shareSnapshot([1,2],[1,2])[0],1);assert.deepEqual(shareSnapshot([1],{a:2}),{a:2});
const special=JSON.parse('{"__proto__":{"x":1},"constructor":2}');const shared=shareSnapshot({},special);assert.equal(Object.hasOwn(shared,"__proto__"),true);assert.equal({}.x,undefined);
// A late difference must retain earlier shared children, including a key
// named "__proto__"; removed or renamed keys must never survive the merge.
const old = JSON.parse('{"__proto__":{"n":1},"nested":[{"n":2}],"tail":1}');
const fresh = JSON.parse(JSON.stringify(old)); fresh.tail++;
const merged = shareSnapshot(old, fresh);
assert.equal(Object.getPrototypeOf(merged), Object.prototype);
assert.equal(merged.__proto__, old.__proto__); assert.equal(merged.nested, old.nested);
assert.equal(merged.tail, 2); assert.equal(old.tail, 1); assert.notEqual(fresh.nested, old.nested);
assert.deepEqual(shareSnapshot({ a: 1 }, { b: undefined }), { b: undefined });
const prefix = [{ n: 1 }, { n: 2 }];
assert.equal(shareSnapshot(prefix, [{ n: 1 }])[0], prefix[0]);
assert.equal(shareSnapshot(prefix, [{ n: 1 }, { n: 2 }, 3])[1], prefix[1]);
assert(Object.is(shareSnapshot([0], [-0])[0], -0));
console.log("FRONTEND_SNAPSHOT_PASS identical poll reuses all 20 rows; one account update reuses 19/20 rows; nested state/reorder/delete/unknown fields preserved");
