import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Desk,validateConfig,parseInput,transcript} from '../core.mjs';
function fixture(t,providers={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-shortcut-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const desk=new Desk(dir,{codex:async()=>{throw new Error('不应调用模型')},deepseek:async()=>{throw new Error('不应调用模型')},...providers});desk.config=validateConfig({qqEnabled:true,ownerQQ:'12345',allowedGroups:'55555',groupEnabled:true},desk.config);desk.ensureChannels();return desk}
const event=(text,id=1,extra={})=>({post_type:'message',message_type:'private',self_id:88888,user_id:12345,message_id:id,message:[{type:'text',data:{text}}],...extra});
test('QQ private help lists real commands without an LLM and ignores duplicate and non-owner events',async t=>{
 const desk=fixture(t),sent=[];desk.snow.send=async(to,text)=>sent.push({to,text});
 await desk.onQQ(event(' /HELP '));assert.equal(sent.length,1);assert.match(sent[0].text,/\/gpt/);assert.match(sent[0].text,/\/treasure/);assert.match(sent[0].text,/\/status/);assert.equal(desk.state.jobs.length,0);
 await desk.onQQ(event('/help'));await desk.onQQ(event('/help',2,{user_id:23456}));assert.equal(sent.length,1);
});
test('computer private help is immediate and the receipt does not pollute model context',t=>{
 const desk=fixture(t);const result=desk.submitComputer('/help','codex');assert.equal(result.kind,'shortcut');assert.equal(desk.active,0);assert.equal(desk.state.jobs.length,0);assert.match(desk.state.messages.at(-1).text,/快捷指令/);assert.equal(transcript(desk.state.messages),'');
 assert.deepEqual(parseInput('/GPT 第一行\n第二行','both'),{mode:'codex',text:'第一行\n第二行'});
});
test('private treasure shortcut stores the conversation once and new keeps its original evidence',async t=>{
 const desk=fixture(t,{deepseek:async()=> '我记住这个约定。'}),sent=[];desk.snow.send=async(to,text)=>sent.push(text);
 desk.submit('一起看星星吧','deepseek');await desk.tail;
 await desk.onQQ(event('/treasure 星星约定',3));await desk.onQQ(event('/珍藏 星星约定',4));assert.equal(desk.treasures.list('private').length,1);assert.match(sent[0],/已手动珍藏/);assert.match(sent[1],/已经在宝箱/);
 const oldRoom=desk.state.channels.private.room;desk.submitComputer('/new','codex');assert.notEqual(desk.state.channels.private.room,oldRoom);assert.equal(desk.treasures.list('private').length,1);assert.equal(desk.state.messages.filter(m=>m.room===desk.state.room).length,0);
});
test('group help retains mention and owner rules, and private management commands do not operate on group memories',async t=>{
 const desk=fixture(t),sent=[];desk.snow.sendGroup=async(id,text)=>sent.push(text);
 const group=(text,id,mention=true)=>event(text,id,{message_type:'group',group_id:55555,user_id:23456,message:[...(mention?[{type:'at',data:{qq:'88888'}}]:[]),{type:'text',data:{text}}]});
 await desk.onQQ(group('/help',10,false));assert.equal(sent.length,0);await desk.onQQ(group('/help',11));assert.equal(sent.length,1);assert.ok(!sent[0].includes('/treasure'));assert.match(sent[0],/基础文字/);
 await desk.onQQ(group('/treasure 不该保存',12));assert.match(sent[1],/仅在主人私聊/);assert.equal(desk.treasures.list('group:55555').length,0);assert.equal(desk.state.jobs.length,0);
});
test('status reports both independent votes and automatic save outcomes',async t=>{
 let both=false;const opinion=s=>JSON.stringify({note:s+'的意见',treasure:{keep:s==='deepseek'||both,title:'共同约定',summary:'我们约定一起看星星',reason:'纪念这次约定',tags:['星星']}});
 const desk=fixture(t,{innerChat:async(c,s)=>opinion(s),deepseek:async()=> '最终答复'});desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);
 desk.submit('重要的共同约定','deepseek');await desk.tail;let status=desk.shortcutReply({name:'status'});assert.match(status,/AI 自主珍藏流程：已开启/);assert.match(status,/DeepSeek：建议珍藏/);assert.match(status,/GPT：本次不珍藏/);assert.match(status,/没有保存自动宝藏/);
 both=true;desk.submit('请记住这个约定','deepseek');await desk.tail;status=desk.shortcutReply({name:'status'});assert.match(status,/已自动珍藏/);assert.equal(desk.treasures.list('private').length,1);
});
test('invalid vote structure is visible and never presented as a valid negative vote',async t=>{
 const desk=fixture(t,{innerChat:async(c,s)=>s==='codex'?JSON.stringify({note:'只有意见，没有判断'}):JSON.stringify({note:'意见',treasure:{keep:true,summary:'约定',reason:'重要'}}),deepseek:async()=> '答复'});desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);
 desk.submit('约定','deepseek');await desk.tail;assert.match(desk.shortcutReply({name:'status'}),/GPT：判断格式无效/);assert.equal(desk.treasures.list('private').length,0);
});
test('an affirmative vote with a whitespace-only reason is incomplete and cannot save treasure',async t=>{
 const desk=fixture(t,{innerChat:async(c,s)=>JSON.stringify({note:'意见',treasure:{keep:true,summary:'共同约定',reason:s==='codex'?'   ':'值得纪念'}}),deepseek:async()=> '答复'});desk.config=validateConfig({innerDialogue:true,treasuresEnabled:true},desk.config);
 desk.submit('共同约定','deepseek');await desk.tail;assert.match(desk.shortcutReply({name:'status'}),/GPT：建议珍藏，但记录不完整/);assert.equal(desk.treasures.list('private').length,0);
});
