import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessBridge, finalAnswer } from '../harness-plugin.mjs';
import { installHarness } from '../install-harness.mjs';
import { Desk } from '../core.mjs';
import { harnessRequest } from '../harness-client.mjs';

const TOKEN = 'test-token-is-at-least-thirty-two-characters';
function temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-harness-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
async function fixture(t, { busy = false, blocked = false } = {}) {
  const dir = temp(t), events = [], calls = [], received = [];
  const agent = { status: busy ? 'running' : 'idle', session: { snapshotEvents: () => events,
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '原有任务背景' }] }, { role: 'assistant', content: [{ type: 'text', text: '已有工具分析结果' }] }] }, whenIdle: async () => {} };
  const ctx = { sessionController: {
    create: async request => { calls.push(['create', request]); return { sessionId: 'session-created' }; },
    list: async () => ({ items: [{ sessionId: 'session-existing', cwd: dir, projections: { values: { title: '原来的助手' } } }] }),
    resolveAgent: async id => { calls.push(['resolve', id]); return { agent }; },
    prompt: async request => {
      received.push(request); calls.push(['prompt', request]);
      events.push({ type: 'turn/start', data: { turn: received.length } },
        { type: 'user/message', data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Harness 使用原工具后的答复' }] } } },
        { type: 'turn/end', data: { reason: { kind: blocked ? 'blocked' : 'completed' } } });
    },
    cancel: async request => calls.push(['cancel', request]),
  } };
  const bridge = createHarnessBridge(ctx, { token: TOKEN, port: 0, stateFile: path.join(dir, 'jobs.json') });
  await new Promise(r => bridge.server.listen(0, '127.0.0.1', r)); t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const config = { harnessUrl: url, harnessToken: TOKEN };
  return { bridge, calls, received, dir, url, config, agent };
}
test('Harness bridge requires independent bearer, rejects browser origins, and lists existing sessions', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/health')).status, 403);
  assert.equal((await fetch(f.url + '/health', { headers: { authorization: 'Bearer ' + TOKEN, origin: 'http://evil.example' } })).status, 403);
  const health = await harnessRequest(f.config, '/health'); assert.equal(health.protocol, 2);
  const list = await harnessRequest(f.config, '/sessions'); assert.equal(list.items[0].title, '原来的助手');
  const history = await harnessRequest(f.config, '/history?sessionId=session-existing'); assert.equal(history.messages.length, 2); assert.equal(history.messages[1].speaker, 'DeepSeek');
});
test('Harness uses original Session Controller, correlates one request, and does not replay duplicates', async t => {
  const f = await fixture(t);
  const body = { requestId: 'request-12345', cwd: f.dir, prompt: '为我工作' };
  const first = await harnessRequest(f.config, '/run', body); await new Promise(r => setImmediate(r));
  const job = await harnessRequest(f.config, '/job?id=request-12345');
  assert.equal(first.sessionId, 'session-created'); assert.equal(job.status, 'done'); assert.match(job.text, /原工具/);
  await harnessRequest(f.config, '/run', body); assert.equal(f.received.length, 1);
  assert.deepEqual(f.received[0].content, [{ type: 'text', text: '为我工作' }]); assert.equal(f.received[0].mode, 'queue');
  assert.equal(f.calls.filter(c => /permission|approval/i.test(c[0])).length, 0);
});
test('Harness refuses to insert into another active task and does not call prompt', async t => {
  const f = await fixture(t, { busy: true });
  await assert.rejects(harnessRequest(f.config, '/run', { requestId: 'request-busy', sessionId: 'session-existing', prompt: '任务' }), /其他任务/);
  assert.equal(f.received.length, 0);
});
test('blocked or interrupted Harness task never masquerades as a completed result', async t => {
  const f = await fixture(t, { blocked: true });
  await harnessRequest(f.config, '/run', { requestId: 'request-blocked', sessionId: 'session-existing', prompt: '任务' });
  await new Promise(r => setImmediate(r));
  const job = await harnessRequest(f.config, '/job?id=request-blocked'); assert.equal(job.status, 'failed');
  assert.throws(() => finalAnswer([{ type: 'user/message', data: { source: { rpcId: 'id' } } }], 'id'), /尚未结束/);
});
test('Desk reuses Harness session and sends new Codex/user messages rather than the whole duplicated history', async t => {
  const f = await fixture(t); const desk = new Desk(path.join(f.dir, 'desk'), { codex: async () => 'Codex 审阅意见' });
  desk.config = { ...desk.config, ...f.config, harnessWorkspace: f.dir };
  desk.submit('第一个问题', 'team'); await desk.tail;
  desk.submit('继续执行', 'deepseek'); await desk.tail;
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.match(f.received[1].content[0].text, /Codex 审阅意见/); assert.match(f.received[1].content[0].text, /继续执行/);
  assert.doesNotMatch(f.received[1].content[0].text, /第一个问题/);
  assert.equal(desk.snapshot().harnessSessionId, 'session-created');
  assert.equal('harnessToken' in desk.publicConfig(), false);
});
test('linking an existing Harness session imports text for Codex, and requires a blank shared room', async t => {
  const f = await fixture(t); const desk = new Desk(path.join(f.dir, 'desk'));
  desk.config = { ...desk.config, ...f.config };
  await desk.linkHarness('session-existing'); assert.equal(desk.snapshot().messages.length, 2);
  assert.equal(desk.snapshot().harnessSessionId, 'session-existing');
  await assert.rejects(desk.linkHarness('session-existing'), /新会话/);
  desk.newRoom(); assert.equal(desk.snapshot().harnessSessionId, '');
});
test('installer preserves existing configuration and backup, is repeatable, and removes its own block', t => {
  const dir = temp(t), dshHome = path.join(dir, '.dsh'), profile = path.join(dshHome, 'profiles', 'desktop'), appRoot = path.join(dir, 'app');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{}');
  const file = path.join(profile, 'cordis.patch.yml'), original = '# existing\n- id: my-setting\n  config:\n    unchanged: true\n'; fs.writeFileSync(file, original);
  const first = installHarness({ dshHome, appRoot }); const once = fs.readFileSync(file, 'utf8');
  assert.match(once, /unchanged: true/); assert.match(once, /SHARED-AI-DESK/);
  assert.equal(fs.readFileSync(first.backup, 'utf8'), original);
  installHarness({ dshHome, appRoot }); assert.equal(fs.readFileSync(file, 'utf8'), once);
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'data', 'config.json'))); assert.equal(config.harnessToken.length, 64);
  installHarness({ dshHome, appRoot, remove: true }); assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SHARED-AI-DESK/); assert.match(fs.readFileSync(file, 'utf8'), /unchanged: true/);
});

test('relocation removes an old owned bridge insert and preserves unrelated plugin inserts', t => {
  const dir = temp(t), dshHome = path.join(dir, '.dsh'), profile = path.join(dshHome, 'profiles', 'desktop'), appRoot = path.join(dir, 'moved-app');
  fs.mkdirSync(profile, { recursive:true });fs.mkdirSync(appRoot,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),'{}');
  const file=path.join(profile,'cordis.patch.yml');
  fs.writeFileSync(file,'- insert:\n    - id: shared-ai-desk-bridge\n      name: file:///C:/old/harness-plugin.mjs\n      config:\n        configFile: C:/old/config.json\n\n# keep this\n- insert:\n    - id: unrelated\n      name: other-plugin\n');
  installHarness({dshHome,appRoot});const text=fs.readFileSync(file,'utf8');
  assert.equal((text.match(/id: shared-ai-desk-bridge/g)||[]).length,1);assert.doesNotMatch(text,/C:\/old/);assert.match(text,/id: unrelated/);assert.match(text,/# keep this/);assert.match(text,/moved-app/);
});
