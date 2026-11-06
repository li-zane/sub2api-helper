import assert from "node:assert/strict";
import { confirmTotpDisable, confirmedTotpState } from "../src/totp-disable-confirmation.mjs";
import { totpRotationView } from "../web/src/totp-rotation-state.mjs";
const enabled={mfa_enabled:true,mfa_enabled_v2:true,factors:{totp:[{id:"old-factor"}]}};
const disabled={mfa_enabled:false,mfa_enabled_v2:false,factors:{totp:[]},native_default_factor_id:null};
assert.equal(confirmedTotpState(enabled),true);assert.equal(confirmedTotpState(disabled),false);
for(const info of [{},null,{mfa_enabled_v2:true},{mfa_enabled:true,mfa_enabled_v2:false},{...disabled,native_default_factor_id:"still-present"}])assert.equal(confirmedTotpState(info),null);
for(const acknowledged of [true,false]){
  const events=[];await confirmTotpDisable({disable:async()=>{events.push('POST');return{acknowledged}},readInfo:async()=>{events.push('GET');return disabled},persist:async p=>events.push(p)});
  assert.deepEqual(events.slice(0,2),['POST','GET']);assert.equal(events[2].remote_disabled,true);
}
for(const [acknowledged,info,code]of[[false,enabled,'REJECTED'],[true,enabled,'UNCONFIRMED'],[false,{},'UNCONFIRMED']]){
  let last;await assert.rejects(confirmTotpDisable({disable:async()=>({acknowledged}),readInfo:async()=>info,persist:async p=>{last=p}}),new RegExp(code));assert.equal(last.remote_disabled,false);
}
for(const phase of['disable','readInfo']){
  let last;await assert.rejects(confirmTotpDisable({disable:async()=>{if(phase==='disable')throw Error('network');return{acknowledged:true}},readInfo:async()=>{throw Error('503')},persist:async p=>{last=p}}));assert.equal(last.stage,'disable_unconfirmed');assert.equal(last.remote_disabled,false);
}
for(const status of['queued','working','mfa_otp','totp_setup_otp','finalizing'])assert.equal(totpRotationView({status,lastOperationType:'replace_2fa',totpRotationIncomplete:true}).state,'running');
assert.equal(totpRotationView({status:'completed',totpRotationIncomplete:true}).state,'incomplete');
assert.equal(totpRotationView({status:'completed',totpRotationIncomplete:true},true).state,'running');
console.log('TOTP_DISABLE_CONFIRMATION_PASS HTTP200 without success accepted only after explicit MFA-disabled proof; enabled/rejected/unknown/network stays blocked; durable uncertainty; pending UI not failure');
