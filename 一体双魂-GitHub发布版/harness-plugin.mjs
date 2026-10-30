// Local-only DSH host plugin. It uses the existing Session Controller and never
// changes a permission preset, answers an approval, or reads model credentials.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isChatModel } from './chat-policy.mjs';

export const name = 'shared-ai-desk-harness-bridge';
export const inject = ['sessionController', 'agents', 'sessions', 'llm'];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function finalAnswer(events, requestId) {
  const entered = events.findIndex(e => e.type === 'user/message' && e.data?.source?.rpcId === requestId);
  if (entered < 0) throw new Error('Harness 尚未处理这条消息，请到原窗口查看');
  const endIndex = events.findIndex((e, i) => i > entered && e.type === 'turn/end');
  if (endIndex < 0) throw new Error('Harness 任务尚未结束，请到原窗口查看');
  const interval = events.slice(entered, endIndex + 1);
  const reason = interval.at(-1).data?.reason;
  if ((typeof reason === 'string' ? reason : reason?.kind) !== 'completed') throw new Error('Harness 任务未正常完成，请到原窗口查看错误或确认请求');
  const answer = interval.filter(e => e.type === 'assistant/message' && !e.data?.interrupted).map(e => textOf(e.data?.message?.content)).filter(Boolean).at(-1);
  if (!answer) throw new Error('Harness 没有返回最终文字，请到原窗口查看工具产出');
  return answer;
}
export async function pureChat(ctx, body, signal) {
  if (typeof body.prompt !== 'string' || body.prompt.length > 100000 || !body.prompt.trim()) throw new Error('群聊内容不能为空或过长');
  const catalog = await ctx.sessionController.modelCatalog();
  let selection = body.selection;
  const entries = catalog.groups.flatMap(g => g.models.filter(isChatModel).map(m => ({ provider: g.id, model: m.id })));
  if (!selection) {
    const pattern = body.soul === 'codex' ? /gpt|openai|chatgpt|^o[1-9]/i : /deepseek/i;
    selection = entries.find(x => pattern.test(x.model) || pattern.test(x.provider));
  }
  if (!selection || !entries.some(x => x.provider === selection.provider && x.model === selection.model)) throw new Error(body.soul === 'codex' ? '群聊 GPT 模型尚未配置，请在 Harness 添加可用 GPT 模型后，在工作台下拉选择。群聊不会调用 Codex 工具代理。' : '请在工作台选择可用的群聊模型');
  const blocks = new Map(); let finished = false;
  // Deliberately call only the LLM seam: no Agent, Session, tools registry,
  // filesystem, image generation, shell, or approval path is reachable here.
  for await (const chunk of ctx.llm.stream({ ...selection,
    system: '你在 QQ 群中仅提供基础文字聊天。没有任何工具，不接收附件，不执行工作。遇到写代码、生图、文件处理或执行任务的要求，说明需要主人到私聊或电脑工作台处理。',
    messages: [{ role: 'user', content: [{ type: 'text', text: body.prompt }] }], tools: [], maxTokens: 4096, signal })) {
    if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') throw new Error('群聊已禁用工具，该工具请求没有执行');
    if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) || '') + chunk.text);
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.set(chunk.index, chunk.block.text);
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind !== 'stop') throw new Error('群聊模型未完整返回文字，请稍后重试');
      finished = true;
    }
  }
  const text = [...blocks.entries()].sort((a,b) => a[0]-b[0]).map(x => x[1]).join('').trim();
  if (!finished || !text) throw new Error('群聊模型没有返回完整文字');
  return { text, selection };
}
export function createHarnessBridge(ctx, { token, port = 17861, stateFile } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('同桌桥接需要至少 32 字符的独立令牌');
  const jobs = new Map();
  let admissionTail = Promise.resolve();
  const chatControllers = new Map();
  if (stateFile && fs.existsSync(stateFile)) {
    for (const j of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) {
      if (j.status === 'running') { j.status = 'failed'; j.error = '桥接插件曾重新载入；请先在 Harness 查看原任务，不要重复执行'; }
      jobs.set(j.id, j);
    }
  }
  function persist() {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true }); const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...jobs.values()]), { mode: 0o600 }); fs.renameSync(tmp, stateFile);
  }
  async function resolveAgent(id) {
    const result = await ctx.sessionController.resolveAgent(id);
    if (!result || 'error' in result) throw new Error('无法打开 Harness 会话，请在原窗口检查它是否已归档或正在迁移');
    return result.agent;
  }
  async function start(body) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId || '')) throw new Error('无效的请求编号');
    if (jobs.has(body.requestId)) return jobs.get(body.requestId);
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 100000) throw new Error('任务内容不能为空，且不能超过 100000 字符');
    if ([...jobs.values()].some(j => j.status === 'running')) throw new Error('已有工作台任务在 Harness 运行，请等待它完成');
    let sessionId = body.sessionId;
    if (!sessionId) {
      if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd) || !fs.statSync(body.cwd).isDirectory()) throw new Error('请选择有效的 Harness 工作文件夹');
      const created = await ctx.sessionController.create({ cwd: body.cwd, ...(body.agentPreset ? { agentPreset: body.agentPreset } : {}) });
      sessionId = created.sessionId;
    }
    const agent = await resolveAgent(sessionId);
    if (agent.status === 'running') throw new Error('这个 Harness 会话正在处理其他任务，请等它完成后再发');
    const job = { id: body.requestId, sessionId, status: 'running', startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    for (const [id, j] of jobs) if (jobs.size > 100 && j.status !== 'running') jobs.delete(id);
    persist();
    try {
      await ctx.sessionController.prompt({ sessionId, requestId: body.requestId, mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: body.prompt }] }, new AbortController().signal);
      // Existing DSH tools and approval UI own execution and all permission decisions.
      Promise.resolve(agent.whenIdle()).then(async () => {
        job.text = finalAnswer(agent.session.snapshotEvents(), body.requestId); job.status = 'done';
      }).catch(() => { job.status = 'failed'; job.error = 'Harness 任务未完成，请在原窗口查看错误、权限确认或任务结果'; }).finally(persist);
    } catch { job.status = 'failed'; job.error = 'Harness 未接受任务，请在原窗口检查模型和会话'; persist(); }
    return job;
  }
  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    // No browser origin is trusted here. The desktop backend calls with an independent bearer.
    if (req.headers.origin || !safeEqual(String(req.headers.authorization || ''), `Bearer ${token}`)) return send(res, 403, { error: '桥接认证失败' });
    const validHosts = [`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
    if (!validHosts.includes(req.headers.host)) return send(res, 403, { error: '只接受本机请求' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: name, protocol: 2, dataDirectory:stateFile?path.dirname(stateFile):null });
      if (req.method === 'GET' && url.pathname === '/models') return send(res, 200, await ctx.sessionController.modelCatalog());
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const { items } = await ctx.sessionController.list({}, new AbortController().signal);
        return send(res, 200, { items: items.filter(s => s.origin !== 'subagent' && !s.parentSessionId).map(s => ({ sessionId: s.sessionId, cwd: s.cwd || '', running: !!s.running,
          title: s.projections?.values?.title || s.cwd?.split(/[\\/]/).at(-1) || s.sessionId })) });
      }
      if (req.method === 'GET' && url.pathname === '/job') {
        const job = jobs.get(url.searchParams.get('id')); return send(res, job ? 200 : 404, job || { error: '未找到任务，请在 Harness 检查，避免重复执行' });
      }
      if (req.method === 'GET' && url.pathname === '/history') {
        const id = url.searchParams.get('sessionId'); if (!id || id.length > 200) throw new Error('会话编号不正确');
        // Read the current derived message surface, excluding tool output and reasoning.
        const agent = await resolveAgent(id);
        const messages = agent.session.deriveMessages().filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ speaker: m.role === 'user' ? '你' : 'DeepSeek', role: m.role, text: textOf(m.content) })).filter(m => m.text).slice(-200);
        return send(res, 200, { sessionId: id, messages });
      }
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return send(res, 404, { error: '未找到操作' });
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 450000) throw new Error('任务过长'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/chat/run') {
        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId || '') || !['codex','deepseek'].includes(body.soul)) throw new Error('群聊请求格式不正确');
        if (jobs.has(body.requestId)) return send(res, 202, jobs.get(body.requestId));
        if (chatControllers.size >= 4) throw new Error('群聊请求较多，请稍后再发');
        const controller = new AbortController(); chatControllers.set(body.requestId, controller);
        const timer = setTimeout(() => controller.abort(), 180000);
        const job = { id: body.requestId, kind: 'chat', status: 'running' }; jobs.set(job.id, job); persist();
        for (const [id, saved] of jobs) if (jobs.size > 100 && saved.status !== 'running') jobs.delete(id);
        pureChat(ctx, body, controller.signal).then(result => { Object.assign(job, result, { status: 'done' }); })
          .catch(error => { job.status = 'failed'; job.error = error.message; })
          .finally(() => { clearTimeout(timer); chatControllers.delete(job.id); persist(); });
        return send(res, 202, job);
      }
      if (url.pathname === '/run') {
        const admitted = admissionTail.then(() => start(body));
        admissionTail = admitted.catch(() => {});
        return send(res, 202, await admitted);
      }
      if (url.pathname === '/cancel') {
        const job = jobs.get(body.id);
        if (!job || job.status !== 'running') throw new Error('没有可停止的工作台任务');
        if (job.kind === 'chat') { chatControllers.get(job.id)?.abort(); return send(res, 200, { ok: true }); }
        ctx.sessionController.cancel({ sessionId: job.sessionId }); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: '未找到操作' });
    } catch (error) { return send(res, 400, { error: error.message || 'Harness 操作失败' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, jobs, port, close: () => { for (const c of chatControllers.values()) c.abort(); server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}
export function apply(ctx, config) {
  const saved = JSON.parse(fs.readFileSync(config.configFile, 'utf8'));
  const bridge = createHarnessBridge(ctx, { token: saved.harnessToken, port: Number(new URL(saved.harnessUrl).port || 17861), stateFile: path.join(path.dirname(config.configFile), 'harness-jobs.json') });
  bridge.server.on('error', error => ctx.logger?.error(`同桌桥接无法启动：${error.code || '本地端口不可用'}`));
  ctx.effect(() => { bridge.server.listen(bridge.port, '127.0.0.1'); return () => bridge.close(); });
}
