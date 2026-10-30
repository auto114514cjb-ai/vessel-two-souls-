import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {Desk,DEFAULTS,validateConfig,parseInput,promptFor} from '../core.mjs';
import {runAgent,agentName} from '../agents.mjs';
import {createHarnessBridge} from '../harness-plugin.mjs';
import {createApp} from '../server.mjs';

const opinion=(name,keep=true)=>JSON.stringify({note:name+' 独立意见',treasure:{keep,title:'共同约定',summary:'用户希望记住今天的共同约定。',reason:name+' 认为这段约定值得长期保留。',tags:['约定']}});
const custom={agentRouting:'custom',deepseekAgentName:'小感',codexAgentName:'小理',deepseekAgentBackend:'chatgpt',codexAgentBackend:'chatgpt',deepseekAgentModel:'gpt-test',codexAgentModel:'gpt-test',deepseekRole:'CARD_A_ONLY',codexRole:'CARD_B_ONLY',innerDialogue:true,treasuresEnabled:true};
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'souls-agent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
const noWork={codex:async()=>{throw new Error('不能进入原工作代理')},deepseek:async()=>{throw new Error('不能进入原工作代理')}};
async function listen(t,server){await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));return `http://127.0.0.1:${server.address().port}`}

test('old configuration and histories retain legacy routing; custom setup validates identities and explicit model picks',t=>{
 const dir=temp(t);fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({defaultMode:'deepseek',deepseekKey:'local-test-key'}));
 const desk=new Desk(dir);assert.equal(desk.config.agentRouting,'legacy');assert.equal(desk.config.defaultMode,'deepseek');assert.equal(desk.config.deepseekKey,'local-test-key');
 assert.equal(validateConfig(custom).codexAgentModel,'gpt-test');
 for(const edit of [{codexAgentName:'小感'},{deepseekAgentName:'GPT'},{codexAgentName:'DeepSeek'},{deepseekAgentName:'<script>'},{codexAgentModel:''},{codexAgentBackend:'shell'},{codexAgentModel:'gpt-image-test'},{agentGroupRouting:true,codexAgentBackend:'codex'}])assert.throws(()=>validateConfig({...custom,...edit}));
 assert.throws(()=>validateConfig({...custom,deepseekAgentBackend:'harness',deepseekAgentModel:'../model'}));
});
test('custom names select stable agents while slash aliases override addresses and names are safely escaped',()=>{
 const c=validateConfig(custom);
 for(const [s,expected]of [['小感，你怎么看？','deepseek'],['【小理，你今天怎么样】','codex'],['你觉得怎么样，小理？','codex'],['/a 小理，你怎么看','deepseek'],['/b 小感，你怎么看','codex'],['/both 小理，你怎么看','both']])assert.equal(parseInput(s,'both',c).mode,expected);
 for(const s of ['小感 和 小理，你们怎么看','“小理，你怎么看”是什么意思','今天小理的意见不错'])assert.equal(parseInput(s,'both',c).mode,'both');
 assert.equal(parseInput('A+，你怎么看','both',validateConfig({...custom,deepseekAgentName:'A+'})).mode,'deepseek');
 assert.match(promptFor('Codex',c,[],''),/CARD_B_ONLY/);assert.doesNotMatch(promptFor('Codex',c,[],''),/CARD_A_ONLY/);
 assert.match(promptFor('DeepSeek',c,[],''),/CARD_A_ONLY/);assert.doesNotMatch(promptFor('DeepSeek',c,[],''),/CARD_B_ONLY/);
});
test('same ChatGPT model runs independent roles, final review sees both opinions, and treasure needs both votes',async t=>{
 const calls=[];const plan={status:()=>({signedIn:true,planEnabled:true}),chat:async(model,prompt)=>{
   calls.push({model,prompt});assert.equal(model,'gpt-test');
   const a=prompt.includes('CARD_A_ONLY');assert.notEqual(a,prompt.includes('CARD_B_ONLY'));
   if(prompt.includes('只返回 JSON')){assert.doesNotMatch(prompt,/小感 独立意见|小理 独立意见/);return opinion(a?'小感':'小理')}
   assert.match(prompt,/小感 独立意见/);assert.match(prompt,/小理 独立意见/);return '小理的整合答复';
 }};
 const desk=new Desk(temp(t),{...noWork,chatgptPlan:plan});desk.config=validateConfig(custom,desk.config);
 const job=desk.submit('小理，记住今天一起看星星的约定。','both');await desk.tail;
 assert.equal(job.status,'done');assert.equal(job.mode,'codex');assert.equal(calls.length,3);assert.equal(job.agentAssignments.deepseek.model,job.agentAssignments.codex.model);
 assert.deepEqual(job.innerDialogue.notes.map(n=>n.name),['小感','小理']);
 assert.equal(desk.state.messages.filter(m=>m.role==='assistant').length,1);assert.equal(desk.state.messages.at(-1).speaker,'小理');assert.equal(desk.state.messages.at(-1).agent,'codex');
 assert.ok(job.treasure);assert.match(desk.treasures.get('private',job.treasure.id).summary,/小感：/);assert.match(desk.shortcutReply({name:'help'}),/\/a 问题/);
 const restored=new Desk(desk.dir,{...noWork,chatgptPlan:plan});assert.equal(restored.config.deepseekAgentName,'DeepSeek'); // manual in-memory test config is not persisted
 desk.updateConfig({agentRouting:'legacy'});assert.equal(desk.state.messages.at(-1).speaker,'小理');assert.equal(desk.treasures.list('private').length,1);
});
test('each adapter receives an independent history object and group cannot dispatch Codex even if validation is bypassed',async()=>{
 const c=validateConfig({...custom,deepseekAgentBackend:'codex',codexAgentBackend:'codex'}),history=[{role:'user',text:'original'}],seen=[];
 const adapters={codex:async(spec,config,soul,h)=>{seen.push([spec.model,soul,h[0].text]);h[0].text='mutated';return soul}};
 await runAgent(c,'deepseek',history,'',false,adapters);await runAgent(c,'codex',history,'',false,adapters);
 assert.deepEqual(seen,[['gpt-test','deepseek','original'],['gpt-test','codex','original']]);assert.equal(history[0].text,'original');
 await assert.rejects(runAgent(c,'codex',history,'',true,adapters),/群聊不能/);assert.equal(seen.length,2);
});
test('same DeepSeek API model receives different role cards over HTTP and no tool instructions',async t=>{
 const calls=[];const api=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body),prompt=data.messages.at(-1).content;calls.push(data);assert.equal(data.model,'deepseek-test');assert.equal(data.tools,undefined);const a=prompt.includes('CARD_A_ONLY');const text=prompt.includes('只返回 JSON')?opinion(a?'小感':'小理'):'API 最终答复';res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:text}}]}))});
 const base=await listen(t,api),desk=new Desk(temp(t),noWork);desk.config=validateConfig({...custom,deepseekAgentBackend:'deepseek-api',codexAgentBackend:'deepseek-api',deepseekAgentModel:'deepseek-test',codexAgentModel:'deepseek-test',deepseekUrl:base,deepseekKey:'test-key'},desk.config);
 const job=desk.submit('小感，请和另一位讨论这个重要约定。','both');await desk.tail;
 assert.equal(job.status,'done');assert.equal(calls.length,3);assert.match(calls[0].messages.at(-1).content,/CARD_A_ONLY/);assert.doesNotMatch(calls[1].messages.at(-1).content,/CARD_A_ONLY/);
});
test('same Harness model is explicitly selected for both agents without creating Harness work sessions',async t=>{
 const calls=[];const ctx={sessionController:{modelCatalog:async()=>({groups:[{id:'one',name:'共享来源',models:[{id:'one-text-model',name:'共享模型'}]}]}),create:()=>{throw new Error('不应创建工作会话')},prompt:()=>{throw new Error('不应调用工作代理')}},llm:{stream:async function*(options){calls.push(options);const p=options.messages[0].content[0].text;yield {type:'text-delta',index:0,text:p.includes('只返回 JSON')?opinion(p.includes('CARD_A_ONLY')?'小感':'小理'):'Harness 最终答复'};yield {type:'finish',reason:{kind:'stop'}}}}};
 const bridge=createHarnessBridge(ctx,{token:'t'.repeat(64),port:0});await new Promise(r=>bridge.server.listen(0,'127.0.0.1',r));t.after(()=>bridge.close());
 const desk=new Desk(temp(t),noWork),model=JSON.stringify(['one','one-text-model']);desk.config=validateConfig({...custom,deepseekAgentBackend:'harness',codexAgentBackend:'harness',deepseekAgentModel:model,codexAgentModel:model,harnessUrl:`http://127.0.0.1:${bridge.server.address().port}`,harnessToken:'t'.repeat(64)},desk.config);
 const job=desk.submit('请讨论后给我一个方案。','team');await desk.tail;
 assert.equal(job.status,'done');assert.equal(calls.length,3);for(const c of calls){assert.deepEqual(c.tools,[]);assert.equal(c.sessionId,undefined)}assert.equal(desk.state.messages.at(-1).speaker,'小理');
});
test('QQ group uses the same text model only when opted in, and retains @ gating and memory isolation',async t=>{
 const calls=[],sent=[],desk=new Desk(temp(t),{...noWork,agentAdapters:{chatgpt:async(spec,c,s,h,i,group)=>{calls.push({spec,s,group,h});assert.ok(group);assert.ok(!h.some(m=>m.text.includes('PRIVATE_ONLY')));return i.includes('只返回 JSON')?opinion(agentName(c,s)):'群聊最终回复'}}});
 desk.config=validateConfig({...custom,agentGroupRouting:true,qqEnabled:true,ownerQQ:'12345',groupEnabled:true,allowedGroups:'55555'},desk.config);desk.ensureChannels();desk.add('你','PRIVATE_ONLY','user');desk.snow.sendGroup=async(id,text)=>sent.push(text);
 const event=mention=>({post_type:'message',message_type:'group',self_id:88888,user_id:23456,group_id:55555,message_id:mention?2:1,message:[...(mention?[{type:'at',data:{qq:'88888'}}]:[]),{type:'text',data:{text:'小理，请聊聊这个约定。'}}]});
 await desk.onQQ(event(false));assert.equal(calls.length,0);await desk.onQQ(event(true));await desk.tail;
 assert.equal(calls.length,3);assert.equal(sent.length,1);assert.match(sent[0],/【小理】/);assert.ok(!sent[0].includes('独立意见'));assert.equal(desk.treasures.list('private').length,0);assert.equal(desk.treasures.list('group:55555').length,1);
});
test('group can keep its original text routes while private agents use Codex',async t=>{
 let calls=0;const desk=new Desk(temp(t),{...noWork,agentAdapters:{codex:async()=>{throw new Error('群聊不能走 Codex')}},groupChat:async(c,s,p)=>{calls++;return p.includes('只返回 JSON')?opinion(s,false):'原群聊模型回复'}});
 desk.config=validateConfig({...custom,deepseekAgentBackend:'codex',codexAgentBackend:'codex',agentGroupRouting:false,allowedGroups:'55555'},desk.config);desk.ensureChannels();
 const job=desk.submit('小理，你怎么看？','both','电脑',null,null,{room:desk.state.channels['group:55555'].room});await desk.tail;assert.equal(job.status,'done');assert.equal(calls,3);assert.equal(job.agentAssignments,undefined);
});
test('agent failure is visible, never falls back to a work provider and prevents automatic treasure',async t=>{
 const desk=new Desk(temp(t),{...noWork,agentAdapters:{chatgpt:async(spec,c,s,h,i)=>{if(s==='deepseek')throw new Error('模型暂时不可用');return i.includes('只返回 JSON')?opinion('小理'):'仍可回答'}}});desk.config=validateConfig(custom,desk.config);
 const job=desk.submit('小理，请回应这个约定。','both');await desk.tail;assert.equal(job.status,'done');assert.equal(job.innerDialogue.status,'partial');assert.equal(job.treasure,undefined);assert.ok(desk.state.messages.some(m=>m.text.includes('小感 连接不可用')));
});
test('different custom providers keep explicit models and both final speakers retain their identities',async t=>{
 const seen=[],desk=new Desk(temp(t),{...noWork,agentAdapters:{harness:async(spec,c,s,h,i)=>{assert.equal(s,'deepseek');assert.equal(spec.model,JSON.stringify(['one','first-model']));seen.push('A');return i.includes('只返回 JSON')?opinion('小感',false):'A 最终答复'},chatgpt:async(spec,c,s,h,i)=>{assert.equal(s,'codex');assert.equal(spec.model,'second-model');seen.push('B');return i.includes('只返回 JSON')?opinion('小理',false):'B 最终答复'}}});
 desk.config=validateConfig({...custom,deepseekAgentBackend:'harness',deepseekAgentModel:JSON.stringify(['one','first-model']),codexAgentModel:'second-model'},desk.config);const job=desk.submit('请分别回应。','both');await desk.tail;
 assert.equal(job.status,'done');assert.deepEqual(seen.slice(0,2),['A','B']);assert.equal(seen.length,4);assert.deepEqual(new Set(desk.state.messages.filter(m=>m.role==='assistant').map(m=>m.speaker)),new Set(['小感','小理']));assert.equal(job.treasure,undefined);
});
test('HTTP settings persist same-model choices and keep credentials out of public state',async t=>{
 const dir=temp(t),{server,desk}=createApp({dataDir:dir});const base=await listen(t,server),cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
 const headers={cookie,'content-type':'application/json','x-local-request':'1'};
 const response=await fetch(base+'/api/settings',{method:'POST',headers,body:JSON.stringify({...custom,deepseekKey:'private-test-key'})});assert.equal(response.status,200);
 const state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();assert.equal(state.config.deepseekAgentModel,state.config.codexAgentModel);assert.equal(state.config.agentRouting,'custom');assert.ok(!JSON.stringify(state).includes('private-test-key'));
 const restored=new Desk(dir);assert.equal(restored.config.codexAgentName,'小理');assert.equal(restored.config.codexAgentModel,'gpt-test');assert.equal(restored.config.deepseekKey,'private-test-key');
 assert.equal((await fetch(base+'/api/models',{method:'POST',headers,body:JSON.stringify({agentBackends:['shell']})})).status,400);desk.snow.stop();
});
