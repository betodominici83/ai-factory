import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';

const VERSION='34.0.0';
const TEST_ROOT=process.env.DUO_PATCH_TEST_ROOT||'';
const IS_WIN=process.platform==='win32'&&!TEST_ROOT;
const BASE=TEST_ROOT||'C:\\ROBOT\\DUO';
const V33=path.join(BASE,'WORKERS_V33');
const V34=path.join(BASE,'WORKERS_V34');
const DATA=TEST_ROOT?path.join(TEST_ROOT,'DUO_DATA','WORKERS'):'C:\\ROBOT\\DUO_DATA\\WORKERS';
const STATE=path.join(DATA,'state');
const BACKUPS=path.join(BASE,'BACKUPS');
const OVERRIDE_DIR=process.env.DUO_V34_OVERRIDE_DIR||'';
const RAW='https://raw.githubusercontent.com/betodominici83/ai-factory/duo-relay/duo-relay/v34/';
const MANIFEST={
 'src/edgeSessionRepair.mjs':'9419537cdeff49bf02705cd4731f4bd90c0b04579821b3f8525a426255a31669',
 'src/activity.mjs':'79965cf50f7bf79432b97942a5bbb8a3c1baf82b048825c9666d3c2e2cf67bf8',
 'src/browserManager.mjs':'23148040d3334a3914965115d7b4dfcf5cc3f39e3c0dc8ad2d42d5718a55b171',
 'src/server.mjs':'87b203a4251a39fc7b544d8b9475dd333fec70586714131630779c9aba5e5b56',
 'src/panel-console.mjs':'31f7c6e66644c852df52a07726bb2cd01b274a8fda18557a9e5f308375a22273',
 'config/settings.json':'c0291d191c487d2bd239a72ce7eb35b9faa1a97af9749b7cf56298b0533854d5',
 'test/run.mjs':'759fa6dfdd351910b8e67b4b6fd6df69061eceebc43b285b95302634baf82935',
 'tools/ui-check.mjs':'df68bccb4044e011e9512a7a0a533b26e50e8f839da99dbc17844eb9aeb92111',
 'tools/audit.mjs':'21f513f1b1d12a65c431d302120d12e25da35db45f5ae27ed3e259112e218856'
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=s=>console.log(s);
const die=s=>{throw new Error(s)};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const readText=f=>{try{return fs.readFileSync(f,'utf8').trim()}catch{return''}};
const readJson=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return null}};
const alive=pid=>{try{process.kill(Number(pid),0);return true}catch{return false}};
function requestJson(port,p='/api/health',timeout=3000){return new Promise(resolve=>{const q=http.get({host:'127.0.0.1',port,path:p,timeout},r=>{let s='';r.on('data',c=>{if(s.length<500000)s+=c});r.on('end',()=>{try{resolve({ok:r.statusCode===200,json:JSON.parse(s),status:r.statusCode})}catch{resolve({ok:false,error:'BAD_JSON',status:r.statusCode})}})});q.on('timeout',()=>{q.destroy();resolve({ok:false,error:'TIMEOUT'})});q.on('error',e=>resolve({ok:false,error:e.code||e.message}))})}
function download(url,redirects=4){return new Promise((resolve,reject)=>{const mod=url.startsWith('https:')?https:http;const q=mod.get(url,{headers:{'user-agent':'Dominici-DUO-V34-Promoter'}},r=>{if(r.statusCode>=300&&r.statusCode<400&&r.headers.location&&redirects>0){r.resume();return resolve(download(new URL(r.headers.location,url).href,redirects-1))}if(r.statusCode!==200){r.resume();return reject(new Error('HTTP_'+r.statusCode+' '+url))}const a=[];r.on('data',c=>a.push(c));r.on('end',()=>resolve(Buffer.concat(a)))});q.setTimeout(15000,()=>q.destroy(new Error('DOWNLOAD_TIMEOUT')));q.on('error',reject)})}
function replaceTree(root){const textExt=new Set(['.mjs','.js','.json','.cmd','.txt','.md']);const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='node_modules'||e.name==='.git')continue;const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(textExt.has(path.extname(e.name).toLowerCase())){let s;try{s=fs.readFileSync(f,'utf8')}catch{continue}const n=s.replaceAll('33.0.0','34.0.0').replaceAll('V33','V34').replaceAll('v33','v34');if(n!==s)fs.writeFileSync(f,n,'utf8')}}};walk(root)}
async function getOverride(rel){let b;if(OVERRIDE_DIR){b=fs.readFileSync(path.join(OVERRIDE_DIR,...rel.split('/')))}else b=await download(RAW+encodeURIComponent(path.basename(rel)));const got=sha(b),want=MANIFEST[rel];if(got!==want)die(`OVERRIDE_HASH_FAIL ${rel} got=${got} want=${want}`);return b}
function runNode(args,cwd,env={},timeout=120000){const r=spawnSync(process.execPath,args,{cwd,env:{...process.env,...env},encoding:'utf8',timeout,windowsHide:true});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);if(r.status!==0)die(`COMMAND_FAIL node ${args.join(' ')} status=${r.status}`);return r}
function reg(args){if(!IS_WIN)return {status:0};return spawnSync('reg.exe',args,{encoding:'utf8',timeout:10000,windowsHide:true})}
async function stopVerified(v){const pf=path.join(STATE,`workers-v${v}.port`),hf=path.join(STATE,`supervisor-v${v}-heartbeat.json`);const port=Number(readText(pf))||0,hb=readJson(hf);if(!port||!hb?.pid)return {stopped:false,reason:'NO_MARKERS'};const h=await requestJson(port);if(!h.ok||String(h.json?.version||'').split('.')[0]!==String(v)||!alive(hb.pid))return {stopped:false,reason:'NOT_VERIFIED',port,pid:hb?.pid};try{process.kill(hb.pid,'SIGTERM')}catch{}await sleep(250);try{if(hb.workerPid&&alive(hb.workerPid))process.kill(hb.workerPid,'SIGTERM')}catch{};for(let i=0;i<20&&alive(hb.pid);i++)await sleep(250);try{if(alive(hb.pid))process.kill(hb.pid,'SIGKILL')}catch{};try{if(hb.workerPid&&alive(hb.workerPid))process.kill(hb.workerPid,'SIGKILL')}catch{};return {stopped:!alive(hb.pid),pid:hb.pid,workerPid:hb.workerPid||null,port}}
function startSupervisor(root,defer='0'){const p=spawn(process.execPath,[path.join(root,'src','supervisor.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,DUO_WORKERS_DATA:DATA,DUO_EDGE_REPAIR_DEFER_MS:defer}});p.unref();return p.pid}
async function waitV34(ms=50000){const end=Date.now()+ms,pf=path.join(STATE,'workers-v34.port');while(Date.now()<end){const port=Number(readText(pf))||0;if(port){const h=await requestJson(port);if(h.ok&&h.json?.version===VERSION)return {port,health:h.json}}await sleep(500)}return null}
async function rollbackV33(reason){log('ROLLBACK_REASON='+reason);try{await stopVerified(34)}catch{}if(fs.existsSync(path.join(V33,'src','supervisor.mjs'))){const pid=startSupervisor(V33,'0');log('ROLLBACK_V33_STARTED PID='+pid);if(IS_WIN){reg(['DELETE','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','DominiciDUOWorkersV34','/f']);reg(['ADD','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','DominiciDUOWorkersV33','/t','REG_SZ','/d',`"${process.execPath}" "${path.join(V33,'src','supervisor.mjs')}"`,'/f'])}}}
async function main(){
 log('============================================================');log(' DOMINICI DUO - OPF V34 SAFE PROMOTION');log('============================================================');
 fs.mkdirSync(STATE,{recursive:true});fs.mkdirSync(BACKUPS,{recursive:true});
 if(!fs.existsSync(path.join(V33,'src','server.mjs')))die('V33_SOURCE_NOT_FOUND');
 log('[1/9] CORE PREFLIGHT');if(IS_WIN){const c=await requestJson(8787,'/api/health',2500);if(!c.ok)die('CORE_8787_NOT_HEALTHY')}log('CORE_8787=PASS_UNTOUCHED');
 const stage=path.join(BASE,'WORKERS_V34_STAGE_'+Date.now());log('[2/9] CLONE V33 -> ISOLATED V34 STAGE');fs.cpSync(V33,stage,{recursive:true,force:true});replaceTree(stage);log('STAGE_CLONE=PASS '+stage);
 log('[3/9] VERIFIED V34 OVERRIDES');for(const rel of Object.keys(MANIFEST)){const b=await getOverride(rel);const f=path.join(stage,...rel.split('/'));fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);log(`HASH_PASS ${rel} ${MANIFEST[rel]}`)}
 log('[4/9] STATIC + UNIT + CMA TESTS');for(const f of fs.readdirSync(path.join(stage,'src')).filter(x=>x.endsWith('.mjs')))runNode(['--check',path.join('src',f)],stage,{},30000);const td=path.join(DATA,'promotion-test-'+Date.now());for(const a of [['test/run.mjs'],['tools/audit.mjs'],['tools/ui-check.mjs'],['tools/pipeline-selftest.mjs']])runNode(a,stage,{DUO_WORKERS_DATA:td,DUO_TEST_MODE:'1'},120000);log('PRE_PROMOTION_TESTS=PASS');
 if(TEST_ROOT){log('[TEST MODE] LIVE PROCESS PROMOTION SKIPPED');log('V34_DRY_RUN=PASS');return}
 log('[5/9] BACKUP TARGET + STOP VERIFIED VERSIONS ONLY');let backup=null;if(fs.existsSync(V34)){backup=path.join(BACKUPS,'WORKERS_V34_PRE_'+Date.now());fs.renameSync(V34,backup);log('BACKUP_V34='+backup)}const s34=await stopVerified(34),s33=await stopVerified(33);log('STOP_V34='+JSON.stringify(s34));log('STOP_V33='+JSON.stringify(s33));if(!s33.stopped&&s33.reason!=='NO_MARKERS')die('REFUSE_PROMOTION_V33_NOT_SAFELY_STOPPED');
 log('[6/9] ATOMIC PROMOTION');try{fs.renameSync(stage,V34)}catch{fs.cpSync(stage,V34,{recursive:true,force:true});fs.rmSync(stage,{recursive:true,force:true})}const panel=`@echo off\r\ntitle DUO WORK CENTER V34\r\n"${process.execPath}" "${path.join(V34,'src','panel-console.mjs')}"\r\n`;fs.writeFileSync(path.join(V34,'ABRIR_WORK_CENTER_V34.cmd'),panel,'ascii');log('PROMOTION_COPY=PASS');
 log('[7/9] START V34 WITH EDGE-REPAIR DEFER=90s');const pid=startSupervisor(V34,'90000');log('SUPERVISOR_V34_PID='+pid);const h=await waitV34();if(!h){await rollbackV33('V34_HEALTH_TIMEOUT');die('V34_HEALTH_TIMEOUT')}const st=await requestJson(h.port,'/api/status',5000);const j=st.json||{};if(!st.ok||j.version!==VERSION||j.workers?.enabled!==6||j.workers?.total!==6||!Array.isArray(j.activity)||j.browser?.selfRepairEnabled!==true||j.browser?.autoNewWindow!==false){await rollbackV33('V34_ACCEPTANCE_FAIL');die('V34_ACCEPTANCE_FAIL')}log('V34_HEALTH=PASS PORT='+h.port);log('WORKERS=PASS 6/6');log('ACTIVITY_STREAM=PASS');log('EDGE_SELF_REPAIR=PASS');log('EDGE_WINDOW_LOOP=OFF');
 log('[8/9] AUTOSTART + PANEL');reg(['DELETE','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','DominiciDUOWorkersV33','/f']);const val=`"${process.execPath}" "${path.join(V34,'src','supervisor.mjs')}"`;const rr=reg(['ADD','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','DominiciDUOWorkersV34','/t','REG_SZ','/d',val,'/f']);if(rr.status!==0){await rollbackV33('V34_AUTOSTART_FAIL');die('V34_AUTOSTART_FAIL')}try{const desk=path.join(process.env.USERPROFILE||'','Desktop');if(fs.existsSync(desk))fs.copyFileSync(path.join(V34,'ABRIR_WORK_CENTER_V34.cmd'),path.join(desk,'DUO WORK CENTER V34.cmd'))}catch{}
 log('[9/9] EVIDENCE');const record={at:new Date().toISOString(),version:VERSION,installRoot:V34,backup,healthPort:h.port,supervisorPid:pid,workers:6,activityStream:true,edgeSelfRepair:true,edgeRepairDeferredMs:90000,controlledEdgeRestartMax:1,newEdgeWindowLoop:false,core8787Untouched:true,rollbackV33Available:fs.existsSync(V33)};fs.writeFileSync(path.join(STATE,'V34_PROMOTION.json'),JSON.stringify(record,null,2),'utf8');
 log('============================================================');log('V34_PROMOTION=PASS');log('CORE_8787=UNTOUCHED');log('WORKERS=6/6');log('ACTIVITY_STREAM=ON');log('EDGE_SELF_REPAIR=AUTO_AFTER_90S_IF_REQUIRED');log('CONTROLLED_EDGE_RESTART_MAX=1_PER_BOOT');log('NEW_EDGE_WINDOW_LOOP=OFF');log('ROLLBACK_V33=READY');log('============================================================');
}
main().catch(e=>{console.error('V34_PROMOTION_FAIL',e.stack||e);process.exit(1)});
