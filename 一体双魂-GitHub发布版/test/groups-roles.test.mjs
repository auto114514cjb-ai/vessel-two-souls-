import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Desk, DEFAULTS, ROLE_DEFAULTS, validateConfig, mentionsBot, promptFor, SnowClient } from '../core.mjs';
import { createApp } from '../server.mjs';

function fixture(t, providers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-groups-roles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const desk = new Desk(dir, { codex: async () => 'GPT回复', deepseek: async () => 'DeepSeek回复', ...providers });
  desk.chatProvider = providers.groupChat || (async (c, soul, prompt) => '群聊回复');
  t.after(() => desk.snow.stop());
  desk.config = validateConfig({ qqEnabled: true, ownerQQ: '12345', groupEnabled: true, allowedGroups: '55555,66666' }, desk.config);
  desk.ensureChannels(); const sent = [];
  desk.snow.send = async (id, text) => sent.push({ type: 'private', id, text });
  desk.snow.sendGroup = async (id, text, atQQ) => sent.push({ type: 'group', id, text, atQQ });
  return { desk, sent };
}
function group(text, extra = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 88888, user_id: 12345, group_id: 55555, message_id: 100,
    message: [{ type: 'at', data: { qq: '88888' } }, { type: 'text', data: { text } }], ...extra };
}
test('group config normalizes lists and requires an explicit group', () => {
  assert.equal(validateConfig({ allowedGroups: '55555，66666\n55555' }).allowedGroups, '55555,66666');
  assert.throws(() => validateConfig({ groupEnabled: true }), /群号/);
  assert.throws(() => validateConfig({ allowedGroups: 'not-a-group' }), /数字/);
});
test('any group member can trigger allowlisted groups, with exact bot mentions', async t => {
  const { desk, sent } = fixture(t);
  for (const event of [group('/codex 不应回答', { group_id: 77777 }),
    group('/codex 不应回答', { message: [{ type: 'text', data: { text: '/codex 没有at' } }] }),
    group('/codex 不应回答', { message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '/codex @全体成员' } }] }),
    group('/codex 不应回答', { user_id: 88888 }), group('/codex 不应回答', { post_type: 'message_sent' })]) await desk.onQQ(event);
  assert.equal(desk.active, 0); assert.equal(sent.length, 0);
  await desk.onQQ(group('/codex 合法问题', { user_id: 23456, sender: { nickname: '群友甲' } })); await desk.tail;
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'group'); assert.equal(sent[0].id, '55555'); assert.equal(sent[0].atQQ, '23456');
  assert.match(desk.state.messages[0].speaker, /群友甲.*23456/);
  assert.equal(desk.snapshot().messages.length, 0);
});
test('private and two group histories remain isolated while switching the computer during generation', async t => {
  let release; const gate = new Promise(r => { release = r; }); const histories = [];
  const { desk, sent } = fixture(t, { codex: async (c, m) => { histories.push({ texts: m.map(x => x.text) }); await gate; return '私人完成'; }, groupChat: async(c, soul, prompt) => { const json = prompt.split('<shared_history>\n')[1].split('\n</shared_history>')[0]; histories.push({ texts: json.split('\n').map(line => JSON.parse(line).text) }); return '群聊完成'; } });
  const privateRoom = desk.state.room;
  desk.submitComputer('私人内容', 'codex');
  await desk.onQQ(group('/codex 甲群内容'));
  await desk.onQQ(group('/codex 乙群内容', { group_id: 66666 }));
  desk.selectChannel('group:66666'); release(); await desk.tail;
  assert.deepEqual(histories.map(h => h.texts), [['私人内容'], ['甲群内容'], ['乙群内容']]);
  assert.equal(desk.state.messages.filter(m => m.room === privateRoom).length, 2);
  assert.equal(desk.snapshot().messages[0].text, '乙群内容');
  assert.deepEqual(sent.map(s => s.id), ['55555', '66666']);
});
test('group duplicate keys include group id and group reset affects only the requested channel', async t => {
  const { desk } = fixture(t); const originalPrivate = desk.state.room;
  await desk.onQQ(group('/codex 问题')); await desk.onQQ(group('/codex 问题')); await desk.tail;
  assert.equal(desk.state.messages.length, 2);
  const first = desk.state.channels['group:55555'].room, other = desk.state.channels['group:66666'].room;
  await desk.onQQ(group('/new', { message_id: 101 }));
  assert.notEqual(desk.state.channels['group:55555'].room, first); assert.equal(desk.state.room, originalPrivate); assert.equal(desk.state.channels['group:66666'].room, other);
  const reset = desk.state.channels['group:55555'].room;
  await desk.onQQ(group('/new', { user_id: 23456, message_id: 102 })); assert.equal(desk.state.channels['group:55555'].room, reset);
});
test('computer group publication is explicit and uses the submitted channel even after switching', async t => {
  const { desk, sent } = fixture(t);
  desk.submitComputer('只在电脑看', 'codex', false, 'group:55555'); await desk.tail; assert.equal(sent.length, 0);
  desk.selectChannel('group:66666');
  desk.submitComputer('发到甲群', 'codex', true, 'group:55555'); await desk.tail;
  assert.equal(sent[0].id, '55555'); assert.equal(desk.snapshot().messages.length, 0);
  assert.throws(() => desk.submitComputer('错误群', 'codex', true, 'group:77777'), /已配置/);
  await assert.rejects(desk.linkHarness('private-session'), /私人会话/);
});
test('CQ at decoding requires the exact bot, and group output is Unicode-safe text with a single mention', async () => {
  assert.equal(mentionsBot(group('x', { message: '[CQ:at,qq=88888] /both 你好' })), true);
  assert.equal(mentionsBot(group('x', { message: '[CQ:at,qq=888889] hello' })), false);
  const client = new SnowClient(DEFAULTS, () => {}), calls = []; client.call = async (action, params) => calls.push({ action, params });
  await client.sendGroup('55555', '😀'.repeat(1900) + '[CQ:at,qq=all]', '12345');
  assert.equal(calls.length, 2); assert.equal(calls[0].action, 'send_group_msg'); assert.equal(calls[0].params.group_id, 55555);
  assert.equal(calls[0].params.message[0].type, 'at'); assert.equal(calls[1].params.message.filter(x => x.type === 'at').length, 0);
  assert.equal(calls.flatMap(x => x.params.message).filter(x => x.type === 'text').map(x => x.data.text).join(''), '\n' + '😀'.repeat(1900) + '[CQ:at,qq=all]');
});
test('role defaults are preloaded, per-soul prompts use the correct card, and custom cards survive restart', t => {
  const { desk } = fixture(t);
  assert.match(desk.config.persona, /一个身体.*两个灵魂/);
  const config = validateConfig({ persona: '共享身体', deepseekRole: 'DS独有标记', codexRole: 'GPT独有标记' }, desk.config);
  const gpt = promptFor('Codex', config, []), ds = promptFor('DeepSeek', config, []);
  assert.match(gpt, /共享身体/); assert.match(gpt, /GPT独有标记/); assert.doesNotMatch(gpt, /DS独有标记/);
  assert.match(ds, /DS独有标记/); assert.doesNotMatch(ds, /GPT独有标记/);
  desk.updateConfig(config); const restored = new Desk(desk.dir);
  assert.equal(restored.config.codexRole, 'GPT独有标记'); assert.equal(restored.config.persona, '共享身体');
  assert.throws(() => validateConfig({ deepseekRole: 'x'.repeat(12001) }), /角色卡/);
});
test('role export includes both cards and no connection credentials; defaults API returns preset', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-roles-api-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, desk } = createApp({ dataDir: dir }); desk.config.snowToken = 'secret-snow'; desk.config.deepseekKey = 'secret-key';
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const roles = await (await fetch(base + '/api/roles/export', { headers: { cookie } })).json();
  assert.equal(roles.deepseekRole, ROLE_DEFAULTS.deepseekRole); assert.equal(roles.codexRole, ROLE_DEFAULTS.codexRole);
  assert.doesNotMatch(JSON.stringify(roles), /secret-snow|secret-key|harnessToken/);
  assert.deepEqual(await (await fetch(base + '/api/roles/defaults', { headers: { cookie } })).json(), ROLE_DEFAULTS);
});
