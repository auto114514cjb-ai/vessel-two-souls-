import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DEFAULTS,loadJson} from './core.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const config={...DEFAULTS,...loadJson(path.join(root,'data','config.json'),{})};
const children=[];let stopping=false;
const port=Number(process.env.AI_DESK_PORT||17860),url=`http://127.0.0.1:${port}/`;
async function probe(address){try{return (await fetch(address,{signal:AbortSignal.timeout(1000)})).ok}catch{return false}}
function launch(file,args,cwd,label){console.log('正在启动：'+label);const child=spawn(file,args,{cwd,windowsHide:true,stdio:'inherit'});children.push(child);child.on('error',e=>console.error(label+'：'+e.message));return child}
function open(){if(process.platform==='win32'){const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>console.log(url))}}
function stop(exitCode=0){if(stopping)return;stopping=true;process.exitCode=exitCode;for(const child of children)child.kill();setTimeout(()=>process.exit(exitCode),1000).unref()}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('SIGHUP',stop);
if(Number(process.versions.node.split('.')[0])<22)throw new Error('请安装 Node.js 22 或更新版本');
if(process.argv.includes('--check')){if(!fs.existsSync(path.join(root,'server.mjs')))throw new Error('缺少 server.mjs');console.log('运行文件检查通过：'+process.version);process.exit(0)}
console.log('一体双魂 · 关闭此窗口会停止本次启动的服务。');
if(await probe(url)){console.log('已有工作台运行。');open();process.exit(0)}
// Optional existing local SnowLuma; the public distribution does not bundle it.
const snow=process.env.SNOWLUMA_HOME||path.join(root,'SnowLuma');
if(config.qqEnabled&&fs.existsSync(path.join(snow,'index.mjs'))){
  const file=path.join(snow,'config','runtime.json');let runtime={};
  try{if(fs.existsSync(file))runtime=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))}catch{console.log('SnowLuma 运行配置暂时无法读取，将先启动工作台。')}
  if(!await probe(`http://127.0.0.1:${runtime.webuiPort||5099}/`))launch(process.execPath,['index.mjs'],snow,'SnowLuma');
}
const harness=path.join(process.env.LOCALAPPDATA||'','Programs','DeepSeek Harness','DeepSeek Harness.exe');
if(config.deepseekBackend==='harness'&&config.harnessToken&&fs.existsSync(harness)&&!await probe(config.harnessUrl+'/health')){
  const child=spawn(harness,[],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>console.log('请手动打开 Harness'));child.unref();
}
const server=launch(process.execPath,['server.mjs'],root,'工作台');server.on('exit',code=>{if(!stopping)stop(code||0)});
for(let i=0;i<30&&!stopping;i++){if(await probe(url)){open();break}await new Promise(r=>setTimeout(r,500))}
console.log('工作台地址：'+url+'\n首次使用请打开“连接与设置”。Harness 桥接请使用独立安装入口。');

