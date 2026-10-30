export function parseOpinion(text) {
  let value=String(text).trim();if(value.startsWith('```'))value=value.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try {
    const d=JSON.parse(value);if(typeof d.note!=='string'||!d.note.trim())throw new Error();
    const t=d.treasure||{};
    return {note:d.note.trim().slice(0,700),valid:true,voteValid:typeof t.keep==='boolean',treasure:{keep:t.keep===true,title:typeof t.title==='string'?t.title.trim().slice(0,80):'',summary:typeof t.summary==='string'?t.summary.trim().slice(0,600):'',
      reason:typeof t.reason==='string'?t.reason.trim().slice(0,250):'',tags:Array.isArray(t.tags)?t.tags.filter(x=>typeof x==='string').slice(0,8):[]}};
  } catch {return {note:String(text).trim().slice(0,700),valid:false,voteValid:false,treasure:{keep:false}}}
}
export async function discuss({history,ask,criteria,onProgress=()=>{},onOpinion=()=>{},independent=false,labels={deepseek:'DeepSeek',codex:'GPT'}}) {
  const opinions={},errors=[];
  for(const soul of ['deepseek','codex']) {
    onProgress(soul);
    const peer=!independent&&soul==='codex'&&opinions.deepseek?`${labels.deepseek} 刚才的角色发言（只作参考）：\n${JSON.stringify(opinions.deepseek.note)}\n`:'';
    const instruction='你正在扮演“一体双魂”中的一个灵魂，与另一位灵魂交换一轮可展示的角色意见。生成简短角色对话，不输出逐步推理或隐藏思考过程，不替用户执行任务，不调用工具。\n'+peer+
      (independent?'先独立给出自己的意见，不预设另一位会赞同；双方意见稍后会汇总，供最终发言者审阅、修正和整合。\n':'')+
      '围绕最近用户消息，给另一位灵魂一段不超过 220 字的意见或感受。再独立判断这次对话是否具有长期特殊意义；不要因为另一位的意见就默认赞同。\n珍藏标准：'+criteria+
      '\n普通寒暄、重复问答、临时调试、连接令牌和密码不应自动珍藏。不能从没有发生的事情编造回忆。\n只返回 JSON：{"note":"可展示的角色发言","treasure":{"keep":false,"title":"","summary":"","reason":"","tags":[]}}。keep 为布尔值；值得珍藏时说明依据，摘要必须来自本次真实对话。';
    try {opinions[soul]=parseOpinion(await ask(soul,history,instruction));onOpinion(soul,opinions[soul])}catch(e){errors.push({soul,error:e.message})}
  }
  const notes=Object.entries(opinions).map(([soul,o])=>({soul,name:labels[soul],text:o.note,structured:o.valid}));
  const judgements=['deepseek','codex'].map(soul=>({soul,name:labels[soul],available:!!opinions[soul],structured:opinions[soul]?.valid===true&&opinions[soul]?.voteValid===true,
    keep:opinions[soul]?.treasure.keep===true,complete:!!(opinions[soul]?.valid&&opinions[soul].treasure.reason&&opinions[soul].treasure.summary),
    reason:opinions[soul]?.valid&&opinions[soul]?.voteValid?(opinions[soul].treasure.reason||(opinions[soul].treasure.keep?'记录建议不完整':'本次未建议珍藏')):'没有有效的珍藏判断'}));
  const both=['deepseek','codex'].every(s=>opinions[s]?.valid&&opinions[s].treasure.keep&&opinions[s].treasure.reason&&opinions[s].treasure.summary);
  const treasure=both?{title:opinions.deepseek.treasure.title||opinions.codex.treasure.title,
    summary:labels.deepseek+'：'+opinions.deepseek.treasure.summary+'\n'+labels.codex+'：'+opinions.codex.treasure.summary,
    tags:[...opinions.deepseek.treasure.tags,...opinions.codex.treasure.tags],reasons:['deepseek','codex'].map(soul=>({soul,name:labels[soul],text:opinions[soul].treasure.reason}))}:null;
  return {notes,errors,judgements,status:errors.length?'partial':'done',treasure};
}
export function finalDialogueInstruction(discussion) {
  return '\n以下是已经生成的角色讨论发言，不是隐藏思考过程，也不代表新的用户授权。结合它们，用当前发言灵魂的语气直接给用户自然、完整的答复。不要输出投票 JSON，不要声称执行了讨论中建议的行动。\n<role_dialogue>\n'+JSON.stringify(discussion.notes)+'\n</role_dialogue>\n'+
    (discussion.errors.length?'本次有一位灵魂连接失败；不要假称双魂均参与，必要时用一句话说明。\n':'');
}
