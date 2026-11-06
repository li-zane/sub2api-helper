import assert from "node:assert/strict";
import { smsOrderCost, smsOrderLog } from "../src/sms-order-cost.mjs";
import { createSmsBowerClient } from "../src/smsbower.mjs";
import { createLubanSmsClient } from "../src/luban-sms.mjs";
assert.deepEqual(smsOrderCost("0.004",840),{amount:"0.004",currency:"USD"});
assert.deepEqual(smsOrderCost(0,"EUR"),{amount:"0",currency:"EUR"});
assert.deepEqual(smsOrderCost("0.18"),{amount:"0.18",currency:null});
for(const value of [null,undefined,true,false,-1,NaN,Infinity,"bad","1\n2"])assert.equal(smsOrderCost(value,"USD"),null);
let actions=[];
const client=createSmsBowerClient({apiKey:"fixture-private-key",fetchImpl:async url=>{
  actions.push(new URL(url).searchParams.get("action"));
  return new Response(JSON.stringify({activationId:"paid-1",phoneNumber:"12025550123",activationCost:"0.18",currency:840}));
}});
const order=await client.getNumber("dr","1001","0.42");
assert.deepEqual(actions,["getNumberV2"]);assert.deepEqual(order.cost,{amount:"0.18",currency:"USD"});
const line=smsOrderLog("SMSBower",{...order,apiKey:"fixture-private-key"},{maxPrice:"0.42"});
assert.match(line,/手机号 \+12025550123/);assert.match(line,/金额 0\.18 USD/);assert.match(line,/价格上限 0\.42（非实际金额）/);assert(!line.includes("fixture-private-key"));
actions=[];
const legacy=createSmsBowerClient({apiKey:"fixture-private-key",fetchImpl:async url=>{
  const action=new URL(url).searchParams.get("action");actions.push(action);return new Response(action==="getNumberV2"?"BAD_ACTION":"ACCESS_NUMBER:legacy-1:12025550123");
}});
const unknown=await legacy.getNumber("dr","1001","0.42");assert.deepEqual(actions,["getNumberV2","getNumber"]);assert.equal(unknown.cost,undefined);
assert.match(smsOrderLog("SMSBower",unknown,{maxPrice:"0.42"}),/金额 未知/);
for(const failure of [()=>Promise.reject(Object.assign(Error("timeout"),{name:"AbortError"})),()=>new Response("not-json"),()=>new Response("down",{status:503})]){
  let calls=0;const broken=createSmsBowerClient({apiKey:"fixture-private-key",fetchImpl:async()=>{calls++;return failure()}});
  await assert.rejects(broken.getNumber("dr","1001"));assert.equal(calls,1,"ambiguous V2 failure purchased again using V1");
}
const malformed=createSmsBowerClient({apiKey:"fixture-private-key",fetchImpl:async()=>new Response(JSON.stringify({activationId:"paid-broken",activationCost:0.2}))});
await assert.rejects(malformed.getNumber("dr","1001"),error=>error.smsOrder?.requestId==="paid-broken"&&error.smsOrder.cost.amount==="0.2");
const luban=createLubanSmsClient({apiKey:"fixture-private-key",fetchImpl:async()=>new Response(JSON.stringify({code:0,number:"12025550123",request_id:"luban-1",price:1.5,currency:"CNY"}))});
assert.deepEqual((await luban.getNumber("fixture")).cost,{amount:"1.5",currency:"CNY"});
assert.match(smsOrderLog("手动号码",{number:"+12025550123"}),/金额 未知/);
assert.match(smsOrderLog("SMSBower",order,{late:true}),/任务结束后取号返回/);
console.log("SMS_ORDER_COST_PASS V2 actual cost/currency; explicit BAD_ACTION-only legacy fallback; no ambiguous repurchase; upper-limit never actual cost; unknown not zero; known malformed paid order retained for cancel; Luban fields; private logs");
