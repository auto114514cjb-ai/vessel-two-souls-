import { spawn } from 'node:child_process';
import { codexEnvironment, resolveCodex } from './core.mjs';
import { harnessRequest } from './harness-client.mjs';
import { isChatModel } from './chat-policy.mjs';
import { AGENT_BACKENDS } from './agents.mjs';
export function codexModels(config, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(resolveCodex(config), ['app-server'], { env: codexEnvironment(), shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let buffer = '', done = false, nextId = 2; const all = [];
    const fail = () => finish(new Error('无法读取 Codex 模型列表，请从电脑正常启动程序并确认 Codex 登录'));
    const timer = setTimeout(fail, 15000);
    function finish(error) { if (done) return; done = true; clearTimeout(timer); child.kill(); if (error) reject(error); else resolve(all.map(m => ({ id: m.model || m.id, name: m.displayName || m.model || m.id })).filter(m => m.id)); }
    function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
    child.stdout.setEncoding('utf8'); child.stderr.resume(); child.stdin.on('error', fail); child.on('error', fail); child.on('close', () => { if (!done) fail(); });
    child.stdout.on('data', chunk => {
      buffer += chunk; if (buffer.length > 2000000) return fail(); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,index); buffer = buffer.slice(index+1); let packet; try { packet = JSON.parse(line); } catch { continue; }
        if (packet.error) return fail();
        if (packet.id === 1) { send({ method:'initialized' }); send({ id:nextId, method:'model/list', params:{ includeHidden:false } }); }
        else if (packet.id === nextId) { all.push(...(packet.result?.data || [])); if (packet.result?.nextCursor && all.length < 100) send({ id:++nextId, method:'model/list', params:{ cursor:packet.result.nextCursor, includeHidden:false } }); else finish(); }
      }
    });
    send({ id:1, method:'initialize', params:{ clientInfo:{ name:'shared_ai_desk', title:'同桌', version:'1.1.0' } } });
  });
}
export async function apiModels(config) {
  const key = process.env.DEEPSEEK_API_KEY || config.deepseekKey; if (!key) throw new Error('请先保存 DeepSeek API 密钥');
  const response = await fetch(config.deepseekUrl.replace(/\/$/,'')+'/models', { redirect:'error', signal:AbortSignal.timeout(12000), headers:{ Authorization:`Bearer ${key}` } });
  if (!response.ok) throw new Error('DeepSeek 模型列表读取失败，请检查已保存的密钥和接口');
  const data = await response.json(); return (data.data || []).filter(m => typeof m.id === 'string').map(m => ({ id:m.id, name:m.id }));
}
export async function discoverModels(config, chatgpt, requestedBackends = []) {
  if(!Array.isArray(requestedBackends)||requestedBackends.length>4||requestedBackends.some(b=>!AGENT_BACKENDS.includes(b)))throw new Error('Agent 接入来源不正确');
  const backends=new Set([...requestedBackends,...(config.agentRouting==='custom'?[config.deepseekAgentBackend,config.codexAgentBackend]:[])]);
  const r = await Promise.allSettled([harnessRequest(config,'/models'), config.gptBackend === 'chatgpt'&&!backends.has('codex') ? Promise.resolve([]) : codexModels(config), config.deepseekBackend === 'api'||backends.has('deepseek-api') ? apiModels(config) : Promise.resolve([]), chatgpt?.status().planEnabled ? chatgpt.models() : Promise.resolve([])]);
  const harness = r[0].status==='fulfilled' ? { ...r[0].value, groups:r[0].value.groups.map(g=>({...g,models:g.models.filter(isChatModel)})) } : null;
  return { harness, harnessError:r[0].status==='rejected'?r[0].reason.message:'', codex:r[1].status==='fulfilled'?r[1].value:[], codexError:r[1].status==='rejected'?r[1].reason.message:'', deepseekApi:r[2].status==='fulfilled'?r[2].value:[], deepseekApiError:r[2].status==='rejected'?r[2].reason.message:'', chatgpt:r[3].status==='fulfilled'?r[3].value:[], chatgptError:r[3].status==='rejected'?r[3].reason.message:'' };
}
