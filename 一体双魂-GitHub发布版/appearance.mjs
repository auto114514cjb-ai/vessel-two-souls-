import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SLOTS=['background','logo','gptAvatar','deepseekAvatar'];
export const APPEARANCE_DEFAULTS={name:'一体双魂',backgroundStrength:55,background:null,logo:null,gptAvatar:null,deepseekAvatar:null};
const DEFAULT_IMAGES={background:'/default-background.svg',logo:'/default-icon.svg',gptAvatar:'/default-gpt.svg',deepseekAvatar:'/default-deepseek.svg'};
const ASSET=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;
function imageType(buffer){
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return ['png','image/png'];
  if(buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return ['jpg','image/jpeg'];
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return ['webp','image/webp'];
  if(buffer.length>=6&&['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6)))return ['gif','image/gif'];
  throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片，不支持 SVG 或其他文件');
}
export class Appearance {
  constructor(dataDir){this.file=path.join(dataDir,'appearance.json');this.dir=path.join(dataDir,'appearance-assets');
    this.value=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{...APPEARANCE_DEFAULTS};
  }
  snapshot(){return {...APPEARANCE_DEFAULTS,...this.value,...Object.fromEntries(SLOTS.map(s=>[s,ASSET.test(this.value[s]||'')?'/appearance-assets/'+this.value[s]:DEFAULT_IMAGES[s]]))};}
  save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.value,null,2),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);return this.snapshot();}
  update(input){
    const next={...this.value};
    if('name'in input){if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>40)throw new Error('工作台名称需为 1—40 字');next.name=input.name.trim();}
    if('backgroundStrength'in input){if(!Number.isInteger(input.backgroundStrength)||input.backgroundStrength<0||input.backgroundStrength>100)throw new Error('背景显示强度应为 0—100');next.backgroundStrength=input.backgroundStrength;}
    this.value=next;return this.save();
  }
  upload(slot,dataUrl){
    if(!SLOTS.includes(slot))throw new Error('图片用途不正确');
    if(typeof dataUrl!=='string')throw new Error('请选择本地图片');
    const match=dataUrl.match(/^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
    if(!match||match[1].length>7000000)throw new Error('图片格式不正确，或超过 5 MB');
    const buffer=Buffer.from(match[1],'base64');if(!buffer.length||buffer.length>5*1024*1024||buffer.toString('base64')!==match[1])throw new Error('图片格式不正确，或超过 5 MB');
    const [ext]=imageType(buffer),name=crypto.randomUUID()+'.'+ext;fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(path.join(this.dir,name),buffer,{mode:0o600});this.value={...this.value,[slot]:name};return this.save();
  }
  clear(slot){if(!SLOTS.includes(slot))throw new Error('图片用途不正确');this.value={...this.value,[slot]:null};return this.save();}
  reset(){this.value={...APPEARANCE_DEFAULTS};return this.save();}
  asset(name){if(!ASSET.test(name))throw new Error('图片不存在');const file=path.join(this.dir,name);if(!fs.existsSync(file))throw new Error('图片不存在');const bytes=fs.readFileSync(file),[,type]=imageType(bytes);return {bytes,type};}
}
