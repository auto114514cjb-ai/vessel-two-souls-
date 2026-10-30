import { spawn } from 'node:child_process';

// Consume the documented JSONL completion event. The CLI can keep flushing
// diagnostics after this event; a completed text reply need not wait for exit.
export function runCodexText(command, args, { cwd, env, input, timeout = 240000 }, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let buffer = '', answer = '', stderr = '', done = false, bytes = 0;
    const timer = setTimeout(() => finish(new Error('Codex 回答超时，请稍后重试')), timeout);
    function finish(error, text) {
      if (done) return; done = true; clearTimeout(timer);
      // This is a separate read-only text invocation, never a user's desktop task.
      try { child.kill(); } catch {}
      if (error) reject(error); else resolve(text);
    }
    function failure() {
      const message = /拒绝访问|access is denied|permission denied|os error 5/i.test(stderr)
        ? 'Codex 被系统拒绝访问，请从电脑正常启动工作台后再试'
        : /auth|login|登录|401|unauthorized/i.test(stderr)
          ? 'Codex 登录不可用，请先运行 Codex 登录'
          : 'Codex 连接未完成，请检查网络和模型权限后重试';
      finish(new Error(message));
    }
    function packet(line) {
      if (!line.trim() || done) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text;
      if (event.type === 'turn.failed' || event.type === 'error') {
        stderr += String(event.error?.message || event.message || ''); return failure();
      }
      if (event.type === 'turn.completed') {
        if (!answer.trim()) return finish(new Error('Codex 没有返回完整文字内容'));
        finish(null, answer);
      }
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (done) return; bytes += Buffer.byteLength(chunk);
      if (bytes > 8000000) return finish(new Error('Codex 返回内容过长'));
      buffer += chunk; let index;
      while ((index = buffer.indexOf('\n')) >= 0 && !done) { const line = buffer.slice(0,index); buffer = buffer.slice(index+1); packet(line); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', () => finish(new Error('无法启动 Codex，请检查程序路径')));
    child.on('close', () => { if (!done && buffer.trim()) packet(buffer); if (!done) failure(); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
