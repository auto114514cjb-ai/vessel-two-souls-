import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatGPTPlan, CredentialFile, verifyIdentity, readResponseStream } from '../chatgpt.mjs';
import { Desk, validateConfig } from '../core.mjs';
import { createApp } from '../server.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({format:'jwk'}), kid:'test', alg:'RS256', use:'sig' }] };
function sign(claims, key=privateKey) {
  const data = [Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'), Buffer.from(JSON.stringify({iss:'https://auth.openai.com', aud:'oaiapp_test', sub:'subject',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})).toString('base64url')].join('.');
  return data + '.' + crypto.sign('sha256',Buffer.from(data),key).toString('base64url');
}
const json = value => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const stream = events => new Response(events.map(event).join(''),{headers:{'Content-Type':'text/event-stream'}});
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-chatgpt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store={data:{accounts:[],active:''},read(){return structuredClone(this.data)},save(d){this.data=structuredClone(d)}};
  const plan=new ChatGPTPlan(dir,{store,fetchImpl:async()=>{throw new Error('unexpected network')}});
  return {dir,store,plan};
}
function authorizeFixture(plan, overrides={}) {
  const a={client_id:'oaiapp_test',sub:'subject',access_token:'access-secret',refresh_token:'refresh-secret',id_token:'id-secret',scope:'openid resource.invoke chatgpt.tokens.use.direct',expires_at:Date.now()+3600000,...overrides};
  plan.load().accounts=[a];plan.load().active=a.client_id;return a;
}
test('ChatGPT dynamic registration persists host ID, uses fresh PKCE/state/nonce and rejects callback mismatch',async t=>{
  const {dir,store,plan}=setup(t);const first=new URL(plan.begin('http://127.0.0.1:17860'));
  assert.equal(first.origin,'https://auth.openai.com');assert.equal(first.searchParams.get('client_id'),'dynamic_agent_client');
  assert.match(first.searchParams.get('scope'),/chatgpt.tokens.use.direct/);assert.equal(first.searchParams.get('redirect_uri'),'http://127.0.0.1:17860/auth/callback');
  const p=plan.pending;assert.equal(first.searchParams.get('code_challenge'),crypto.createHash('sha256').update(p.verifier).digest('base64url'));
  const again=new ChatGPTPlan(dir,{store});assert.equal(again.hostId,plan.hostId);
  await assert.rejects(plan.callback(new URL('http://127.0.0.1:17860/auth/callback?state=wrong&code=secret')),/不匹配/);
  assert.equal(plan.pending,p);const second=new URL(plan.begin('http://127.0.0.1:17860'));assert.notEqual(second.searchParams.get('state'),p.state);assert.notEqual(plan.pending.nonce,p.nonce);
  assert.throws(()=>plan.begin('https://example.com'),/本机/);
});
test('sign-in fails before authorization if local credential protection is unavailable',t=>{
  const {plan}=setup(t);plan.store.checkProtection=()=>{throw new Error('Windows protection unavailable')};
  assert.throws(()=>plan.begin('http://127.0.0.1:17860'),/protection unavailable/);assert.equal(plan.pending,null);assert.equal(plan.status().signedIn,false);
});
test('OAuth exchange uses issued client ID, verifies signed identity and scopes, consumes callback once',async t=>{
  const {plan,store}=setup(t);plan.begin('http://127.0.0.1:17860');const p=plan.pending;let exchange;
  plan.fetch=async(url,options)=>{
    assert.equal(options.redirect,'error');
    if(url.endsWith('/oauth/token')) {exchange=new URLSearchParams(options.body);return json({access_token:'access-secret',refresh_token:'refresh-secret',id_token:sign({nonce:p.nonce,email:'me@example.test'}),scope:'openid resource.invoke chatgpt.tokens.use.direct',token_type:'Bearer',expires_in:3600})}
    assert.equal(url,'https://auth.openai.com/.well-known/jwks.json');return json(jwks);
  };
  const callback=new URL(`http://127.0.0.1:17860/auth/callback?state=${p.state}&code=one-code&client_id=oaiapp_test`);
  assert.equal((await plan.callback(callback)).planEnabled,true);assert.equal(exchange.get('client_id'),'oaiapp_test');assert.equal(exchange.get('code_verifier'),p.verifier);assert.equal(exchange.get('resource'),'https://api.openai.com/v1');
  assert.equal(store.data.accounts[0].sub,'subject');assert.equal(plan.status().welcome,true);assert.ok(!JSON.stringify(plan.status()).includes('secret'));
  plan.acknowledge();assert.equal(plan.status().welcome,false);
  await assert.rejects(plan.callback(callback),/不匹配/);
  const reauth=new URL(plan.begin('http://127.0.0.1:17860'));assert.equal(reauth.searchParams.get('client_id'),'oaiapp_test');assert.equal(reauth.searchParams.has('agent_name_hint'),false);assert.ok(reauth.searchParams.has('id_token_hint'));
});
test('JWT validation rejects bad signatures, issuer, audience, nonce, expiry and changed returning identity',()=>{
  assert.equal(verifyIdentity(sign({nonce:'n'}),jwks,{clientId:'oaiapp_test',nonce:'n'}).sub,'subject');
  for(const bad of [{iss:'https://evil.test'},{aud:'other'},{nonce:'wrong'},{exp:1},{sub:'other'},{iat:Date.now()/1000+3600}])
    assert.throws(()=>verifyIdentity(sign({nonce:'n',...bad}),jwks,{clientId:'oaiapp_test',nonce:'n',subject:'subject'}),/验证失败/);
  const badKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  assert.throws(()=>verifyIdentity(sign({nonce:'n'},badKey),jwks,{clientId:'oaiapp_test',nonce:'n'}),/验证失败/);
});
test('identity-only grants cannot use plan inference and returning registrations cannot change client ID',async t=>{
  const {plan}=setup(t);authorizeFixture(plan,{scope:'openid email'});await assert.rejects(plan.models(),/允许使用订阅/);
  plan.begin('http://127.0.0.1:17860');const state=plan.pending.state;
  await assert.rejects(plan.callback(new URL(`http://127.0.0.1:17860/auth/callback?state=${state}&code=x&client_id=other`)),/注册未完成/);
  assert.equal(plan.account().access_token,'access-secret');
});
test('refreshes serialize rotating tokens and save replacements without changing the identity hint',async t=>{
  const {plan,store}=setup(t);authorizeFixture(plan,{expires_at:1});let calls=0;
  plan.fetch=async(url,o)=>{calls++;const b=new URLSearchParams(o.body);assert.equal(b.get('grant_type'),'refresh_token');assert.equal(b.get('refresh_token'),'refresh-secret');assert.equal(b.has('scope'),false);await new Promise(r=>setImmediate(r));return json({access_token:'new-secret',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600})};
  assert.deepEqual(await Promise.all([plan.access(),plan.access(),plan.access()]),['new-secret','new-secret','new-secret']);assert.equal(calls,1);assert.equal(store.data.accounts[0].refresh_token,'new-refresh');assert.equal(plan.account().id_token,'id-secret');
});
test('subscription catalog controls model choices and pure chat sets required flags without tool execution',async t=>{
  const {plan}=setup(t);authorizeFixture(plan);let body;
  plan.fetch=async(url,o)=>{
    assert.equal(o.headers.Authorization,'Bearer access-secret');
    if(url.endsWith('/models'))return json({models:[{slug:'gpt-test',display_name:'Account model',visibility:'list'},{slug:'hidden',visibility:'hide'},{slug:'gpt-image-test',visibility:'list'}]});
    assert.equal(url,'https://api.openai.com/v1/responses');body=JSON.parse(o.body);
    return stream([{type:'response.output_text.delta',delta:'你好'},{type:'response.completed',response:{status:'completed'}}]);
  };
  assert.deepEqual(await plan.models(),[{id:'gpt-test',name:'Account model'}]);
  assert.equal(await plan.chat('gpt-test','共享上下文'), '你好');assert.equal(body.store,false);assert.equal(body.stream,true);assert.deepEqual(body.tools,[]);assert.equal(body.input[0].content,'共享上下文');assert.equal(body.max_output_tokens,undefined);
  await assert.rejects(plan.chat('saved-but-unavailable','x'),/选择当前/);
});
test('stream failures after text, tool calls and missing completion never count as a successful answer',async()=>{
  const partial={type:'response.output_text.delta',delta:'不完整'};
  await assert.rejects(readResponseStream(stream([partial,{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),/额度/);
  await assert.rejects(readResponseStream(stream([partial])),/中断/);
  await assert.rejects(readResponseStream(stream([{type:'response.output_item.added',item:{type:'function_call',name:'shell'}}])),/没有执行工具/);
  await assert.rejects(readResponseStream(stream([partial,{type:'response.incomplete'}])),/未完整/);
});
test('logout revokes renewable session, clears tokens but keeps registration, and reports failed revocation',async t=>{
  const {plan,store}=setup(t);authorizeFixture(plan);let revoked;
  plan.fetch=async(url,o)=>{if(url.endsWith('openid-configuration'))return json({revocation_endpoint:'https://auth.openai.com/oauth/revoke'});revoked=new URLSearchParams(o.body);return new Response('',{status:200})};
  assert.match(await plan.signOut(),/已退出/);assert.equal(revoked.get('token'),'refresh-secret');assert.equal(plan.status().signedIn,false);assert.equal(store.data.accounts[0].client_id,'oaiapp_test');assert.equal(store.data.accounts[0].id_token,undefined);
  authorizeFixture(plan);plan.fetch=async()=>{throw new Error('network')};assert.match(await plan.signOut(),/未能确认远端撤销/);assert.equal(plan.status().signedIn,false);
});
test('Windows credential file is encrypted and survives a same-user round trip',t=>{
  const {dir}=setup(t);const store=new CredentialFile(dir);const value={accounts:[{access_token:'test-access-secret'}],active:'test'};
  try { store.save(value); } catch(e) { if(e.code==='E_DPAPI_UNAVAILABLE') { t.skip('DPAPI is unavailable in this execution environment; verify in the user-launched app'); return; } throw e; }
  assert.deepEqual(store.read(),value);
  if(process.platform==='win32'){const onDisk=fs.readFileSync(store.file,'utf8');assert.ok(!onDisk.includes('test-access-secret'));assert.match(onDisk,/windows-dpapi/)}
});
test('credential envelope calls protection in both directions and never falls back to plaintext on Windows',t=>{
  const {dir}=setup(t);const calls=[];const cipher=Buffer.from('opaque-encrypted-value');let clear;
  const store=new CredentialFile(dir,(value,decrypt)=>{calls.push(!!decrypt);if(decrypt){assert.deepEqual(value,cipher);return clear}clear=value;return cipher});
  const data={accounts:[{access_token:'test-secret'}],active:'id'};store.save(data);assert.deepEqual(store.read(),data);
  if(process.platform==='win32'){assert.deepEqual(calls,[false,true]);assert.ok(!fs.readFileSync(store.file,'utf8').includes('test-secret'));}
});
test('private and group ChatGPT routes retain role cards and bypass every local work agent',async t=>{
  const {dir}=setup(t);const calls=[];const plan={chat:async(...args)=>{calls.push(args);return 'GPT 文字回答'},status:()=>({signedIn:true,planEnabled:true})};
  const desk=new Desk(dir,{chatgptPlan:plan,deepseek:async()=>{throw new Error('local agent must not run')}});
  desk.config=validateConfig({gptBackend:'chatgpt',groupGptBackend:'chatgpt',chatgptModel:'private-model',chatgptGroupModel:'group-model',allowedGroups:'55555'},desk.config);desk.ensureChannels();
  desk.submit('私人消息','codex');await desk.tail;assert.equal(calls[0][0],'private-model');assert.match(calls[0][1],/理性、沉稳/);assert.equal(desk.state.messages.at(-1).speaker,'GPT');
  desk.selectChannel('group:55555');desk.submitComputer('群消息','codex');await desk.tail;assert.equal(calls[1][0],'group-model');assert.match(calls[1][1],/不处理写代码、生图/);assert.ok(!calls[1][1].includes('私人消息'));
});
test('HTTP login requires local session and CSRF header; OAuth callback needs correct state and exports exclude credentials',async t=>{
  const {dir,plan}=setup(t);const {server}=createApp({dataDir:dir,providers:{chatgptPlan:plan}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const base=`http://127.0.0.1:${server.address().port}`;const page=await fetch(base);const cookie=page.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/chatgpt/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/chatgpt/login',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  const login=await(await fetch(base+'/api/chatgpt/login',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Local-Request':'1'},body:'{}'})).json();assert.equal(new URL(login.url).origin,'https://auth.openai.com');
  const callback=await fetch(base+'/auth/callback?state=wrong&code=do-not-echo');assert.match(await callback.text(),/不匹配/);assert.equal(plan.status().signedIn,false);
  authorizeFixture(plan);for(const route of ['/api/state','/api/export','/api/roles/export'])assert.ok(!(await(await fetch(base+route,{headers:{cookie}})).text()).includes('access-secret'));
});
