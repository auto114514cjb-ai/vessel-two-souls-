import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Desk, ROLE_DEFAULTS, resolveCodex, runProcess } from './core.mjs';
import { harnessRequest } from './harness-client.mjs';
import { installHarness } from './install-harness.mjs';
import { discoverModels } from './models.mjs';
import { Appearance } from './appearance.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ dataDir = path.join(root, 'data'), providers = {} } = {}) {
  const desk = new Desk(dataDir, providers);
  const appearance=new Appearance(dataDir);
  const session = crypto.randomBytes(32).toString('hex');
  function reply(res, status, obj, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...extra }); res.end(JSON.stringify(obj));
  }
  async function readBody(req,limit=200000) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('请求需使用 JSON 格式');
    let size = 0, parts = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('内容太大'); parts.push(chunk); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return reply(res, 403, { error: '只允许本机访问' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const origin = req.headers.origin;
    if (origin && !allowedHosts.map(h => `http://${h}`).includes(origin)) return reply(res, 403, { error: '来源校验失败' });
    // Cross-site OAuth navigation has no local session cookie. The one-time state,
    // PKCE verifier and ID-token nonce bind it to a guarded local POST below.
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      let message;
      try {
        const result = await desk.chatgpt.callback(url);
        message = result.planEnabled ? 'ChatGPT 授权成功。请返回工作台选择模型并保存接入方式。' : '已验证账号，但未获得订阅额度权限。请返回工作台重新登录并允许使用订阅额度。';
      } catch (e) { message = e.message; }
      const escaped = message.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options':'nosniff' });
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ChatGPT 登录 · 一体双魂</title><h1>一体双魂 · ChatGPT 登录</h1><p>${escaped}</p><p><a href="/">返回工作台</a></p></html>`);
    }
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], ...Object.fromEntries(['default-icon.svg','default-background.svg','default-gpt.svg','default-deepseek.svg'].map(f=>['/'+f,[f,'image/svg+xml']])) };
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'Set-Cookie': `desk=${session}; HttpOnly; SameSite=Strict; Path=/`,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      return res.end(fs.readFileSync(path.join(root, 'public', file)));
    }
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim());
    if (!cookie.includes(`desk=${session}`)) return reply(res, 401, { error: '请刷新工作台页面' });
    if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, { ...desk.snapshot(), appearance:appearance.snapshot(), lastQQError: desk.lastQQError || '' });
    if(req.method==='GET'&&url.pathname==='/api/appearance')return reply(res,200,appearance.snapshot());
    if(req.method==='GET'&&url.pathname.startsWith('/appearance-assets/')){
      try{const asset=appearance.asset(url.pathname.slice('/appearance-assets/'.length));res.writeHead(200,{'Content-Type':asset.type,'Content-Length':asset.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"});return res.end(asset.bytes)}
      catch{return reply(res,404,{error:'图片不存在'})}
    }
    if(req.method==='GET'&&url.pathname==='/api/treasures'){
      try{return reply(res,200,desk.listTreasures(url.searchParams.get('channel')||undefined,url.searchParams.get('q')||'',url.searchParams.get('archived')==='1'))}
      catch(e){return reply(res,400,{error:e.message})}
    }
    if(req.method==='GET'&&url.pathname==='/api/treasure'){
      try{return reply(res,200,desk.getTreasure(url.searchParams.get('channel')||undefined,url.searchParams.get('id')))}
      catch(e){return reply(res,400,{error:e.message})}
    }
    if (req.method === 'GET' && url.pathname === '/api/export') return reply(res, 200,
      { exportedAt: new Date().toISOString(), messages: desk.state.messages }, { 'Content-Disposition': 'attachment; filename="shared-chat.json"' });
    if (req.method === 'GET' && url.pathname === '/api/roles/defaults') return reply(res, 200, ROLE_DEFAULTS);
    if (req.method === 'GET' && url.pathname === '/api/roles/export') return reply(res, 200,
      { format: 'shared-ai-desk.roles', version: 1, ...Object.fromEntries(Object.keys(ROLE_DEFAULTS).map(k => [k, desk.config[k]])) },
      { 'Content-Disposition': 'attachment; filename="shared-roles.json"' });
    if (req.method !== 'POST' || req.headers['x-local-request'] !== '1') return reply(res, 403, { error: '请求校验失败' });
    try {
      const body = await readBody(req,url.pathname==='/api/appearance/image'?7200000:200000);
      if(url.pathname==='/api/appearance')return reply(res,200,appearance.update(body));
      if(url.pathname==='/api/appearance/image')return reply(res,200,appearance.upload(body.slot,body.dataUrl));
      if(url.pathname==='/api/appearance/clear')return reply(res,200,appearance.clear(body.slot));
      if(url.pathname==='/api/appearance/reset')return reply(res,200,appearance.reset());
      if(url.pathname==='/api/treasures/save')return reply(res,200,desk.saveCurrentTreasure(body));
      if(url.pathname==='/api/treasures/archive')return reply(res,200,desk.archiveTreasure(body.channelKey,body.id,body.archived));
      if (url.pathname === '/api/chat') return reply(res, 202, { job: desk.submitComputer(body.text, body.mode, body.publishToGroup === true, body.channelKey) });
      if (url.pathname === '/api/channel') { desk.selectChannel(body.key); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/models') return reply(res, 200, await discoverModels(desk.config, desk.chatgpt, body.agentBackends || []));
      if (url.pathname === '/api/chatgpt/login') {
        if (desk.active) throw new Error('请等当前回答完成后再登录');
        return reply(res, 200, { url: desk.chatgpt.begin(`http://127.0.0.1:${port}`, body.clientId) });
      }
      if (url.pathname === '/api/chatgpt/select') {
        if (desk.active) throw new Error('请等当前回答完成后再切换账号');
        desk.chatgpt.select(body.clientId); return reply(res, 200, { ok:true });
      }
      if (url.pathname === '/api/chatgpt/logout') {
        if (desk.active) throw new Error('请等当前回答完成后再退出');
        return reply(res, 200, { detail: await desk.chatgpt.signOut() });
      }
      if (url.pathname === '/api/chatgpt/acknowledge') { desk.chatgpt.acknowledge(); return reply(res, 200, { ok:true }); }
      if (url.pathname === '/api/settings') { desk.updateConfig(body); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/new') { desk.newRoom(); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/harness/install') {
        if (desk.active) throw new Error('请等待当前工作完成后再安装桥接');
        const result = installHarness({ appRoot: path.dirname(desk.dir) });
        return reply(res, 200, { ok: true, detail: result.detail });
      }
      if (url.pathname === '/api/harness/sessions') return reply(res, 200, await harnessRequest(desk.config, '/sessions'));
      if (url.pathname === '/api/harness/link') { await desk.linkHarness(body.sessionId); return reply(res, 200, { ok: true }); }
      if (url.pathname === '/api/check/harness') {
        const result = await harnessRequest(desk.config, '/health');
        if (result.protocol !== 2) throw new Error('Harness 桥接协议不兼容，请在空闲时重开 Harness 加载新版插件');
        return reply(res, 200, { ok: true, detail: 'Harness 桥接连接正常，将沿用它的模型、工具和权限确认。' });
      }
      if (url.pathname === '/api/check/codex') {
        const command = resolveCodex(desk.config);
        await runProcess(command, ['--version'], { timeout: 10000 });
        await runProcess(command, ['login', 'status'], { timeout: 15000 });
        await desk.providers.codex({ ...desk.config, timeoutSeconds: Math.min(60, desk.config.timeoutSeconds) }, [{ role: 'user', speaker: '你', text: '连接自检，请只回复：连接成功。' }]);
        return reply(res, 200, { ok: true, detail: 'Codex 登录与实际回答检查通过。' });
      }
      if (url.pathname === '/api/check/snow') {
        const info = await desk.snow.call('get_login_info', {});
        if (!info?.user_id) throw new Error('SnowLuma 已连接，但 QQ 未登录');
        const status = await desk.snow.call('get_status', {});
        if (status?.online === false || status?.good === false) throw new Error('SnowLuma 接口正常，但 QQ 当前不在线或状态异常');
        return reply(res, 200, { ok: true, detail: `已连接机器人 QQ ${info.user_id}；请从私聊或允许的群发送一条消息验证实际收发。` });
      }
      return reply(res, 404, { error: '未找到此操作' });
    } catch (error) { return reply(res, 400, { error: error.message || '操作失败' }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  server.on('close', () => desk.snow.stop());
  return { server, desk };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AI_DESK_PORT || 17860);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AI_DESK_PORT 应为 1024—65535');
  const { server, desk } = createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已使用。请打开已有工作台，或设置 AI_DESK_PORT 后重试。` : '工作台启动失败：' + error.message);
    process.exitCode = 1; desk.snow.stop();
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    desk.connect(); console.log(`双助手工作台已启动：${url}\n保持此窗口运行，关闭窗口会停止电脑与 QQ 服务。`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
      opener.on('error', () => console.log('请手动打开上方网址。'));
    }
  });
  function stop() { desk.snow.stop(); server.close(); setTimeout(() => process.exit(0), 1000).unref(); }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
