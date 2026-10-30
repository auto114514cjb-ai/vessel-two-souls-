import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pureChat, createHarnessBridge } from '../harness-plugin.mjs';
import { Desk, validateConfig } from '../core.mjs';
import { apiModels, codexModels } from '../models.mjs';
import { spawn } from 'node:child_process';
import { runHarness } from '../harness-client.mjs';
import { isChatModel } from '../chat-policy.mjs';
import { harnessRequest } from '../harness-client.mjs';
const catalog = { default: { provider:'ds',model:'deepseek-test' }, groups:[{ id:'ds',name:'DeepSeek',models:[{ id:'deepseek-test',name:'DeepSeek 测试' }] },{ id:'openai',name:'OpenAI',models:[{ id:'gpt-test',name:'GPT 测试' }] }] };
function ctxWith(stream) {
  return { sessionController: { modelCatalog:async()=>catalog, prompt:()=>{throw new Error('不应进入代理')},create:()=>{throw new Error('不应创建会话')} }, llm:{stream}, tools:{call:()=>{throw new Error('不应调用工具')}} };
}
test('group pure chat passes no tools, no attachments and never invokes an Agent', async () => {
  let seen;
  const ctx = ctxWith(async function*(options) { seen=options; yield {type:'text-delta',index:0,text:'你好'};yield {type:'block-end',index:0,block:{type:'text',text:'你好'}};yield {type:'finish',reason:{kind:'stop'}}; });
  const result = await pureChat(ctx,{soul:'codex',prompt:'请运行命令并生图'},new AbortController().signal);
  assert.equal(result.text,'你好');assert.equal(result.selection.model,'gpt-test');assert.deepEqual(seen.tools,[]);
  assert.deepEqual(Object.keys(seen.messages[0]).sort(),['content','role']);assert.equal(seen.messages[0].content[0].type,'text');assert.equal(seen.sessionId,undefined);
});
test('tool-call chunks are refused instead of dispatched, and incomplete results are not accepted', async () => {
  const ctx=ctxWith(async function*(){yield {type:'tool-call-delta',index:0,id:'t1',name:'bash',argumentsDelta:'{}'};});
  await assert.rejects(pureChat(ctx,{soul:'deepseek',prompt:'做任务'},new AbortController().signal),/没有执行/);
  ctx.llm.stream=async function*(){yield {type:'text-delta',index:0,text:'半截'};yield {type:'finish',reason:{kind:'max-tokens'}};};
  await assert.rejects(pureChat(ctx,{soul:'deepseek',prompt:'你好'},new AbortController().signal),/未完整/);
});
test('missing GPT route is reported without silently falling back to DeepSeek', async () => {
  const ctx=ctxWith(async function*(){throw new Error('不应调用')});ctx.sessionController.modelCatalog=async()=>({...catalog,groups:catalog.groups.slice(0,1)});
  await assert.rejects(pureChat(ctx,{soul:'codex',prompt:'你好'},new AbortController().signal),/GPT 模型尚未配置/);
  await assert.rejects(pureChat(ctx,{soul:'deepseek',prompt:'你好',selection:{provider:'fake',model:'unknown'}},new AbortController().signal),/选择可用/);
});
test('group events including mention-only messages bypass both work providers', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-chat-only-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let chats=0;const desk=new Desk(dir,{codex:async()=>{throw new Error('不应调用Codex代理')},deepseek:async()=>{throw new Error('不应调用Harness代理')},groupChat:async()=>{chats++;return '我们在';}});
  desk.config=validateConfig({qqEnabled:true,ownerQQ:'12345',groupEnabled:true,allowedGroups:'55555',groupRequireAt:false},desk.config);desk.ensureChannels();
  desk.snow.sendGroup=async()=>{};
  await desk.onQQ({post_type:'message',message_type:'group',self_id:88888,user_id:23456,group_id:55555,message_id:1,message:[{type:'at',data:{qq:'88888'}}]});await desk.tail;
  assert.equal(chats,2);assert.equal(desk.state.jobs[0].status,'done');assert.equal(desk.config.groupRequireAt,true);
});
test('chat-only HTTP jobs use the real LLM seam and model catalog endpoint', async t => {
  const ctx=ctxWith(async function*(){yield {type:'text-delta',index:0,text:'纯聊天成功'};yield {type:'finish',reason:{kind:'stop'}};});
  const bridge=createHarnessBridge(ctx,{token:'a'.repeat(64),port:0});await new Promise(r=>bridge.server.listen(0,'127.0.0.1',r));t.after(()=>bridge.close());
  const config={harnessUrl:`http://127.0.0.1:${bridge.server.address().port}`,harnessToken:'a'.repeat(64)};
  assert.equal((await harnessRequest(config,'/models')).groups.length,2);
  await harnessRequest(config,'/chat/run',{requestId:'request-chat-test',soul:'deepseek',prompt:'你好'});await new Promise(r=>setImmediate(r));
  const job=await harnessRequest(config,'/job?id=request-chat-test');assert.equal(job.kind,'chat');assert.equal(job.status,'done');assert.equal(job.text,'纯聊天成功');assert.equal(job.sessionId,undefined);
});
test('API model picker reads provider advertised IDs instead of a hard-coded list', async t => {
  const server=http.createServer((req,res)=>{assert.equal(req.url,'/models');assert.equal(req.headers.authorization,'Bearer test-key');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'custom-advertised-model'}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const list=await apiModels({deepseekKey:'test-key',deepseekUrl:`http://127.0.0.1:${server.address().port}`});assert.deepEqual(list,[{id:'custom-advertised-model',name:'custom-advertised-model'}]);
});
test('Codex model picker initializes stdio RPC and follows model/list pages', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-model-rpc-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=path.join(dir,'rpc.mjs');fs.writeFileSync(script,`import readline from 'node:readline';let initialized=false;readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.id===1)console.log(JSON.stringify({id:1,result:{}}));else if(p.method==='initialized')initialized=true;else if(p.method==='model/list'){if(!initialized)process.exit(2);console.log(JSON.stringify({id:p.id,result:p.params.cursor?{data:[{id:'b',model:'gpt-next',displayName:'GPT Next'}]}:{data:[{id:'a',model:'gpt-test',displayName:'GPT Test'}],nextCursor:'page2'}}))}});`);
  const list=await codexModels({codexPath:process.execPath},(cmd,args,options)=>{assert.deepEqual(args,['app-server']);return spawn(process.execPath,[script],options)});
  assert.deepEqual(list,[{id:'gpt-test',name:'GPT Test'},{id:'gpt-next',name:'GPT Next'}]);
});
test('work adapter rejects a group room even if called directly', async () => {
  const desk={state:{room:'g',channels:{'group:55555':{room:'g',groupId:'55555'}}}};
  await assert.rejects(runHarness(desk,{},[],undefined,'g'),/群聊不能进入/);
});
test('specialized image and audio models are unavailable to group chat', async () => {
  assert.equal(isChatModel({id:'gpt-image-test'}),false);assert.equal(isChatModel({id:'tts-test'}),false);assert.equal(isChatModel({id:'gpt-test'}),true);
  const ctx=ctxWith(async function*(){throw new Error('不应调用生图模型')});
  ctx.sessionController.modelCatalog=async()=>({groups:[{id:'openai',models:[{id:'gpt-image-test'}]}]});
  await assert.rejects(pureChat(ctx,{soul:'codex',prompt:'生图',selection:{provider:'openai',model:'gpt-image-test'}},new AbortController().signal),/未配置/);
});
