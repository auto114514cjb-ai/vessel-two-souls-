import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Desk,parseInput,validateConfig} from '../core.mjs';
test('a clear leading address selects one speaker and preserves the original message',()=>{
 for(const [text,mode] of [['DEEPSEEK，你今天觉得怎么样','deepseek'],['【DEEPSEEK，你今天觉得怎么样】','deepseek'],['DeepSeek 你今天心情如何','deepseek'],['GPT，你今天怎么样？','codex'],['@GPT 帮我想一下','codex'],['ChatGPT：请谈谈你的看法','codex'],['你好，DeepSeek，你怎么看','deepseek'],['请问 GPT，你怎么看','codex'],['我想让 DeepSeek 回答这个问题','deepseek'],['Codex，你来回答吧','codex']])assert.deepEqual(parseInput(text,'both'),{mode,text});
});
test('quotations, model descriptions and references to both souls keep the selected mode',()=>{
 for(const text of ['今天 DeepSeek 的回答挺好','DeepSeek 和 GPT 有什么区别？','DeepSeek，GPT，你们好','GPT-6.1 有哪些功能？','DeepSeek 是什么？','“DeepSeek，你今天怎么样”这句话是什么意思','请翻译：GPT，你今天怎么样','比较 GPT 与 DeepSeek','DeepSeek今天发布了什么？'])assert.equal(parseInput(text,'both').mode,'both',text);
 assert.equal(parseInput('普通问题','codex').mode,'codex');
});
test('an unambiguous name at the end of a direct question also selects one speaker',()=>{
 assert.equal(parseInput('你今天觉得怎么样，DEEPSEEK？','both').mode,'deepseek');
 assert.equal(parseInput('请帮我看看这个想法，GPT','both').mode,'codex');
 assert.equal(parseInput('我正在比较 DeepSeek，GPT','both').mode,'both');
});
test('explicit slash commands override natural addresses and accept leading whitespace',()=>{
 assert.deepEqual(parseInput(' /both DeepSeek，你今天怎么样 ','codex'),{mode:'both',text:'DeepSeek，你今天怎么样'});
 assert.equal(parseInput('/gpt DeepSeek，你怎么看','both').mode,'codex');
 assert.equal(parseInput('/deepseek GPT，你怎么看','both').mode,'deepseek');
 assert.equal(parseInput('GPT，你觉得 DeepSeek 怎么样？','both').mode,'codex');
});
function createDesk(t,providers){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-address-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Desk(dir,providers)}
const opinion=s=>JSON.stringify({note:s+' 的内部角色发言',treasure:{keep:false}});
test('pointing to one soul still runs both internal participants and produces one final response',async t=>{
 for(const [text,expected] of [['DEEPSEEK，你今天觉得怎么样','deepseek'],['GPT，你来回答吧','codex']]){
  const calls=[];const desk=createDesk(t,{innerChat:async(c,s)=>{calls.push('inner:'+s);return opinion(s)},deepseek:async(c,h,i)=>{calls.push('final:deepseek');assert.match(i,/本次只由DeepSeek/);return 'DeepSeek 单独回答'},codex:async(c,h,i)=>{calls.push('final:codex');assert.match(i,/本次只由GPT/);return 'GPT 单独回答'}});
  desk.config=validateConfig({innerDialogue:true,defaultMode:'both'},desk.config);const job=desk.submitComputer(text,'both');await desk.tail;
  assert.equal(job.mode,expected);assert.equal(job.status,'done');assert.deepEqual(calls,['inner:deepseek','inner:codex','final:'+expected]);assert.equal(desk.state.messages.filter(m=>m.role==='assistant').length,1);assert.equal(desk.config.defaultMode,'both');
 }
});
test('QQ private natural address sends only the requested speaker',async t=>{
 const sent=[];const desk=createDesk(t,{deepseek:async()=> '指定的 DeepSeek 答复',codex:async()=>{throw new Error('不应生成 GPT 最终答复')}});desk.config=validateConfig({qqEnabled:true,ownerQQ:'12345'},desk.config);desk.snow.send=async(to,text)=>sent.push(text);
 await desk.onQQ({post_type:'message',message_type:'private',self_id:88888,user_id:12345,message_id:1,message:[{type:'text',data:{text:'DEEPSEEK，你今天觉得怎么样'}}]});await desk.tail;
 assert.equal(sent.length,1);assert.match(sent[0],/指定的 DeepSeek 答复/);assert.ok(!sent[0].includes('【GPT'));
});
test('an @bot group address preserves chat-only routing and one final speaker',async t=>{
 const calls=[],sent=[];const desk=createDesk(t,{groupChat:async(c,s,p)=>{calls.push(s);return p.includes('只返回 JSON')?opinion(s):'GPT 群聊答复'},deepseek:async()=>{throw new Error('不应进入工具代理')},codex:async()=>{throw new Error('不应进入工具代理')}});
 desk.config=validateConfig({innerDialogue:true,qqEnabled:true,ownerQQ:'12345',groupEnabled:true,allowedGroups:'55555'},desk.config);desk.ensureChannels();desk.snow.sendGroup=async(id,text)=>sent.push(text);
 await desk.onQQ({post_type:'message',message_type:'group',self_id:88888,user_id:23456,group_id:55555,message_id:1,message:[{type:'at',data:{qq:'88888'}},{type:'text',data:{text:' GPT，你今天怎么样？'}}]});await desk.tail;
 assert.deepEqual(calls,['deepseek','codex','codex']);assert.equal(sent.length,1);assert.match(sent[0],/GPT 群聊答复/);assert.equal(desk.state.jobs.at(-1).mode,'codex');
});
