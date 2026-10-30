import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Desk, validateConfig, recentHistory } from '../core.mjs';
import { TreasureBox } from '../treasures.mjs';
import { discuss, parseOpinion } from '../inner-dialogue.mjs';
import { createApp } from '../server.mjs';
const opinion=(soul,keep=true)=>JSON.stringify({note:soul+' 的可展示角色意见',treasure:{keep,title:'一起约定看蓝色星星',summary:soul+'：用户说以后想一起看星星。',reason:soul+'：共同约定具有长期意义。',tags:['约定','星星']}});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-treasure-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
function messages(id='user-1',text='我喜欢蓝色，也想和你们一起看星星。') {
 return [{id,role:'user',speaker:'你',text,at:'2026-10-30T13:00:00.000Z'},{id:id+'-a',role:'assistant',speaker:'DeepSeek',text:'我们记住这个约定。',at:'2026-10-30T13:00:01.000Z'}];
}
test('selecting either soul still discusses with both models, then publishes only the selected final answer',async t=>{
 for(const mode of ['deepseek','codex']){
  const calls=[],dir=temp(t);const desk=new Desk(dir,{innerChat:async(c,s,h,i)=>{calls.push('inner:'+s);return opinion(s)},deepseek:async(c,h,i)=>{calls.push('final:deepseek');assert.match(i,/角色讨论/);return 'DeepSeek 最终回答'},codex:async(c,h,i)=>{calls.push('final:codex');assert.match(i,/角色讨论/);return 'GPT 最终回答'}});
  desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);const job=desk.submit('以后我们一起看星星，好吗？',mode);await desk.tail;
  assert.deepEqual(calls,['inner:deepseek','inner:codex','final:'+mode]);assert.equal(job.status,'done');assert.equal(job.innerDialogue.notes.length,2);assert.ok(job.treasure);
  assert.equal(desk.state.messages.filter(m=>m.role==='assistant').length,1);assert.ok(!desk.state.messages.some(m=>m.text.includes('可展示角色意见')));
  assert.equal(desk.treasures.list('private').length,1);assert.match(desk.treasures.get('private',job.treasure.id).messages.at(-1).text,/最终回答/);
 }
});
test('the second soul sees the first role statement, but not its treasure vote or reason',async()=>{
 let second;
 await discuss({history:messages(),criteria:'重要约定',ask:async(s,h,i)=>{if(s==='codex')second=i;const d=JSON.parse(opinion(s));d.treasure.reason='PRIVATE_JUDGE_'+s;return JSON.stringify(d)}});
 assert.match(second,/deepseek 的可展示角色意见/);assert.ok(!second.includes('PRIVATE_JUDGE_deepseek'));
});
test('one negative vote, malformed JSON or an unavailable participant cannot create automatic treasure',async t=>{
 for(const scenario of ['negative','malformed','offline']){
  const desk=new Desk(temp(t),{innerChat:async(c,s)=>{if(s==='codex'){if(scenario==='offline')throw new Error('测试连接失败');if(scenario==='malformed')return '不是结构化意见';return opinion(s,false)}return opinion(s)},deepseek:async()=> '仍可由 DeepSeek 回答'});
  desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);const job=desk.submit('我们约定一起看星星','deepseek');await desk.tail;
  assert.equal(job.status,'done');assert.equal(desk.treasures.list('private').length,0);assert.equal(job.treasure,undefined);
  if(scenario==='offline'){assert.equal(job.innerDialogue.status,'partial');assert.ok(desk.state.messages.some(m=>m.text.includes('未完整完成')))}
 }
 assert.equal(parseOpinion('{"note":"一条意见","treasure":{"keep":"true"}}').treasure.keep,false);
});
test('treasure original text is persistent, searchable and safely named; credentials are redacted',t=>{
 const root=path.join(temp(t),'宝箱'),box=new TreasureBox(root);
 const t1=box.save({scope:'private',messages:messages('a','我喜欢蓝色。accessToken: test-very-long-token-value'),title:'../../我们的:约定?',summary:'蓝色星星',tags:['星星'],decision:'manual'});
 const files=fs.readdirSync(path.join(root,'私聊'));assert.equal(files.length,2);assert.ok(files.every(f=>f.startsWith('【宝藏】')));assert.ok(files.some(f=>f.endsWith('.md')));
 assert.ok(!fs.readFileSync(path.join(root,'私聊',files.find(f=>f.endsWith('.md'))),'utf8').includes('test-very-long-token-value'));
 const again=new TreasureBox(root);assert.equal(again.list('private','蓝色').length,1);assert.equal(again.get('private',t1.id).messages[0].id,'a');assert.match(again.get('private',t1.id).messages[0].text,/已隐藏/);
 assert.equal(again.save({scope:'private',messages:messages('a'),title:'重复珍藏'}).id,t1.id);assert.equal(again.list('private').length,1);
});
test('retrieval and archive preserve private/group boundaries and a strict context budget',t=>{
 const box=new TreasureBox(path.join(temp(t),'宝箱'));
 const p=box.save({scope:'private',messages:messages('p','PRIVATE_ONLY 蓝色星星'),title:'私人星星',summary:'PRIVATE_ONLY'});
 const g=box.save({scope:'group:55555',messages:messages('g','GROUP_ONLY 蓝色星星'),title:'群里的星星',summary:'GROUP_ONLY'});
 assert.match(box.recall('private','蓝色星星').text,/PRIVATE_ONLY/);assert.ok(!box.recall('private','蓝色星星').text.includes('GROUP_ONLY'));
 assert.match(box.recall('group:55555','蓝色星星').text,/GROUP_ONLY/);assert.ok(!box.recall('group:55555','蓝色星星').text.includes('PRIVATE_ONLY'));assert.equal(box.recall('group:66666','以前的蓝色星星').text,'');
 assert.throws(()=>box.get('group:55555',p.id),/未找到/);assert.ok(box.recall('private','蓝色星星',40).text.length<=40);
 box.archive('private',p.id,true);assert.equal(box.list('private').length,0);assert.equal(box.list('private','',true).length,1);assert.equal(box.recall('private','蓝色星星').text,'');
 box.archive('private',p.id,false);assert.equal(box.list('private').length,1);assert.equal(box.get('group:55555',g.id).scope,'group:55555');assert.throws(()=>box.list('../../private'),/不正确/);
});
test('automatic duplicates share one treasure and never overwrite the original evidence',t=>{
 const box=new TreasureBox(path.join(temp(t),'宝箱')),fields={scope:'private',title:'约定',summary:'一起看星星',decision:'both',reasons:[{soul:'deepseek',text:'有意义'},{soul:'codex',text:'有意义'}]};
 const first=box.save({...fields,messages:messages('first')}),again=box.save({...fields,messages:messages('later')});assert.equal(again.id,first.id);assert.equal(again.alreadySaved,true);assert.equal(box.list('private').length,1);assert.equal(box.get('private',first.id).messages[0].id,'first');
});
test('restarting a conversation retains treasures and injects relevant dated originals into future discussion',async t=>{
 const dir=temp(t),seen=[];const desk=new Desk(dir,{innerChat:async(c,s,h,i)=>{seen.push(i);return opinion(s,false)},deepseek:async(c,h,i)=>{seen.push(i);return '我记得你喜欢蓝色。'}});
 desk.submit('我喜欢蓝色','deepseek');await desk.tail;const saved=desk.saveCurrentTreasure({title:'喜欢蓝色',summary:'用户说喜欢蓝色'});desk.newRoom();
 desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);const job=desk.submit('还记得我喜欢什么颜色吗？','deepseek');await desk.tail;
 assert.equal(desk.treasures.list('private').length,1);assert.ok(seen.slice(-3).every(i=>i.includes('treasure_memories')&&i.includes('喜欢蓝色')));assert.equal(job.recalledTreasures[0].id,saved.id);
 const fresh=new Desk(dir,{deepseek:async()=> 'x'});assert.equal(fresh.treasures.list('private').length,1);
});
test('group discussions and final replies use only the chat seam and send no internal notes to QQ',async t=>{
 const calls=[],sent=[];const desk=new Desk(temp(t),{groupChat:async(c,s,p)=>{calls.push({s,p});return p.includes('只返回 JSON')?opinion(s):'群聊最终文本'},codex:async()=>{throw new Error('不应进入工作代理')},deepseek:async()=>{throw new Error('不应进入工作代理')}});
 desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true,qqEnabled:true,groupEnabled:true,ownerQQ:'12345',allowedGroups:'55555'},desk.config);desk.ensureChannels();desk.snow.sendGroup=async(id,text)=>sent.push(text);
 desk.selectChannel('group:55555');const job=desk.submitComputer('约定一起看星星','codex',true);await desk.tail;
 assert.equal(job.status,'done');assert.equal(calls.length,3);assert.deepEqual(calls.map(c=>c.s),['deepseek','codex','codex']);assert.equal(sent.length,1);assert.ok(sent[0].includes('群聊最终文本'));assert.ok(!sent[0].includes('可展示角色意见'));assert.equal(desk.treasures.list('private').length,0);assert.equal(desk.treasures.list('group:55555').length,1);
});
test('recent context is bounded without deleting persisted history, and unrelated treasures are not recalled',t=>{
 const source=[...messages('old','x'.repeat(8000)),...messages('new','最新消息')];const before=JSON.stringify(source);const limited=recentHistory(source,4000);assert.ok(limited.map(m=>m.text).join('').length<=4000);assert.ok(limited.some(m=>m.id==='new'));assert.equal(JSON.stringify(source),before);
 const box=new TreasureBox(path.join(temp(t),'宝箱'));box.save({scope:'private',messages:messages(),title:'蓝色星星'});assert.equal(box.recall('private','请解释量子计算').used.length,0);
});
test('memory storage failure does not lose the final reply or create a false treasure marker',async t=>{
 const desk=new Desk(temp(t),{innerChat:async(c,s)=>opinion(s),deepseek:async()=> '真实最终回复'});desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);desk.treasures.save=()=>{throw new Error('磁盘不可写')};const job=desk.submit('重要约定','deepseek');await desk.tail;assert.equal(job.status,'done');assert.equal(job.treasure,undefined);assert.match(job.treasureError,/磁盘不可写/);assert.equal(desk.state.messages.at(-1).text,'真实最终回复');
});
test('treasure API requires a local session and does not allow unconfigured group access',async t=>{
 const dir=temp(t),{desk,server}=createApp({dataDir:dir,providers:{deepseek:async()=> '我们记住了'}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
 const base='http://127.0.0.1:'+server.address().port,page=await fetch(base),cookie=page.headers.get('set-cookie').split(';')[0];desk.submit('我喜欢蓝色','deepseek');await desk.tail;
 assert.equal((await fetch(base+'/api/treasures')).status,401);
 const post=body=>fetch(base+'/api/treasures/save',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Local-Request':'1'},body:JSON.stringify(body)});
 const saved=await(await post({title:'蓝色',channelKey:'private'})).json();assert.ok(saved.id);
 const list=await(await fetch(base+'/api/treasures?channel=private',{headers:{cookie}})).json();assert.equal(list.items.length,1);assert.equal(list.items[0].messages,undefined);
 assert.equal((await fetch(base+'/api/treasures?channel=group:55555',{headers:{cookie}})).status,400);
 assert.equal((await fetch(base+'/api/treasure?channel=group:55555&id='+saved.id,{headers:{cookie}})).status,400);
});
