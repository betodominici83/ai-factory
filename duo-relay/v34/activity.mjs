import fs from 'node:fs';
import {statePath} from './paths.mjs';
const events=[];const max=120;const f=()=>statePath('activity-v34.jsonl');
export function activity(type,message,meta={}){const e={at:new Date().toISOString(),type:String(type||'INFO'),message:String(message||''),...meta};events.push(e);while(events.length>max)events.shift();try{fs.appendFileSync(f(),JSON.stringify(e)+'\n','utf8')}catch{}return e}
export function recentActivity(limit=18){return events.slice(-Math.max(1,Math.min(Number(limit)||18,60))).reverse()}
export function loadRecentActivity(){try{const lines=fs.readFileSync(f(),'utf8').trim().split(/\r?\n/).slice(-max);for(const line of lines){try{events.push(JSON.parse(line))}catch{}}while(events.length>max)events.shift()}catch{}}
loadRecentActivity();
