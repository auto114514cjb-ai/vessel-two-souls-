import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runCodexText } from '../codex-text.mjs';
import { validateConfig } from '../core.mjs';
function launch(script) {
  return (command,args,options) => { assert.equal(options.shell,false); return spawn(process.execPath,['-e',script],options); };
}
test('completed text returns while the CLI would otherwise remain running',async()=>{
  let child; const started=Date.now();
  const text=await runCodexText('unused',[],{input:'hello',timeout:2000},(c,a,o)=>{child=launch(`process.stdin.resume();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'文字回答'}}));console.log(JSON.stringify({type:'turn.completed'}));setInterval(()=>{},1000);`)(c,a,o);return child});
  assert.equal(text,'文字回答');assert.ok(Date.now()-started<1800);assert.equal(child.killed,true);
});
test('partial output and an explicit failure cannot be accepted as a completed answer',async()=>{
  await assert.rejects(runCodexText('unused',[],{input:'x',timeout:2000},launch(`console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'半截'}}));`)),/未完成/);
  await assert.rejects(runCodexText('unused',[],{input:'x',timeout:2000},launch(`console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'半截'}}));console.log(JSON.stringify({type:'turn.failed',error:{message:'network'}}));`)),/未完成/);
});
test('JSONL framing handles split UTF-8 and a final line without newline',async()=>{
  const script=`const b=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'中文🙂'}})+'\\n'+JSON.stringify({type:'turn.completed'}));process.stdout.write(b.subarray(0,77));setTimeout(()=>process.stdout.end(b.subarray(77)),10);`;
  assert.equal(await runCodexText('unused',[],{input:'x',timeout:2000},launch(script)),'中文🙂');
});
test('a hung invocation times out, and response speed choices are validated',async()=>{
  await assert.rejects(runCodexText('unused',[],{input:'x',timeout:100},launch('process.stdin.resume();setInterval(()=>{},1000)')),/超时/);
  assert.equal(validateConfig({}).codexReasoningEffort,'low');assert.equal(validateConfig({codexReasoningEffort:'high'}).codexReasoningEffort,'high');assert.throws(()=>validateConfig({codexReasoningEffort:'made-up'}),/回答速度/);
});
