import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isChatModel } from './chat-policy.mjs';

// Official public-client flow: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const random = () => crypto.randomBytes(32).toString('base64url');
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', data, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function dpapi(value, decrypt = false) {
  // Pass secrets on stdin, never through command arguments or logs.
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); try { $o=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser) } catch { [Console]::Error.Write('DESK_DPAPI_UNAVAILABLE'); exit 2 }; [Console]::Out.Write([Convert]::ToBase64String($o))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(value).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2000000,
  });
  if (r.error || r.status !== 0 || !r.stdout.trim()) {
    const e = new Error('无法使用 Windows 保护 ChatGPT 登录信息，请从当前 Windows 账号正常启动工作台');
    if (String(r.stderr || '').includes('DESK_DPAPI_UNAVAILABLE')) e.code = 'E_DPAPI_UNAVAILABLE';
    throw e;
  }
  return Buffer.from(r.stdout.trim(), 'base64');
}
export class CredentialFile {
  constructor(dir, protect = dpapi) { this.file = path.join(dir, 'chatgpt-credentials.json'); this.protect = protect; }
  checkProtection() {
    if (process.platform === 'win32') {
      const probe = Buffer.from('shared-ai-desk-protection-check');
      if (!this.protect(this.protect(probe), true).equals(probe)) throw new Error('Windows 登录保护检查未通过，请从当前 Windows 账号重新启动工作台');
    }
  }
  read() {
    if (!fs.existsSync(this.file)) return { accounts: [], active: '' };
    const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (envelope.protection === 'windows-dpapi') return JSON.parse(this.protect(Buffer.from(envelope.value, 'base64'), true).toString('utf8'));
    if (process.platform === 'win32') throw new Error('ChatGPT 登录文件未受 Windows 保护，请移走此文件后重新登录');
    return envelope.value;
  }
  save(data) {
    const envelope = process.platform === 'win32'
      ? { protection: 'windows-dpapi', value: this.protect(Buffer.from(JSON.stringify(data))).toString('base64') }
      : { protection: 'file-mode-0600', value: data };
    write(this.file, JSON.stringify(envelope));
  }
}
export function verifyIdentity(token, jwks, { clientId, nonce, subject, now = Date.now() / 1000 }) {
  const fail = () => { throw new Error('OpenAI 登录身份验证失败，请重新登录'); };
  try {
    const parts = token.split('.'); if (parts.length !== 3) return fail();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || header.crit) return fail();
    const key = jwks.keys?.find(k => k.kid === header.kid && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig') && k.kty === (header.alg === 'RS256' ? 'RSA' : 'EC'));
    if (!key || (header.alg === 'ES256' && key.crv !== 'P-256')) return fail();
    const pub = crypto.createPublicKey({ key, format: 'jwk' });
    if (!crypto.verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: pub, ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) }, Buffer.from(parts[2], 'base64url'))) return fail();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== AUTH || !aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId)
      || !Number.isFinite(claims.exp) || claims.exp < now - 5 || !Number.isFinite(claims.iat) || claims.iat > now + 5
      || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 5))
      || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce) || (subject && claims.sub !== subject)) return fail();
    return claims;
  } catch { return fail(); }
}
function planAllowed(account) { return !!account?.access_token && String(account.scope || '').split(/\s+/).includes(PLAN_SCOPE); }
async function readJson(response) {
  try { return await response.json(); } catch { throw new Error('OpenAI 返回了无法识别的响应，请重试'); }
}
function apiError(status, code = '') {
  if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code) || status === 429)
    return new Error('ChatGPT 订阅额度暂不可用或已到上限，请打开 ChatGPT 用量设置查看；程序不会自动改用付费 API');
  if (status === 401 || status === 403) return new Error('ChatGPT 授权不可用，请重新登录并允许使用订阅额度');
  return new Error(`ChatGPT 请求未完成${status ? `（HTTP ${status}）` : ''}，请稍后重试`);
}
export async function readResponseStream(response) {
  if (!response.body || !String(response.headers.get('content-type')).includes('text/event-stream')) throw new Error('ChatGPT 未返回预期的文字流');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', completed = false, size = 0;
  function event(block) {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let e; try { e = JSON.parse(data); } catch { throw new Error('ChatGPT 返回了无法识别的文字流'); }
    if (e.type === 'response.failed' || e.type === 'error') throw apiError(0, e.response?.error?.code || e.code || e.error?.code);
    if (e.type === 'response.incomplete') throw new Error('ChatGPT 回答未完整生成，请重试');
    const item = e.item;
    if (item?.type && !['message', 'reasoning'].includes(item.type)) throw new Error('当前 ChatGPT 连接仅支持文字聊天，没有执行工具');
    if (e.type === 'response.output_text.delta') text += e.delta || '';
    if (e.type === 'response.refusal.delta') text += e.delta || '';
    if (e.type === 'response.completed') {
      if (e.response?.status && e.response.status !== 'completed') throw new Error('ChatGPT 回答未完成');
      if ((e.response?.output || []).some(i => !['message','reasoning'].includes(i.type))) throw new Error('当前 ChatGPT 连接仅支持文字聊天，没有执行工具');
      if (!text) text = (e.response?.output || []).flatMap(i => i.content || []).map(c => c.text || c.refusal || '').join('');
      completed = true;
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      size += value.length; if (size > 8000000) throw new Error('ChatGPT 返回内容过长');
      buffer += decoder.decode(value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
      let index; while ((index = buffer.indexOf('\n\n')) >= 0) { event(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
      if (completed) break;
    }
    if (!completed && buffer.trim()) event(buffer);
    if (!completed || !text.trim()) throw new Error('ChatGPT 连接中断或没有完整文字答复，请重试');
    return text;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class ChatGPTPlan {
  constructor(dir, { fetchImpl = fetch, store = new CredentialFile(dir) } = {}) {
    this.fetch = fetchImpl; this.store = store; this.pending = null; this.error = ''; this.refreshes = new Map();
    const hostFile = path.join(dir, 'chatgpt-host.json');
    if (fs.existsSync(hostFile)) this.hostId = JSON.parse(fs.readFileSync(hostFile, 'utf8')).id;
    else { this.hostId = 'urn:uuid:' + crypto.randomUUID(); write(hostFile, JSON.stringify({ id: this.hostId })); }
    // Decrypt on demand so existing users need not authorize or invoke DPAPI to start the app.
    this.data = null;
  }
  load() { return this.data ||= this.store.read(); }
  account() { const d = this.load(); return d.accounts.find(a => a.client_id === d.active); }
  save() { this.store.save(this.load()); }
  status() {
    try {
      const d = this.load(), a = this.account();
      return { active: d.active, accounts: d.accounts.map(a => ({ id: a.client_id, label: a.email || a.name || '已保存的 ChatGPT 账号', signedIn: !!a.access_token })),
        signedIn: !!a?.access_token, planEnabled: planAllowed(a), welcome: planAllowed(a) && !a.welcomed,
        pending: !!this.pending && this.pending.expires > Date.now(), error: this.error, usageUrl: USAGE_URL };
    } catch { return { signedIn: false, planEnabled: false, accounts: [], error: '无法读取受保护的 ChatGPT 登录信息，请从原 Windows 账号打开工作台', usageUrl: USAGE_URL }; }
  }
  begin(baseUrl, selected = this.load().active) {
    // Fail before the user grants a renewable token if this process cannot protect it.
    this.store.checkProtection?.();
    const callback = new URL('/auth/callback', baseUrl);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1') throw new Error('ChatGPT 登录只能回到本机工作台');
    const a = selected ? this.load().accounts.find(a => a.client_id === selected) : null;
    if (selected && !a) throw new Error('请选择已保存账号或添加其他账号');
    const p = { state: random(), nonce: random(), verifier: random(), redirect: callback.href, clientId: a?.client_id, subject: a?.sub, expires: Date.now() + 10 * 60000 };
    const url = new URL(AUTH + '/api/accounts/authorize');
    url.search = new URLSearchParams({ client_id: p.clientId || 'dynamic_agent_client', ext_agent_host_id: this.hostId,
      response_type: 'code', redirect_uri: p.redirect, scope: 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE,
      resource: RESOURCE, state: p.state, nonce: p.nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(p.verifier).digest('base64url'),
      ...(!p.clientId ? { agent_name_hint: '同桌 · 双助手工作台' } : {}),
      ...(a?.id_token ? { id_token_hint: a.id_token } : {}), ...(a?.email ? { login_hint: a.email } : {}),
    }).toString();
    this.pending = p; this.error = ''; return url.href;
  }
  async request(url, options = {}) {
    try { return await this.fetch(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(20000) }); }
    catch { throw new Error('无法连接 OpenAI，请检查网络后重试'); }
  }
  async token(body) {
    const r = await this.request(AUTH + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...body, resource: RESOURCE }).toString() });
    if (!r.ok) throw new Error(r.status >= 500 ? 'OpenAI 登录服务暂不可用，请稍后重试' : 'ChatGPT 授权已失效或未完成，请重新登录');
    const t = await readJson(r);
    if (typeof t.access_token !== 'string' || !t.access_token || t.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(t.expires_in) || t.expires_in <= 0) throw new Error('ChatGPT 授权响应不完整，请重新登录');
    return t;
  }
  async callback(url) {
    const p = this.pending, q = url.searchParams;
    if (!p || p.expires < Date.now() || q.get('state') !== p.state) throw new Error('登录请求已过期或不匹配，请回到工作台重新登录');
    this.pending = null;
    try {
      if (q.has('error')) throw new Error('未完成 ChatGPT 授权；可以回到工作台重新登录');
      const clientId = q.get('client_id') || p.clientId;
      if (!clientId || clientId === 'dynamic_agent_client' || (p.clientId && clientId !== p.clientId) || !q.get('code')) throw new Error('ChatGPT 注册未完成，请重新登录');
      const t = await this.token({ grant_type: 'authorization_code', client_id: clientId, code: q.get('code'), code_verifier: p.verifier, redirect_uri: p.redirect });
      const keys = await this.request(AUTH + '/.well-known/jwks.json'); if (!keys.ok) throw new Error('暂时无法验证 OpenAI 登录身份，请重试');
      const claims = verifyIdentity(t.id_token, await readJson(keys), { clientId, nonce: p.nonce, subject: p.subject });
      const d = this.load(), prior = d.accounts.find(a => a.client_id === clientId);
      if (prior && prior.sub !== claims.sub) throw new Error('返回的 ChatGPT 账号不匹配，请重新登录');
      const a = { client_id: clientId, sub: claims.sub, email: claims.email || '', name: claims.name || '',
        ...this.tokens(t), id_token: t.id_token, welcomed: prior?.welcomed || false };
      d.accounts = d.accounts.filter(a => a.client_id !== clientId); d.accounts.push(a); d.active = clientId; this.save(); this.error = '';
      return { planEnabled: planAllowed(a) };
    } catch (e) { this.error = e.message; throw e; }
  }
  tokens(t, previous = {}) {
    return { access_token: t.access_token, refresh_token: t.refresh_token || previous.refresh_token || '', scope: t.scope ?? previous.scope ?? '', expires_at: Date.now() + t.expires_in * 1000 };
  }
  select(clientId) {
    if (!this.load().accounts.some(a => a.client_id === clientId)) throw new Error('请选择已保存的 ChatGPT 账号');
    this.load().active = clientId; this.error = ''; this.save();
  }
  acknowledge() { const a = this.account(); if (a) { a.welcomed = true; this.save(); } }
  async access(a = this.account()) {
    if (!planAllowed(a)) throw new Error('请先使用 ChatGPT 登录，并在 OpenAI 页面允许使用订阅额度');
    if (a.expires_at > Date.now() + 60000) return a.access_token;
    if (!a.refresh_token) throw new Error('ChatGPT 登录已过期，请重新登录');
    if (!this.refreshes.has(a.client_id)) {
      const task = (async () => {
        const old = a.refresh_token;
        const t = await this.token({ grant_type: 'refresh_token', client_id: a.client_id, refresh_token: old });
        if (a.refresh_token !== old || !a.access_token) throw new Error('ChatGPT 账号已退出，请重新登录');
        Object.assign(a, this.tokens(t, a)); this.save();
        if (!planAllowed(a)) throw new Error('ChatGPT 订阅额度权限已撤回，请重新授权');
        return a.access_token;
      })().finally(() => this.refreshes.delete(a.client_id));
      this.refreshes.set(a.client_id, task);
    }
    return this.refreshes.get(a.client_id);
  }
  async signOut() {
    this.pending = null; const a = this.account(); if (!a) return '当前没有登录账号';
    let revoked = true;
    if (a.refresh_token) {
      try {
        const discovery = await this.request(AUTH + '/.well-known/openid-configuration');
        if (!discovery.ok) throw new Error();
        const endpoint = new URL((await discovery.json()).revocation_endpoint);
        if (endpoint.origin !== AUTH || endpoint.username || endpoint.password) throw new Error();
        const r = await this.request(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: a.refresh_token, token_type_hint: 'refresh_token', client_id: a.client_id }).toString() });
        revoked = r.status === 200;
      } catch { revoked = false; }
    }
    for (const key of ['access_token','refresh_token','id_token','scope','expires_at']) delete a[key];
    this.save(); this.error = '';
    return revoked ? '已退出 ChatGPT，已清除本机登录凭据' : '已退出本机登录；未能确认远端撤销，请到 ChatGPT 设置中断开此应用';
  }
  async models(a = this.account()) {
    const token = await this.access(a);
    const r = await this.request(RESOURCE + '/models', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw apiError(r.status);
    const data = await readJson(r);
    if (!Array.isArray(data.models)) throw new Error('ChatGPT 模型列表格式不兼容，请稍后重试');
    return data.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string' && isChatModel({ id: m.slug, name: m.display_name })).map(m => ({ id: m.slug, name: m.display_name || m.slug }));
  }
  async chat(model, prompt, timeoutSeconds = 180) {
    // Validate against the active account's current catalog, including saved selections.
    const account = this.account();
    const models = await this.models(account); const selected = model || models[0]?.id;
    if (!selected || !models.some(m => m.id === selected)) throw new Error('请刷新并选择当前 ChatGPT 账号可用的文字模型');
    const token = await this.access(account);
    const r = await this.request(RESOURCE + '/responses', { method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutSeconds, 180) * 1000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selected, instructions: '按照用户工作台的角色设定和共享文字记录回答。只进行文字交流，不调用工具，不声称执行了任务。',
        input: [{ role: 'user', content: prompt }], store: false, stream: true, tools: [] }) });
    if (!r.ok) { let code; try { code = (await r.json()).error?.code; } catch {} throw apiError(r.status, code); }
    return readResponseStream(r);
  }
}
