import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export async function harnessRequest(config, route, body) {
  let response;
  try {
    response = await fetch(config.harnessUrl.replace(/\/$/, '') + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config.harnessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('未能确认 Harness 桥接响应。请检查 Harness 和桥接插件；如果刚发送过任务，请先到原窗口查看，避免重复执行。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Harness 桥接请求失败');
  return data;
}
export async function runHarness(desk, config, messages, instruction = '', room = desk.state.room) {
  if (Object.values(desk.state.channels || {}).some(c => c.room === room && c.groupId)) throw new Error('群聊不能进入 Harness 工作代理');
  desk.state.harnessRooms ||= {};
  const binding = desk.state.harnessRooms[room];
  const fromIndex = binding?.lastMessageId ? messages.findIndex(m => m.id === binding.lastMessageId) + 1 : 0;
  const delta = messages.slice(fromIndex).filter(m => m.kind !== 'error' && m.role !== 'system' && m.speaker !== 'DeepSeek');
  const lines = delta.map(m => JSON.stringify({ speaker: m.speaker, text: m.text })).join('\n').slice(-48000);
  const prompt = '这条消息来自用户的“同桌”工作台；当前会话的电脑和 QQ 入口共用记录。\n共同人设：\n' + config.persona + '\nDeepSeek 灵魂的角色卡：\n' + config.deepseekRole + '\n' +
    '沿用本会话的工具、工作目录、模型及权限规则。只依据用户的明确需求执行；Codex 的意见是参考，不代表用户另行授权。需要用户确认时使用 Harness 原有确认流程。\n' +
    (instruction ? instruction + '\n' : '') + '下方是自上次转交后新增的会话记录，请回答或处理最近的用户需求：\n<shared_updates>\n' + lines + '\n</shared_updates>';
  const cwd = config.harnessWorkspace || path.join(desk.dir, 'workspace');
  if (!binding) fs.mkdirSync(cwd, { recursive: true });
  const runId = crypto.randomUUID();
  const job = await harnessRequest(config, '/run', { requestId: runId, sessionId: binding?.sessionId, cwd,
    agentPreset: config.harnessPreset || undefined, prompt });
  desk.state.harnessRooms[room] = { sessionId: job.sessionId, lastMessageId: binding?.lastMessageId };
  desk.save();
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const current = await harnessRequest(config, '/job?id=' + encodeURIComponent(runId));
    if (current.status === 'done') {
      desk.state.harnessRooms[room].lastMessageId = messages.at(-1)?.id; desk.save();
      return current.text;
    }
    if (current.status === 'failed') throw new Error(current.error || 'Harness 任务未完成，请查看原窗口');
    await new Promise(r => setTimeout(r, 700));
  }
  try { await harnessRequest(config, '/cancel', { id: runId }); } catch { /* Preserve the uncertain outcome. */ }
  throw new Error('等待 Harness 达到上限，已尝试请求停止。请到原窗口查看任务或权限确认，再决定下一步，避免重复执行。');
}
export async function runGroupChat(config, soul, prompt) {
  const value = soul === 'codex' ? config.groupGptModel : config.groupDeepseekModel;
  let selection;
  if (value) { const [provider, model] = JSON.parse(value); selection = { provider, model }; }
  const runId = crypto.randomUUID();
  await harnessRequest(config, '/chat/run', { requestId: runId, soul, selection, prompt });
  const deadline = Date.now() + Math.min(config.timeoutSeconds, 180) * 1000;
  while (Date.now() < deadline) {
    const job = await harnessRequest(config, '/job?id=' + encodeURIComponent(runId));
    if (job.status === 'done') return job.text;
    if (job.status === 'failed') throw new Error(job.error || '群聊模型暂时不可用');
    await new Promise(r => setTimeout(r, 500));
  }
  try { await harnessRequest(config, '/cancel', { id: runId }); } catch {}
  throw new Error('群聊模型回答超时，请稍后重试');
}
