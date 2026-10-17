#!/usr/bin/env node
import fs from 'node:fs';import p from 'node:path';import crypto from 'node:crypto';
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(process.env.MOCK_STATE)),tag=args[2];
const value=flag=>args[args.indexOf(flag)+1],field=key=>args.find(arg=>arg.startsWith(key+'='))?.slice(key.length+1);let result;
if(args[0]==='api'){
 if(args.includes('POST')){
  const key=field('tag_name');result={id:Object.keys(state.releases).length+1,tag_name:key,target_commitish:field('target_commitish'),body:fs.readFileSync(field('body').slice(1),'utf8'),draft:true,prerelease:field('prerelease')==='true',assets:[],html_url:'https://example.invalid/'+key};state.releases[key]=result;
 }else if(args[1].includes('/releases/')&&!args[1].includes('/tags/'))result=Object.values(state.releases).find(release=>String(release.id)===args[1].split('/').at(-1));
 else if(args[1].includes('/releases?'))result=Object.values(state.releases).filter(release=>!release.draft);
 else if(!args[1].includes('/releases/tags/'))result={full_name:'mikastudhhn/chrome-extension-video',private:false};
 else {const key=args[1].split('/').at(-1);result=state.releases[key];if(!result||result.draft){process.stderr.write('(HTTP 404)');process.exit(1);}}
}else if(args[1]==='download'){
 const dir=value('--dir');fs.mkdirSync(dir,{recursive:true});fs.copyFileSync((fs.existsSync(p.join(state.root,'published',tag,value('--pattern'))) ? p.join(state.root,'published',tag,value('--pattern')) : p.join(state.root,value('--pattern'))),p.join(dir,value('--pattern')));
}else if(args[1]==='upload'){
 const file=args[3],name=p.basename(file),bytes=fs.readFileSync(file),dir=p.join(state.root,'published',tag);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(file,p.join(dir,name));
 state.releases[tag].assets.push({name,state:'uploaded',digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')});
}else if(args[1]==='edit'){state.releases[tag].draft=false;}
else throw Error('Unexpected mock operation');
(state.calls ??= []).push(args);fs.writeFileSync(process.env.MOCK_STATE,JSON.stringify(state));if(result)process.stdout.write(JSON.stringify(result));
