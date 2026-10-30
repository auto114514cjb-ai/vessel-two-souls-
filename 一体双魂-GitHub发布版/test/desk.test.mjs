import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Desk, DEFAULTS, validateConfig, transcript, parseInput, messageText, SnowClient, deepseek, runProcess } from '../core.mjs';
import { createApp } from '../server.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-desk-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function fixtures(t, providers = {}) {
  return new Desk(temp(t), { codex: async () => 'Codex 答复', deepseek: async () => 'DeepSeek 答复', ...providers });
}
function event(text, extra = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 88888, user_id: 12345, message_id: 10,
    message: [{ type: 'text', data: { text } }], ...extra };
}
test('configuration refuses invalid owners, unsafe schemes, and remote cleartext', () => {
  assert.throws(() => validateConfig({ qqEnabled: true }), /QQ/);
  assert.throws(() => validateConfig({ snowUrl: 'file:///secret' }));
  assert.throws(() => validateConfig({ deepseekUrl: 'http://remote.example' }), /HTTPS/);
  assert.throws(() => validateConfig({ snowUrl: 'ws://localhost:3001/?access_token=secret' }));
  assert.equal(validateConfig({ deepseekModel: 'custom-model', timeoutSeconds: 300 }).deepseekModel, 'custom-model');
});
test('command routing preserves multiline prompts and text-only segments', () => {
  assert.deepEqual(parseInput('/TEAM 第一行\n第二行', 'both'), { mode: 'team', text: '第一行\n第二行' });
  assert.equal(messageText(event('hello', { message: [{ type: 'image', data: { file: 'secret' } }, { type: 'text', data: { text: '/both 你好' } }] })), '/both 你好');
  assert.equal(messageText({ message: '[CQ:image,file=abc]文字' }), '文字');
});
test('both providers see the same starting history; next turn sees both answers', async t => {
  const seen = [];
  const desk = fixtures(t, {
    codex: async (c, m) => { seen.push(['C', structuredClone(m)]); return 'C'; },
    deepseek: async (c, m) => { seen.push(['D', structuredClone(m)]); return 'D'; },
  });
  desk.submit('第一问', 'both'); await desk.tail;
  assert.deepEqual(seen[0][1], seen[1][1]);
  desk.submit('第二问', 'codex'); await desk.tail;
  assert.deepEqual(seen[2][1].map(m => m.text), ['第一问', 'C', 'D', '第二问']);
});
test('team synthesis reads DeepSeek draft, then persists both named answers', async t => {
  const desk = fixtures(t, { codex: async (c, m, instruction) => {
    assert.equal(m.at(-1).speaker, 'DeepSeek'); assert.match(instruction, /审阅/); return '整合答复';
  } });
  desk.submit('安排工作', 'team'); await desk.tail;
  assert.deepEqual(desk.state.messages.map(m => m.speaker), ['你', 'DeepSeek', 'Codex']);
  assert.equal(desk.state.jobs[0].status, 'done');
});
test('one provider failure does not lose the other answer; team can fall back', async t => {
  const desk = fixtures(t, { deepseek: async () => { throw new Error('连接失败'); } });
  desk.submit('问题', 'team'); await desk.tail;
  assert.equal(desk.state.jobs[0].status, 'done');
  assert.equal(desk.state.messages.at(-1).text, 'Codex 答复');
  assert.doesNotMatch(transcript(desk.state.messages), /连接失败/);
});
test('queue serializes computer and QQ turns, and blocks settings/new during work', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const seen = [];
  const desk = fixtures(t, { codex: async (c, m) => { seen.push(m.map(x => x.text)); if (seen.length === 1) await gate; return '完成'; } });
  desk.submit('电脑问题', 'codex'); desk.submit('QQ问题', 'codex', 'QQ');
  assert.throws(() => desk.newRoom(), /等待/); assert.throws(() => desk.updateConfig({ persona: 'test' }), /等待/);
  await new Promise(r => setImmediate(r)); assert.equal(seen.length, 1);
  release(); await desk.tail;
  assert.deepEqual(seen[1], ['电脑问题', '完成', 'QQ问题']); assert.equal(desk.active, 0);
});
test('QQ accepts owner private messages only; duplicate delivery is persisted across restart', async t => {
  const desk = fixtures(t); desk.config = { ...desk.config, qqEnabled: true, ownerQQ: '12345' };
  let sends = 0; desk.snow.send = async () => { sends++; };
  await desk.onQQ(event('/codex 你好', { user_id: 99999 }));
  await desk.onQQ(event('/codex 你好', { message_type: 'group', group_id: 1 }));
  await desk.onQQ(event('/codex 你好', { post_type: 'message_sent' }));
  await desk.onQQ(event('/codex 你好', { self_id: 12345 }));
  assert.equal(desk.active, 0);
  await desk.onQQ(event('/codex 你好')); await desk.onQQ(event('/codex 你好')); await desk.tail;
  assert.equal(sends, 1); assert.equal(desk.state.messages.length, 2);
  const restored = new Desk(desk.dir, desk.providers);
  restored.config = desk.config; restored.snow.send = async () => { sends++; };
  await restored.onQQ(event('/codex 你好')); await restored.tail;
  assert.equal(sends, 1); assert.equal(restored.state.messages.length, 2);
});
test('QQ delivery failure is visible and does not erase the model answer', async t => {
  const desk = fixtures(t); desk.snow.send = async () => { throw new Error('断线'); };
  desk.submit('问题', 'codex', 'QQ', '12345'); await desk.tail;
  assert.equal(desk.state.jobs[0].delivery, 'failed'); assert.match(desk.state.jobs[0].deliveryError, /电脑端/);
  assert.equal(desk.state.messages.at(-1).text, 'Codex 答复');
});
test('new conversation changes shared room and keeps old export; interrupted jobs fail on restart', async t => {
  const desk = fixtures(t); desk.submit('旧记录', 'codex'); await desk.tail;
  const room = desk.state.room; desk.newRoom(); assert.notEqual(desk.state.room, room);
  assert.equal(desk.snapshot().messages.length, 0); assert.equal(desk.state.messages.length, 2);
  desk.state.jobs.push({ id: 'interrupted', status: 'running' }); desk.save();
  const restored = new Desk(desk.dir, desk.providers);
  assert.equal(restored.state.jobs.at(-1).status, 'failed');
});
test('API keeps secrets off state; validates browser origin and rejects config/data paths', async t => {
  const { server, desk } = createApp({ dataDir: temp(t), providers: { codex: async () => '电脑端答案' } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(base); const cookie = initial.headers.get('set-cookie').split(';')[0];
  assert.match(await initial.text(), /一体双魂/);
  const post = (route, data, extra = {}) => fetch(base + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-local-request': '1', ...extra }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await post('/api/chat', { text: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/settings', { deepseekKey: 'secret-never-return', snowToken: 'token-never-return' })).status, 200);
  const response = await fetch(base + '/api/state', { headers: { cookie } }); const raw = await response.text();
  assert.doesNotMatch(raw, /secret-never-return|token-never-return/); assert.match(raw, /deepseekKeySet/);
  assert.notEqual((await fetch(base + '/data/config.json', { headers: { cookie } })).status, 200);
  assert.equal((await post('/api/chat', { text: '<script>你好</script>', mode: 'codex' })).status, 202);
  await desk.tail; assert.equal(desk.state.messages.at(-1).text, '电脑端答案');
  const saved = await (await fetch(base + '/api/export', { headers: { cookie } })).json();
  assert.equal(saved.messages[0].text, '<script>你好</script>'); assert.equal(saved.messages.length, 2);
});

class FakeWS extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url = url; this.readyState = 0; FakeWS.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(data) {
    const packet = JSON.parse(data); this.sent ||= []; this.sent.push(packet);
    const fail = packet.action === 'fail';
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: packet.echo, retcode: fail ? 1400 : 0, status: fail ? 'failed' : 'ok', data: packet.action === 'get_login_info' ? { user_id: 88888 } : {} }) })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
test('SnowLuma token handshake, echo correlation, business errors and Unicode text chunking', async t => {
  let received;
  const client = new SnowClient({ ...DEFAULTS, qqEnabled: true, snowToken: 'a&token' }, x => { received = x; }, FakeWS);
  t.after(() => client.stop()); client.start(); await new Promise(r => setImmediate(r));
  assert.equal(new URL(client.ws.url).searchParams.get('access_token'), 'a&token');
  assert.equal(client.status.botQQ, '88888');
  await assert.rejects(client.call('fail', {}), /操作失败/);
  client.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event('消息')) }));
  assert.equal(received.user_id, 12345);
  const long = '😀'.repeat(1900); await client.send('12345', long);
  const packets = client.ws.sent.filter(x => x.action === 'send_private_msg');
  assert.equal(packets.length, 2); assert.equal(packets.map(x => x.params.message[0].data.text).join(''), long);
  assert.equal(packets[0].params.user_id, 12345);
});
test('SnowLuma retries after disconnect and stop clears scheduled reconnect', async t => {
  const client = new SnowClient({ ...DEFAULTS, qqEnabled: true }, () => {}, FakeWS);
  t.after(() => client.stop()); client.start(); await new Promise(r => setImmediate(r));
  client.ws.close(); assert.equal(client.status.connected, false); assert.ok(client.timer);
  client.stop(); assert.equal(client.stopped, true);
});
test('DeepSeek HTTP adapter sends shared speaker history and rejects HTTP errors', async t => {
  let captured;
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    captured = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    if (captured.body.model === 'bad') { res.writeHead(401); return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '真实适配器模拟答复' } }] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { mock.closeAllConnections(); mock.close(r); }));
  const config = { ...DEFAULTS, deepseekUrl: `http://127.0.0.1:${mock.address().port}`, deepseekKey: 'test' };
  assert.equal(await deepseek(config, [{ role: 'user', speaker: '你', text: '中文问题' }]), '真实适配器模拟答复');
  assert.equal(captured.path, '/chat/completions'); assert.match(captured.auth, /^Bearer /);
  assert.match(captured.body.messages[1].content, /中文问题/);
  await assert.rejects(deepseek({ ...config, deepseekModel: 'bad' }, []), /HTTP 401/);
});
test('subprocess uses literal stdin and handles timeout and failed executable', async () => {
  const payload = '中文\n$(not-a-command) `literal`';
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: payload, timeout: 10000 });
  assert.equal(result.stdout, payload);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 250 }), /超时/);
  await assert.rejects(runProcess('definitely-missing-codex-xyz', [], { timeout: 1000 }), /无法启动/);
});
test('context limits model input while retaining complete persisted record', async t => {
  const desk = fixtures(t); for (let i = 0; i < 10; i++) desk.add('你', '中文'.repeat(2000) + i, 'user');
  const small = transcript(desk.state.messages, 10000); assert.ok(small.length < 10100); assert.match(small, /9/);
  assert.equal(desk.state.messages.length, 10);
});
