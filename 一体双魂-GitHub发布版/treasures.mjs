import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp, typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);
}
function folder(scope) {
  if(scope==='private')return '私聊';
  if(/^group:[1-9]\d{4,11}$/.test(scope))return '群聊-'+scope.slice(6);
  throw new Error('宝箱会话不正确');
}
function words(text) {
  const value=String(text).normalize('NFKC').toLowerCase();
  const terms=value.match(/[a-z0-9_]{2,}/g)||[];
  for(const part of value.match(/[\p{Script=Han}]+/gu)||[])for(let i=0;i<part.length-1;i++)terms.push(part.slice(i,i+2));
  const stop=new Set(['我们','你们','什么','怎么','可以','这个','那个','记得','以前','之前','回忆','宝藏']);
  return [...new Set(terms.filter(t=>!stop.has(t)))].slice(0,250);
}
function hideSecrets(text) {
  return String(text).replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[密钥已隐藏]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,'$1[令牌已隐藏]')
    .replace(/((?:access[_-]?token|api[_-]?key|password|密码|验证码)\s*["']?\s*[:：=]\s*["']?)[^\s"',，；;]{4,}/gi,'$1[已隐藏]');
}
function clean(value,max) {return hideSecrets(typeof value==='string'?value:'').trim().slice(0,max)}
function digest(value) {return crypto.createHash('sha256').update(value).digest('hex')}
function markdown(t) {
  return `# 【宝藏】${t.title}\n\n保存于：${t.createdAt}\n来源：${t.scope==='private'?'私人会话':t.scope} · ${t.decision==='both'?'双魂共同珍藏':'你手动珍藏'}\n状态：${t.archived?'已移出自动回忆':'参与自动回忆'}\n\n## 回忆摘要\n\n${t.summary}\n\n标签：${t.tags.join('、')}\n\n## 珍藏原因\n\n${t.reasons.map(r=>r.soul+'：'+r.text).join('\n\n')}\n\n## 对话原文\n\n${t.messages.map(m=>`### ${m.speaker} · ${m.at}\n\n${m.text}`).join('\n\n')}\n`;
}
export class TreasureBox {
  constructor(root) {this.root=root;fs.mkdirSync(root,{recursive:true});this.warning='';this.cache=new Map();}
  records(scope) {
    this.warning='';const dir=path.join(this.root,folder(scope));if(!fs.existsSync(dir))return [];
    const stamp=fs.statSync(dir).mtimeMs,cached=this.cache.get(scope);
    if(cached?.stamp===stamp){this.warning=cached.warning;return cached.records;}
    const result=[];let damaged=0;
    for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))) {
      try {const t=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
        if(t.version!==1||t.scope!==scope||!Array.isArray(t.messages)||typeof t.id!=='string'||typeof t.title!=='string'||typeof t.summary!=='string'
          ||typeof t.createdAt!=='string'||!Number.isFinite(Date.parse(t.createdAt))||!Array.isArray(t.tags)||t.tags.some(v=>typeof v!=='string')
          ||t.messages.some(m=>!m||typeof m.text!=='string'||typeof m.speaker!=='string'||!['user','assistant'].includes(m.role)))throw new Error();
        result.push({...t,_file:path.join(dir,name)})}catch{damaged++;}
    }
    this.warning=damaged?`${damaged} 件宝藏暂时无法读取，原文件已保留。`:'';
    result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));this.cache.set(scope,{stamp,records:result,warning:this.warning});return result;
  }
  list(scope,query='',includeArchived=false) {
    const q=String(query).trim().toLowerCase();
    return this.records(scope).filter(t=>(includeArchived||!t.archived)&&(!q||[t.title,t.summary,...t.tags,...t.messages.map(m=>m.text)].join('\n').toLowerCase().includes(q)))
      .map(({_file,messages,reasons,...t})=>({...t,messageCount:messages.length}));
  }
  get(scope,id) {
    const t=this.records(scope).find(t=>t.id===id);if(!t)throw new Error('未找到当前会话的宝藏');
    const {_file,...record}=t;return record;
  }
  save({scope,messages,title,summary,tags=[],reasons=[],decision='manual'}) {
    folder(scope);
    if(!['manual','both'].includes(decision))throw new Error('珍藏来源不正确');
    if(decision==='both'&&(reasons.length!==2||!['deepseek','codex'].every(s=>reasons.some(r=>r.soul===s&&r.text))))throw new Error('自动珍藏需要双魂共识');
    const selected=messages.filter(m=>['user','assistant'].includes(m.role)&&m.kind!=='error').slice(-12).map(m=>({id:m.id,role:m.role,speaker:clean(m.speaker,80),at:m.at,text:hideSecrets(m.text)}));
    const lastUser=selected.findLast(m=>m.role==='user');if(!lastUser)throw new Error('当前还没有可珍藏的对话');
    const sourceKey=digest(scope+'\0'+(lastUser.id||lastUser.at+'\0'+lastUser.text));
    const normalizedTitle=clean(title,80)||'值得记住的这一天',normalizedSummary=clean(summary,1200)||clean(lastUser.text,300);
    const meaningKey=digest((normalizedTitle+'\0'+normalizedSummary).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu,''));
    const previous=this.records(scope).find(t=>t.sourceKey===sourceKey||(decision==='both'&&t.meaningKey===meaningKey));
    if(previous)return {...this.get(scope,previous.id),alreadySaved:true};
    const now=new Date().toISOString(),id=crypto.randomUUID();
    const t={version:1,id,scope,sourceKey,meaningKey,createdAt:now,archived:false,decision,title:normalizedTitle,
      summary:normalizedSummary,tags:[...new Set(tags.filter(x=>typeof x==='string').map(x=>clean(x,24)).filter(Boolean))].slice(0,8),
      reasons:reasons.map(r=>({soul:r.soul,text:clean(r.text,300)})),messages:selected};
    const safeTitle=t.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,38)||'未命名';
    const file=path.join(this.root,folder(scope),`【宝藏】${now.slice(0,10)}-${safeTitle}-${id.slice(0,8)}.json`);
    atomic(file,t);atomic(file.replace(/\.json$/,'.md'),markdown(t));this.cache.delete(scope);return t;
  }
  archive(scope,id,archived) {
    const t=this.records(scope).find(t=>t.id===id);if(!t)throw new Error('未找到当前会话的宝藏');
    const {_file,...record}=t;record.archived=archived===true;atomic(_file,record);atomic(_file.replace(/\.json$/,'.md'),markdown(record));this.cache.delete(scope);return record;
  }
  recall(scope,query,budget=6000) {
    const terms=words(query), recallIntent=/记得|回忆|以前|那天|之前|宝藏|曾经/.test(query);
    const scored=this.records(scope).filter(t=>!t.archived).map(t=>{
      const headline=[t.title,t.summary,...t.tags].join(' ').toLowerCase(),body=t.messages.map(m=>m.text).join(' ').toLowerCase();
      const score=terms.reduce((n,w)=>n+(headline.includes(w)?4:0)+(body.includes(w)?1:0),0);
      return {t,score};
    }).filter(x=>x.score>0||recallIntent).sort((a,b)=>b.score-a.score||b.t.createdAt.localeCompare(a.t.createdAt)).slice(0,3);
    let text='',used=[];
    for(const {t,score} of scored) {
      const excerpts=t.messages.map((m,i)=>({m,i,score:terms.reduce((n,w)=>n+(m.text.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score||b.i-a.i).slice(0,3).sort((a,b)=>a.i-b.i);
      const item=JSON.stringify({id:t.id,date:t.createdAt,title:t.title,relevance:score>0?'话题匹配':'仅按时间找到，需向用户确认',summary:t.summary,
        originalExcerpts:excerpts.map(({m})=>({speaker:m.speaker,at:m.at,text:m.text.slice(0,900)}))});
      if(text.length+item.length+1>budget)continue;text+=item+'\n';used.push({id:t.id,title:t.title,date:t.createdAt});
    }
    return {text,used};
  }
}
