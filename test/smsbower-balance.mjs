import { formatSmsMoney } from "../web/src/sms-money.mjs";
import assert from 'node:assert/strict';import path from 'node:path';import{pathToFileURL}from'node:url';
const {createSmsBowerClient}=await import(pathToFileURL(process.env.SMSBOWER_BALANCE_SOURCE||path.resolve('src/smsbower.mjs')));
const actions=[],key='private-fixture-key';let balance='12.345600',mode='normal';
const c=createSmsBowerClient({apiKey:key,fetchImpl:async url=>{const u=new URL(url),a=u.searchParams.get('action');actions.push(a);assert.equal(u.searchParams.get('api_key'),key);return new Response(a==='getBalance'?(mode==='normal'?'ACCESS_BALANCE:'+balance:mode==='bad-key'?'BAD_KEY':'ACCESS_BALANCE:NaN'):a==='getPrices'?JSON.stringify({7:{dr:{cost:0.004,count:2}}}):a==='getCountries'?JSON.stringify([{id:7,eng:'Malaysia'}]):'BAD_ACTION');}});
assert.equal(typeof c.getBalance,'function','SMSBower must support read-only balance lookup');assert.deepEqual(await c.getBalance(),{amount:'12.345600',currency:'USD'});balance='0';assert.deepEqual(await c.getBalance(),{amount:'0',currency:'USD'});mode='bad-key';await assert.rejects(c.getBalance(),/API Key/);mode='invalid';await assert.rejects(c.getBalance(),/格式/);
assert.equal(formatSmsMoney(0.004),'0.004 USD');assert.equal(formatSmsMoney('0'),'0 USD');
const prices=await c.getPriceOptions('dr');assert.equal(prices[0].currency,'USD');assert.equal(prices[0].price,0.004);assert(!actions.some(a=>/Number|setStatus/.test(a)));
console.log('SMSBOWER_BALANCE_PASS exact_decimal=true zero=true currency=USD read_only=true invalid_response_rejected=true price_precision=0.004');
