import { isChatModel } from './chat-policy.mjs';

export const AGENT_DEFAULTS = {
  agentRouting: 'legacy', agentGroupRouting: false,
  deepseekAgentName: 'DeepSeek', codexAgentName: 'GPT',
  deepseekAgentBackend: 'harness', codexAgentBackend: 'codex',
  deepseekAgentModel: '', codexAgentModel: '',
};
export const AGENT_BACKENDS = ['harness', 'deepseek-api', 'codex', 'chatgpt'];
export const agentPrefix = soul => soul === 'codex' ? 'codex' : 'deepseek';
export function agentName(config, soul) {
  return config.agentRouting === 'custom' ? config[agentPrefix(soul) + 'AgentName'] : soul === 'codex' ? 'GPT' : 'DeepSeek';
}
export const usesAgentRouting = (config, isGroup = false) => config.agentRouting === 'custom' && (!isGroup || config.agentGroupRouting);
export function agentSpec(config, soul) {
  const prefix = agentPrefix(soul);
  return { name: agentName(config, soul), backend: config[prefix + 'AgentBackend'], model: config[prefix + 'AgentModel'] };
}
export function validateAgents(config) {
  if (!['legacy', 'custom'].includes(config.agentRouting)) throw new Error('请选择原有连接或自定义双 Agent');
  const names = ['deepseek', 'codex'].map(soul => config[soul + 'AgentName']);
  for (const name of names) if (!name || name.length > 24 || /[\r\n\t<>\[\]【】/@]/.test(name) || ['你', '系统', '连接提示', '快捷指令'].includes(name)) throw new Error('Agent 名称需为 1—24 字，不能包含括号、斜线或控制符');
  if (names[0].toLowerCase() === names[1].toLowerCase()) throw new Error('两位 Agent 需要不同的名字');
  if (/^(gpt|chatgpt|codex)$/i.test(names[0]) || /^deepseek$/i.test(names[1])) throw new Error('请避免使用另一位角色的快捷名称，以免指名时混淆');
  for (const soul of ['deepseek', 'codex']) {
    const { backend, model } = agentSpec(config, soul);
    if (!AGENT_BACKENDS.includes(backend)) throw new Error('请选择有效的 Agent 接入来源');
    if (model.length > 500 || /[\r\n\0]/.test(model)) throw new Error('Agent 模型格式不正确');
    if (config.agentRouting === 'custom' && !model) throw new Error('请读取模型列表，并为两位 Agent 分别选择模型');
    if (model && backend === 'harness') {
      let pair;try { pair = JSON.parse(model); } catch { throw new Error('请选择 Harness 列表中的 Agent 模型'); }
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(s => typeof s !== 'string' || !s || s.length > 200) || !isChatModel({ id: pair[1] })) throw new Error('请选择 Harness 列表中的文字模型');
    } else if (model && !isChatModel({ id: model })) throw new Error('Agent 讨论只能选择文字模型');
    if (config.agentRouting === 'custom' && config.agentGroupRouting && backend === 'codex') throw new Error('群聊不能调用本地 Codex；请取消“群聊也使用这组模型”，或改选纯文字接入来源');
  }
  return config;
}

// Each invocation receives only its own role card plus the bounded shared
// history. Provider selection never changes the role's stable identity.
export async function runAgent(config, soul, history, instruction, isGroup, adapters) {
  const spec = agentSpec(config, soul);
  if (!spec.model) throw new Error('请先为这位 Agent 选择模型');
  if (isGroup && spec.backend === 'codex') throw new Error('群聊不能调用本地 Codex');
  const adapter = adapters[spec.backend];
  if (!adapter) throw new Error('Agent 接入来源不可用');
  return adapter(spec, config, soul, structuredClone(history), instruction, isGroup);
}
