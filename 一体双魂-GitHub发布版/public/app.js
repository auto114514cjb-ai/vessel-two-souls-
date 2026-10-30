const $ = q => document.querySelector(q);
let mode = 'both', state, lastRender = '', submitting = false, hadSettings = false;
let showDialogue=localStorage.getItem('desk-show-dialogue')==='1',selectedTreasure=null,treasureSearchVersion=0;
let appearanceSignature='';
let agentModelCatalog=null;
$('#showDialogue').checked=showDialogue;
const hints = { both: '两位助手读取同一份记录，各自给出答案。', team: 'DeepSeek 先提方案，Codex 阅读后审阅、修正并整合。', codex: 'Codex 回答；这次交流也会进入共同记录。', deepseek: 'DeepSeek 回答；这次交流也会进入共同记录。' };
async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Request': '1' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function soulName(soul,data=state){return data?.config.agentRouting==='custom'?data.config[soul+'AgentName']:soul==='codex'?'GPT':'DeepSeek'}
function modeHint() {if(state?.config.agentRouting==='custom'){const a=soulName('deepseek'),b=soulName('codex'),prefix=state.config.innerDialogue?'两位先独立提出意见，再相互审阅；':'使用各自角色卡；';return prefix+({both:'分别回答。',team:b+' 整合后发言。',codex:b+' 发言。',deepseek:a+' 发言。'})[mode]}return state?.config.innerDialogue?({both:'双魂先交换意见，再分别回答。',team:'双魂先交换意见，由 GPT 整合后发言。',codex:'双魂先交换意见，由 GPT 发言。',deepseek:'双魂先交换意见，由 DeepSeek 发言。'})[mode]:hints[mode]}
function setMode(value) { mode = value; document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === value)); $('#modeHint').textContent = modeHint(); }
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
function render(data) {
  applyAppearance(data.appearance);
  document.querySelector('.brand p').textContent=data.config.agentRouting==='custom'?'双 Agent · 共同记忆':'Codex × DeepSeek';
  document.querySelector('.person .codex').nextElementSibling.querySelector('strong').textContent=soulName('codex',data);
  document.querySelector('.person .deepseek').nextElementSibling.querySelector('strong').textContent=soulName('deepseek',data);
  document.querySelector('[data-mode="codex"]').textContent=data.config.agentRouting==='custom'?soulName('codex',data):'GPT · Codex';
  document.querySelector('[data-mode="deepseek"]').textContent=soulName('deepseek',data);
  $('#treasureCount').textContent=data.treasureCount||0;
  $('#modeHint').textContent=modeHint();
  renderChatgpt(data.chatgpt);
  const customAgents=data.config.agentRouting==='custom'&&(!data.selectedChannel.startsWith('group:')||data.config.agentGroupRouting);
  const usingPlan = customAgents?[data.config.deepseekAgentBackend,data.config.codexAgentBackend].includes('chatgpt'):data.selectedChannel.startsWith('group:') ? data.config.groupGptBackend === 'chatgpt' : data.config.gptBackend === 'chatgpt';
  $('#planUsage').hidden = !usingPlan;
  $('#snowStatus').textContent = data.snow.detail;
  $('#snowDot').classList.toggle('online', data.snow.connected);
  const select = $('#channelSelect');
  const channelsKey = JSON.stringify(data.channels);
  if (select.dataset.channels !== channelsKey) {
    select.replaceChildren();
    for (const channel of data.channels) { const option = document.createElement('option'); option.value = channel.key; option.textContent = channel.title; select.append(option); }
    select.dataset.channels = channelsKey;
  }
  select.value = data.selectedChannel;
  const isGroup = data.selectedChannel.startsWith('group:');
  $('#publishControl').hidden = !isGroup;
  $('#channelNote').textContent = isGroup ? '这里的电脑发言也会进入本群的共享上下文。' : '一体双魂，共享当前会话的记忆。';
  const signature = JSON.stringify([data.room, data.messages, data.jobs, data.active,showDialogue,data.appearance]);
  if (signature === lastRender) return; lastRender = signature;
  const box = $('#messages'), nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 110;
  box.replaceChildren();
  if (!data.messages.length) {
    const welcome = document.createElement('div'); welcome.className = 'welcome';
    welcome.innerHTML = '<div class="symbol">✳</div><h3>把想法放到同一张桌上。</h3><p>在这里和 Codex、DeepSeek 一起讨论、写作和规划。<br>连接 SnowLuma 后，也能从 QQ 继续这段会话。</p><div class="suggestions"><button type="button" data-example="我有一个项目想法，请先向我提三个关键问题，帮我梳理目标。">梳理一个新项目<small>从目标开始，拆出下一步</small></button><button type="button" data-example="帮我安排今天的工作。先问我需要完成的事情和可用时间。">安排今天的工作<small>一起理清优先级和时间</small></button></div>';
    welcome.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => { $('#input').value = b.dataset.example; $('#input').focus(); })); box.append(welcome);
  }
  if (data.totalMessages > 500) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = '窗口显示最近 500 条；全部历史可从左侧导出。助手每次读取最近约 48000 字符。'; box.append(note); }
  for (const m of data.messages) {
    const article = document.createElement('article'); article.className = `bubble ${m.role}`;
    const head = document.createElement('div'); head.className = 'bubble-head';
    const isB=m.agent?m.agent==='codex':['Codex','GPT'].includes(m.speaker);
    const icon = document.createElement('span'); icon.className = `avatar ${isB ? 'codex' : 'deepseek'}`; icon.textContent = m.role==='user'?'你':m.role==='system'?'!':isB?'B':'A';
    if(m.role!=='user'&&m.role!=='system')paintIcon(icon,isB?data.appearance?.gptAvatar:data.appearance?.deepseekAvatar,icon.textContent);
    const speaker = document.createElement('strong'); speaker.textContent = !m.agent&&m.speaker === 'Codex' ? 'GPT · Codex' : m.speaker;
    const source = document.createElement('span'); source.className = 'source'; source.textContent = m.source || '';
    const time = document.createElement('time'); time.dateTime = m.at; time.textContent = new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    head.append(icon, speaker, source, time); const text = document.createElement('div'); text.className = 'bubble-text'; text.textContent = m.text; article.append(head, text); box.append(article);
    if(m.role==='user'){
      const job=data.jobs.find(j=>j.id===m.jobId);
      if(showDialogue&&job?.innerDialogue){const panel=document.createElement('div');panel.className='inner-dialogue bubble';const title=document.createElement('strong');title.textContent=job.innerDialogue.status==='running'?'双魂正在交换意见…':'双魂讨论 · 角色对话摘要';panel.append(title);
        const label=document.createElement('small');label.textContent='这是生成的角色发言，不是模型的隐藏思考过程。仅在本地显示。';panel.append(label);
        for(const note of job.innerDialogue.notes||[]){const p=document.createElement('p');p.textContent=(note.name||job.agentAssignments?.[note.soul]?.name||(note.soul==='codex'?'GPT':'DeepSeek'))+'：'+note.text;panel.append(p)}
        for(const vote of job.innerDialogue.judgements||[]){const p=document.createElement('small');p.textContent=(vote.name||job.agentAssignments?.[vote.soul]?.name||(vote.soul==='codex'?'GPT':'DeepSeek'))+' 的珍藏判断：'+(!vote.available?'未参与':!vote.structured?'格式无效':vote.keep?(vote.complete?'建议珍藏':'建议珍藏，记录尚不完整'):'本次不珍藏')+'。'+vote.reason;panel.append(p)}
        for(const err of job.innerDialogue.errors||[]){const p=document.createElement('p');p.className='muted';p.textContent=(job.agentAssignments?.[err.soul]?.name||(err.soul==='codex'?'GPT':'DeepSeek'))+' 暂未参与：'+err.error;panel.append(p)}
        if(job.agentAssignments){const p=document.createElement('small');p.textContent=Object.values(job.agentAssignments).map(a=>{let model=a.model;try{if(a.backend==='harness')model=JSON.parse(model)[1]}catch{}return a.name+' · '+({harness:'Harness','deepseek-api':'DeepSeek API',codex:'Codex',chatgpt:'ChatGPT'}[a.backend]||a.backend)+' / '+model}).join(' ｜ ');panel.append(p)}
        box.append(panel);
      }
      if(job?.recalledTreasures?.length||job?.treasure||job?.treasureError){const panel=document.createElement('div');panel.className='memory-used bubble';
        for(const t of job.recalledTreasures||[]){const b=document.createElement('button');b.type='button';b.className='check';b.textContent='拾起宝藏：'+t.title;b.addEventListener('click',()=>openTreasure(t.id));panel.append(b)}
        if(job.treasure){const b=document.createElement('button');b.type='button';b.className='check';b.textContent=(job.treasure.alreadySaved?'关联宝藏：':'新宝藏：')+job.treasure.title;b.addEventListener('click',()=>openTreasure(job.treasure.id));panel.append(b)}
        if(job.treasureError){const p=document.createElement('p');p.textContent=job.treasureError;panel.append(p)}box.append(panel);
      }
    }
  }
  $('#queueStatus').textContent = data.active ? `${data.active} 条消息正在处理或等待 · Harness 可能正等待你在原窗口确认` : data.harnessSessionId ? '已接续 Harness 会话 · 电脑与 QQ 共用记录' : '共同记录已保存 · Harness 的工具确认仍在原窗口处理';
  if(customAgents)$('#queueStatus').textContent=data.active?`${data.active} 条消息正在处理或等待`:'独立角色 · 共享记录 · 纯文字讨论';
  const talking=data.jobs.find(j=>j.status==='running'&&j.innerDialogue?.status==='running');
  if(talking)$('#queueStatus').textContent='双魂正在交流 · '+soulName(talking.innerDialogue.currentSoul)+' 正在给出角色意见';
  const failed = data.jobs.findLast(j => j.delivery === 'failed');
  if (failed) notice('QQ 发送未完成：' + failed.deliveryError);
  if (nearBottom || submitting) box.scrollTop = box.scrollHeight;
}
async function refresh() {
  try {
    state = await api('/api/state'); render(state);
    if (!hadSettings) { hadSettings = true; setMode(state.config.defaultMode); notice(state.config.agentRouting==='custom'?'':state.config.deepseekBackend === 'harness' ? state.harnessSessionId ? '' : '首次使用：安装 Harness 桥接，打开“连接与设置”检查连接；QQ 可以稍后配置。' : !state.config.deepseekKeySet ? '首次使用：请在“连接与设置”填写 DeepSeek API 密钥。' : ''); }
  } catch (e) { notice('无法连接本地程序：' + e.message + '。请确认启动窗口仍在运行。'); }
}
$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault(); if (submitting || !$('#input').value.trim()) return;
  submitting = true; $('#send').disabled = true;
  const value = $('#input').value;
  try { await api('/api/chat', { text: value, mode, channelKey: $('#channelSelect').value, publishToGroup: $('#publishToGroup').checked && !$('#publishControl').hidden }); $('#input').value = ''; notice(''); await refresh(); $('#messages').scrollTop = $('#messages').scrollHeight; }
  catch (error) { notice(error.message); }
  finally { submitting = false; $('#send').disabled = false; $('#input').focus(); }
});
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
$('#newChat').addEventListener('click', async () => {
  if (!confirm('重新开始当前会话？其他群和私聊不受影响，旧记录仍可导出。')) return;
  try { await api('/api/new', {}); notice(''); await refresh(); } catch (e) { notice(e.message); }
});
$('#openSettings').addEventListener('click', async () => {
  await refresh(); if (!state) return;
  const form = $('#settingsForm');
  for (const [key, value] of Object.entries(state.config)) {
    const el = form.elements.namedItem(key); if (!el) continue;
    if (el.tagName === 'SELECT' && value && !Array.from(el.options).some(o => o.value === value)) { const o = document.createElement('option'); o.value = value; o.textContent = value + '（已保存）'; el.append(o); }
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
  }
  form.elements.deepseekKey.value = ''; form.elements.snowToken.value = '';
  $('#keyStatus').textContent = state.config.deepseekKeySet ? '已有密钥；留空会保留。' : '尚未配置密钥。';
  $('#tokenStatus').textContent = state.config.snowTokenSet ? '已有访问令牌；留空会保留。' : '尚未配置访问令牌。';
  showAgents(); $('#settingsStatus').textContent = ''; $('#settings').showModal(); refreshModelChoices();
});
$('#closeSettings').addEventListener('click', () => $('#settings').close());
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget; const body = Object.fromEntries(new FormData(f));
  for (const key of ['qqEnabled', 'groupEnabled','innerDialogue','treasuresEnabled','agentGroupRouting']) body[key] = f.elements[key].checked;
  body.timeoutSeconds = Number(body.timeoutSeconds);
  body.recentContextChars=Number(body.recentContextChars);
  if (!body.deepseekKey) delete body.deepseekKey; if (!body.snowToken) delete body.snowToken;
  const button = f.querySelector('[type=submit]'); button.disabled = true;
  try { await api('/api/settings', body); $('#settingsStatus').textContent = '已保存。可以检查连接，或关闭设置开始聊天。'; notice(''); await refresh(); }
  catch (error) { $('#settingsStatus').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#channelSelect').addEventListener('change', async e => {
  try { await api('/api/channel', { key: e.target.value }); $('#publishToGroup').checked = false; notice(''); await refresh(); }
  catch (error) { notice(error.message); }
});
function fillRoles(cards) {
  for (const key of ['persona', 'deepseekRole', 'codexRole']) {
    if (typeof cards[key] !== 'string') throw new Error('角色卡需要包含共同人设、DeepSeek 和 GPT 三项文字');
    if (cards[key].length > (key === 'persona' ? 8000 : 12000)) throw new Error('角色卡文字超过长度限制');
  }
  for (const key of ['persona', 'deepseekRole', 'codexRole']) $('#settingsForm').elements[key].value = cards[key];
  $('#settingsStatus').textContent = '角色卡已载入编辑框；点击“保存并连接”后生效。';
}
$('#defaultRoles').addEventListener('click', async () => { try { fillRoles(await api('/api/roles/defaults')); } catch (e) { $('#settingsStatus').textContent = e.message; } });
$('#importRoles').addEventListener('click', () => $('#rolesFile').click());
$('#rolesFile').addEventListener('change', async e => {
  try { const file = e.target.files[0]; if (!file) return; if (file.size > 180000) throw new Error('角色卡文件过大'); fillRoles(JSON.parse(await file.text())); }
  catch (error) { $('#settingsStatus').textContent = '无法导入角色卡：' + error.message; }
  finally { e.target.value = ''; }
});
function showBackend() {
  const f=$('#settingsForm'),custom=f.elements.agentRouting.value==='custom',backends=custom?[f.elements.deepseekAgentBackend.value,f.elements.codexAgentBackend.value]:[];
  const harness = f.elements.deepseekBackend.value === 'harness';
  $('#harnessFields').hidden = !harness&&!backends.includes('harness'); $('#apiFields').hidden = harness&&!backends.includes('deepseek-api');
}
$('#settingsForm').elements.deepseekBackend.addEventListener('change', showBackend);
function showGptBackend() {
  const f = $('#settingsForm');
  const backends=f.elements.agentRouting.value==='custom'?[f.elements.deepseekAgentBackend.value,f.elements.codexAgentBackend.value]:[];
  $('#codexFields').hidden = f.elements.gptBackend.value !== 'codex'&&!backends.includes('codex');
  $('#chatgptFields').hidden = f.elements.gptBackend.value !== 'chatgpt' && f.elements.groupGptBackend.value !== 'chatgpt'&&!backends.includes('chatgpt');
  $('#groupChatgpt').hidden = f.elements.groupGptBackend.value !== 'chatgpt';
  $('#groupHarnessGpt').hidden = f.elements.groupGptBackend.value === 'chatgpt';
}
for (const key of ['gptBackend','groupGptBackend']) $('#settingsForm').elements[key].addEventListener('change', showGptBackend);
let accountSignature = '';
function renderChatgpt(info) {
  if (!info) return;
  const signature = JSON.stringify([info.active, info.accounts]);
  if (signature !== accountSignature) {
    accountSignature = signature;
    modelOptions($('#chatgptAccount'), (info.accounts || []).map(a => ({ id:a.id, name:a.label + (a.signedIn ? '' : '（已退出）') })), info.active, '添加其他 ChatGPT 账号');
  }
  $('#logoutChatgpt').disabled = !info.signedIn;
  $('#chatgptStatus').textContent = info.error || (info.pending ? '等待你在 OpenAI 页面完成授权（十分钟内有效）……' : info.planEnabled ? '已登录，已获得订阅额度权限。请选择接入方式和模型后保存。' : info.signedIn ? '账号已登录，但尚未允许使用订阅额度。请重新授权。' : '尚未登录。请在 OpenAI 页面亲自登录并授权。');
  if (info.welcome && !$('#planWelcome').open) $('#planWelcome').showModal();
}
$('#loginChatgpt').addEventListener('click', async () => {
  const button = $('#loginChatgpt'); button.disabled = true;
  const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
  try {
    const result = await api('/api/chatgpt/login', { clientId: $('#chatgptAccount').value });
    if (popup) popup.location.href = result.url; else window.location.assign(result.url);
    await refresh();
  } catch (e) { popup?.close(); $('#settingsStatus').textContent = e.message; }
  finally { button.disabled = false; }
});
$('#chatgptAccount').addEventListener('change', async e => {
  if (!e.target.value) return;
  try { await api('/api/chatgpt/select', { clientId:e.target.value }); await refresh(); await refreshModelChoices(); }
  catch (e) { $('#settingsStatus').textContent = e.message; }
});
$('#logoutChatgpt').addEventListener('click', async () => {
  try { const result = await api('/api/chatgpt/logout', {}); $('#settingsStatus').textContent = result.detail; await refresh(); await refreshModelChoices(); }
  catch (e) { $('#settingsStatus').textContent = e.message; }
});
async function acknowledgePlan() {
  try { await api('/api/chatgpt/acknowledge', {}); $('#planWelcome').close(); await refresh(); }
  catch (e) { notice(e.message); }
}
$('#acknowledgePlan').addEventListener('click', acknowledgePlan);
$('#planWelcome').addEventListener('cancel', e => { e.preventDefault(); acknowledgePlan(); });
$('#loadSessions').addEventListener('click', async () => {
  try {
    const { items } = await api('/api/harness/sessions', {}); const select = $('#harnessSession'); select.replaceChildren();
    for (const item of items) { const option = document.createElement('option'); option.value = item.sessionId; option.textContent = `${item.title} ${item.running ? '（正在工作）' : ''}`; select.append(option); }
    $('#settingsStatus').textContent = items.length ? '选择要接续的会话，然后点击“载入文字记录并接续”。' : '没有已有会话；直接聊天会新建一个 Harness 会话。';
  } catch (e) { $('#settingsStatus').textContent = e.message; }
});
$('#linkSession').addEventListener('click', async () => {
  const sessionId = $('#harnessSession').value; if (!sessionId) return;
  try { await api('/api/harness/link', { sessionId }); await refresh(); $('#settingsStatus').textContent = '已载入并接续。可以关闭设置，在电脑或 QQ 继续工作。'; }
  catch (e) { $('#settingsStatus').textContent = e.message; }
});
for (const [selector, route] of [['#checkCodex', 'codex'], ['#checkSnow', 'snow'], ['#checkHarness', 'harness']]) {
  $(selector).addEventListener('click', async () => {
    $(selector).disabled = true; $('#settingsStatus').textContent = '正在检查已保存的配置……';
    try { const result = await api('/api/check/' + route, {}); $('#settingsStatus').textContent = result.detail; }
    catch (e) { $('#settingsStatus').textContent = e.message; }
    finally { $(selector).disabled = false; }
  });
}
function modelOptions(select, items, saved, defaultText) {
  select.replaceChildren();
  if (defaultText !== null) { const o = document.createElement('option'); o.value = ''; o.textContent = defaultText; select.append(o); }
  for (const model of items) { const o = document.createElement('option'); o.value = model.id; o.textContent = model.name; select.append(o); }
  if (saved && !items.some(m => m.id === saved)) { const o = document.createElement('option'); o.value = saved; o.textContent = saved + '（已保存，列表尚未验证）'; select.append(o); }
  select.value = saved || '';
}
async function refreshModelChoices() {
  $('#refreshModels').disabled = true; $('#modelStatus').textContent = '正在读取已保存连接中的可用模型……';
  try {
    const f = $('#settingsForm'), data = await api('/api/models', {agentBackends:f.elements.agentRouting.value==='custom'?[f.elements.deepseekAgentBackend.value,f.elements.codexAgentBackend.value]:[]});
    agentModelCatalog=data;fillAgentModels();
    const choices = (data.harness?.groups || []).flatMap(g => g.models.map(m => ({ id: JSON.stringify([g.id,m.id]), name: `${g.name} / ${m.name} (${m.id})` })));
    modelOptions(f.elements.groupDeepseekModel, choices, f.elements.groupDeepseekModel.value || state.config.groupDeepseekModel, '自动匹配可用 DeepSeek 模型');
    modelOptions(f.elements.groupGptModel, choices, f.elements.groupGptModel.value || state.config.groupGptModel, '自动匹配可用 GPT 模型');
    modelOptions(f.elements.codexModel, data.codex, f.elements.codexModel.value || state.config.codexModel, '使用 Codex 默认模型');
    modelOptions(f.elements.chatgptModel, data.chatgpt || [], f.elements.chatgptModel.value, '使用账号列表中的首个文字模型');
    modelOptions(f.elements.chatgptGroupModel, data.chatgpt || [], f.elements.chatgptGroupModel.value, '使用账号列表中的首个文字模型');
    modelOptions(f.elements.deepseekModel, data.deepseekApi, f.elements.deepseekModel.value || state.config.deepseekModel, null);
    const errors = [data.harnessError, data.codexError, data.deepseekApiError, data.chatgptError].filter(Boolean);
    $('#modelStatus').textContent = `已读取 ${choices.length} 个 Harness 模型、${data.codex.length} 个 Codex 模型、${(data.chatgpt || []).length} 个 ChatGPT 模型。` + (errors.length ? '\n' + errors.join('\n') : '选择后保存即可。');
  } catch (error) { $('#modelStatus').textContent = error.message;$('#agentModelStatus').textContent=error.message; }
  finally { $('#refreshModels').disabled = false; }
}
$('#refreshModels').addEventListener('click', refreshModelChoices);
function showAgents(){
  const f=$('#settingsForm'),enabled=f.elements.agentRouting.value==='custom';$('#agentFields').hidden=!enabled;
  for(const soul of ['deepseek','codex'])f.elements[soul+'AgentModel'].required=enabled;
  f.elements.defaultMode.querySelector('option[value="deepseek"]').textContent=enabled?(f.elements.deepseekAgentName.value||'Agent A'):'DeepSeek';
  f.elements.defaultMode.querySelector('option[value="codex"]').textContent=enabled?(f.elements.codexAgentName.value||'Agent B'):'GPT · Codex';
  showBackend();showGptBackend();fillAgentModels();
}
function fillAgentModels(){
  const f=$('#settingsForm'),data=agentModelCatalog;
  if(!data){$('#agentModelStatus').textContent='先在上方保存连接，再读取模型列表。新密钥请先在“原有连接”模式保存。';return}
  const choices={harness:(data.harness?.groups||[]).flatMap(g=>g.models.map(m=>({id:JSON.stringify([g.id,m.id]),name:g.name+' / '+m.name+' ('+m.id+')'}))),codex:data.codex||[],chatgpt:data.chatgpt||[],'deepseek-api':data.deepseekApi||[]};
  const errors={harness:data.harnessError,codex:data.codexError,chatgpt:data.chatgptError,'deepseek-api':data.deepseekApiError};
  for(const soul of ['deepseek','codex']){const select=f.elements[soul+'AgentModel'];modelOptions(select,choices[f.elements[soul+'AgentBackend'].value]||[],select.value,'请选择一个文字模型')}
  const a=f.elements.deepseekAgentModel.value,b=f.elements.codexAgentModel.value;
  const same=!!a&&a===b&&f.elements.deepseekAgentBackend.value===f.elements.codexAgentBackend.value;
  $('#agentModelStatus').textContent=(same?'两位使用同一接入来源和同一模型，分别进行独立调用；名字、角色卡和头像各自保留。':'分别选择模型，或用按钮让 B 与 A 相同。')+' '+[...new Set(['deepseek','codex'].map(s=>errors[f.elements[s+'AgentBackend'].value]).filter(Boolean))].join('；');
}
$('#settingsForm').elements.agentRouting.addEventListener('change',e=>{if(e.target.value==='custom')$('#settingsForm').elements.innerDialogue.checked=true;showAgents();refreshModelChoices()});
for(const soul of ['deepseek','codex']){
  $('#settingsForm').elements[soul+'AgentName'].addEventListener('input',showAgents);
  $('#settingsForm').elements[soul+'AgentBackend'].addEventListener('change',()=>{$('#settingsForm').elements[soul+'AgentModel'].value='';showAgents();refreshModelChoices()});
  $('#settingsForm').elements[soul+'AgentModel'].addEventListener('change',fillAgentModels);
}
$('#refreshAgentModels').addEventListener('click',refreshModelChoices);
$('#sameAgentModel').addEventListener('click',()=>{
  const f=$('#settingsForm');if(!f.elements.deepseekAgentModel.value){$('#agentModelStatus').textContent='请先为 Agent A 选择模型。';return}
  f.elements.codexAgentBackend.value=f.elements.deepseekAgentBackend.value;
  f.elements.codexAgentModel.replaceChildren();const option=document.createElement('option');option.value=f.elements.deepseekAgentModel.value;option.textContent=f.elements.deepseekAgentModel.selectedOptions[0].textContent;f.elements.codexAgentModel.append(option);
  showAgents();
});
$('#showDialogue').addEventListener('change',e=>{showDialogue=e.target.checked;localStorage.setItem('desk-show-dialogue',showDialogue?'1':'0');lastRender='';if(state)render(state)});
async function loadTreasures(){
  const version=++treasureSearchVersion;
  try{const query=new URLSearchParams({channel:state.selectedChannel,q:$('#treasureQuery').value,archived:$('#includeArchivedTreasures').checked?'1':'0'});const data=await api('/api/treasures?'+query);
    if(version!==treasureSearchVersion)return;$('#treasureScope').textContent=data.title+' · 本会话的宝藏';$('#treasureStatus').textContent=data.warning||(data.items.length?'找到 '+data.items.length+' 件宝藏':'宝箱还没有匹配的宝藏。');$('#treasureList').replaceChildren();
    for(const t of data.items){const card=document.createElement('article');card.className='treasure-card';const title=document.createElement('h3');title.textContent='【宝藏】'+t.title;const meta=document.createElement('small');meta.textContent=new Date(t.createdAt).toLocaleString('zh-CN')+' · '+(t.decision==='both'?'双魂共同珍藏':'你手动珍藏')+(t.archived?' · 已移出回忆':'');const summary=document.createElement('p');summary.textContent=t.summary;const tags=document.createElement('small');tags.textContent=t.tags.join(' · ');const button=document.createElement('button');button.type='button';button.className='check';button.textContent='查看原文';button.addEventListener('click',()=>openTreasure(t.id));card.append(title,meta,summary,tags,button);$('#treasureList').append(card)}
  }catch(e){$('#treasureStatus').textContent=e.message}
}
async function openTreasure(id){
  try{selectedTreasure=await api('/api/treasure?'+new URLSearchParams({channel:state.selectedChannel,id}));const t=selectedTreasure;$('#treasureTitle').textContent='【宝藏】'+t.title;$('#treasureBody').replaceChildren();
    const summary=document.createElement('p');summary.className='treasure-summary';summary.textContent=t.summary;$('#treasureBody').append(summary);
    const meta=document.createElement('p');meta.className='muted';meta.textContent=new Date(t.createdAt).toLocaleString('zh-CN')+' · '+(t.decision==='both'?'双魂共识':'手动珍藏');$('#treasureBody').append(meta);
    for(const m of t.messages){const item=document.createElement('section'),label=document.createElement('h4'),text=document.createElement('p');label.textContent=m.speaker+' · '+new Date(m.at).toLocaleString('zh-CN');text.className='treasure-original';text.textContent=m.text;item.append(label,text);$('#treasureBody').append(item)}
    $('#archiveTreasure').textContent=t.archived?'恢复到自动回忆':'移出自动回忆';if(!$('#treasureDetail').open)$('#treasureDetail').showModal();
  }catch(e){notice(e.message)}
}
$('#openTreasures').addEventListener('click',async()=>{await refresh();if(!state)return;$('#treasuresDialog').showModal();loadTreasures()});
$('#closeTreasures').addEventListener('click',()=>$('#treasuresDialog').close());$('#closeTreasureDetail').addEventListener('click',()=>$('#treasureDetail').close());
$('#treasureQuery').addEventListener('input',loadTreasures);$('#includeArchivedTreasures').addEventListener('change',loadTreasures);
$('#archiveTreasure').addEventListener('click',async()=>{if(!selectedTreasure)return;try{await api('/api/treasures/archive',{channelKey:state.selectedChannel,id:selectedTreasure.id,archived:!selectedTreasure.archived});$('#treasureDetail').close();await loadTreasures();await refresh()}catch(e){notice(e.message)}});
$('#saveTreasure').addEventListener('click',()=>{$('#saveTreasureStatus').textContent='';$('#saveTreasureDialog').showModal()});$('#closeSaveTreasure').addEventListener('click',()=>$('#saveTreasureDialog').close());
$('#saveTreasureForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{const values=Object.fromEntries(new FormData(form));const t=await api('/api/treasures/save',{...values,channelKey:state.selectedChannel});$('#saveTreasureDialog').close();notice('已珍藏：【'+t.title+'】');form.reset();await refresh()}catch(e){$('#saveTreasureStatus').textContent=e.message}finally{button.disabled=false}});
refresh(); setInterval(refresh, 1400);

function paintIcon(el,url,fallback){
  el.replaceChildren();
  if(url){const img=document.createElement('img');img.src=url;img.alt='';el.append(img)}else el.textContent=fallback;
}
function applyAppearance(a,force=false){
  if(!a)return;
  const signature=JSON.stringify(a);if(!force&&signature===appearanceSignature)return;appearanceSignature=signature;
  document.querySelector('.brand h1').textContent=a.name;
  document.title=a.name+' · 双助手工作台';
  paintIcon($('.brand .mark'),a.logo,'同');
  paintIcon($('.person .codex'),a.gptAvatar,'G');
  paintIcon($('.person .deepseek'),a.deepseekAvatar,'D');
  document.body.classList.toggle('custom-background',!!a.background);
  document.body.style.setProperty('--desk-background',a.background?`url("${a.background}")`:'none');
  document.body.style.setProperty('--desk-veil',String(1-a.backgroundStrength/100));
  let favicon=document.querySelector('link[rel="icon"]');
  if(!favicon){favicon=document.createElement('link');favicon.rel='icon';document.head.append(favicon)}
  favicon.href=a.logo||'/default-icon.svg';
}
let uploadSlot='',appearanceBusy=false;
const appearanceLabels={background:'聊天背景',logo:'工作台图标',gptAvatar:'Agent B / GPT 头像',deepseekAvatar:'Agent A / DeepSeek 头像'};
function renderAppearanceForm(a){
  $('#appearanceName').value=a.name;$('#backgroundStrength').value=a.backgroundStrength;$('#strengthValue').value=a.backgroundStrength+'%';
  const box=$('#appearanceSlots');box.replaceChildren();
  for(const [slot,label]of Object.entries(appearanceLabels)){
    const row=document.createElement('div');row.className='appearance-row';
    const preview=document.createElement('span');preview.className='appearance-preview';paintIcon(preview,a[slot],slot==='background'?'▧':label[0]);
    const title=document.createElement('strong');title.textContent=label;
    const upload=document.createElement('button');upload.type='button';upload.className='check';upload.textContent='选择图片';upload.onclick=()=>{if(appearanceBusy)return;uploadSlot=slot;$('#appearanceFile').click()};
    const clear=document.createElement('button');clear.type='button';clear.className='check';clear.textContent='恢复默认';clear.disabled=!a[slot];clear.onclick=()=>changeAppearance('/api/appearance/clear',{slot});
    row.append(preview,title,upload,clear);box.append(row);
  }
}
async function changeAppearance(url,body){
  if(appearanceBusy)return;appearanceBusy=true;$('#appearanceStatus').textContent='正在保存…';
  try{const a=await api(url,body);if(state)state.appearance=a;applyAppearance(a);renderAppearanceForm(a);lastRender='';$('#appearanceStatus').textContent='已保存，外观已更新。';await refresh()}
  catch(e){$('#appearanceStatus').textContent=e.message}
  finally{appearanceBusy=false}
}
$('#openAppearance').onclick=async()=>{await refresh();if(!state)return;renderAppearanceForm(state.appearance);$('#appearanceStatus').textContent='';$('#appearanceDialog').showModal()};
$('#closeAppearance').onclick=()=>$('#appearanceDialog').close();
$('#backgroundStrength').oninput=e=>{$('#strengthValue').value=e.target.value+'%';document.body.style.setProperty('--desk-veil',String(1-Number(e.target.value)/100))};
$('#appearanceDialog').addEventListener('close',()=>applyAppearance(state?.appearance,true));
$('#appearanceForm').onsubmit=e=>{e.preventDefault();changeAppearance('/api/appearance',{name:$('#appearanceName').value,backgroundStrength:Number($('#backgroundStrength').value)})};
$('#appearanceFile').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(file.size>5*1024*1024){$('#appearanceStatus').textContent='图片不能超过 5 MB';return}
  const slot=uploadSlot;
  try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(file)});await changeAppearance('/api/appearance/image',{slot,dataUrl})}
  catch(error){$('#appearanceStatus').textContent=error.message}
};
$('#resetAppearance').onclick=()=>{if(confirm('恢复默认名称、背景和所有图标？聊天和宝箱会保留。'))changeAppearance('/api/appearance/reset',{})};

