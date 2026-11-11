const http=require("node:http"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const ROOT="meowmaster100",PORT=+process.env.PORT||8080,DATA=process.env.DATA_DIR||"/tmp/catchat";
const ADMIN_PW=process.env.ADMIN_PASSWORD||"110921-fury";
if(ADMIN_PW.length<6){console.error("Set ADMIN_PASSWORD (6+ characters), add it under Environment on your host");process.exit(1)}
fs.mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(path.join(DATA,"meow.db"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,name TEXT,salt TEXT,hash TEXT,coins INTEGER DEFAULT 100,admin INTEGER DEFAULT 0,banned INTEGER DEFAULT 0,inv TEXT DEFAULT '{}',daily INTEGER DEFAULT 0,avatar TEXT DEFAULT '{}',photo TEXT DEFAULT '',pv INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,emoji TEXT,descr TEXT,price INTEGER,stock INTEGER);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,text TEXT,ts INTEGER,sys INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,pid TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS blocked(id TEXT PRIMARY KEY);`);
try{db.exec("ALTER TABLE items ADD COLUMN kind TEXT DEFAULT 'normal'")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN infinite INTEGER DEFAULT 0");db.exec("UPDATE players SET infinite=1 WHERE id='meowmaster100'")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN seller TEXT DEFAULT ''")}catch(e){}
const q=s=>db.prepare(s);
function addCol(table,name,def){
 const cols=q("PRAGMA table_info("+table+")").all();
 if(!cols.some(c=>c.name===name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addCol("players","muted","INTEGER DEFAULT 0");
addCol("players","muted_until","INTEGER DEFAULT 0");
addCol("messages","reply","INTEGER DEFAULT 0");
addCol("messages","edited","INTEGER DEFAULT 0");
addCol("messages","deleted","INTEGER DEFAULT 0");
addCol("messages","image","TEXT DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,pid TEXT,mime TEXT,b64 TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS polls(id INTEGER PRIMARY KEY AUTOINCREMENT,pid TEXT,name TEXT,question TEXT,options TEXT,ts INTEGER,closed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS poll_votes(poll_id INTEGER,pid TEXT,opt INTEGER,ts INTEGER,PRIMARY KEY(poll_id,pid));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,reporter TEXT,kind TEXT,target TEXT,reason TEXT,excerpt TEXT,status TEXT DEFAULT 'open',ts INTEGER,reviewer TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS mentions(id INTEGER PRIMARY KEY AUTOINCREMENT,mid INTEGER,pid TEXT,seen INTEGER DEFAULT 0,ts INTEGER);
CREATE TABLE IF NOT EXISTS reactions(mid INTEGER,pid TEXT,emoji TEXT,PRIMARY KEY(mid,pid,emoji));
CREATE TABLE IF NOT EXISTS pins(mid INTEGER PRIMARY KEY,by_name TEXT,ts INTEGER);`);
const MAX_SELL=5;
const IMAGE_MAX=40*1024, IMAGE_BODY=256*1024, IMAGE_USER=8, IMAGE_GLOBAL=24, IMAGE_TOTAL=700*1024;
const REACTS=["👍","❤️","😂","🐱","🎉","😮","😢"];
const MIME_OK=new Set(["image/jpeg","image/png","image/gif","image/webp"]);

// Persistence: Render's disk is ephemeral. The whole database is one JSON document in
// Supabase table `backup` (row id=1, column `data`). Core keys keep their original
// fields. New features are extra keys in that same document — no new Supabase tables.
const SB_URL=(process.env.SUPABASE_URL||"").replace(/\/+$/,""),SB_KEY=process.env.SUPABASE_SERVICE_KEY||"",SB_ON=!!(SB_URL&&SB_KEY);
const CORE={
 players:["id","name","salt","hash","coins","admin","banned","inv","daily","avatar","photo","pv","infinite"],
 items:["id","name","emoji","descr","price","stock","kind","seller"],
 messages:["id","name","text","ts","sys"],
 sessions:["token","pid","ts"],
 blocked:["id"]
};
const EXTRA={
 images:["id","pid","mime","b64","ts"],
 polls:["id","pid","name","question","options","ts","closed"],
 poll_votes:["poll_id","pid","opt","ts"],
 reports:["id","reporter","kind","target","reason","excerpt","status","ts","reviewer"],
 mentions:["id","mid","pid","seen","ts"],
 reactions:["mid","pid","emoji"],
 pins:["mid","by_name","ts"]
};
const sb=(method,p,body)=>fetch(SB_URL+"/rest/v1/"+p,{method,headers:{apikey:SB_KEY,...(SB_KEY.startsWith("eyJ")?{Authorization:"Bearer "+SB_KEY}:{}),"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:body&&JSON.stringify(body)});
function pick(row,cols){const o={}; for(const k of cols) if(row&&Object.prototype.hasOwnProperty.call(row,k)) o[k]=row[k]; return o}
function insertRows(table,rows,cols){
 for(const row of rows||[]){
  const o=pick(row,cols), c=Object.keys(o);
  if(!c.length) continue;
  db.prepare(`INSERT OR REPLACE INTO ${table}(${c.join(",")}) VALUES(${c.map(()=>"?").join(",")})`).run(...c.map(k=>o[k]));
 }
}
function trimImages(){
 const used=new Set(q("SELECT image FROM messages WHERE image!=''").all().map(r=>r.image));
 const old=Date.now()-10*60*1000;
 for(const r of q("SELECT id,ts FROM images").all()) if(!used.has(r.id)&&r.ts<old) q("DELETE FROM images WHERE id=?").run(r.id);
 let rows=q("SELECT id, LENGTH(b64) n FROM images ORDER BY ts DESC, id DESC").all();
 let total=0, keep=0, trimmed=0;
 const keepIds=new Set();
 for(const r of rows){
  const bytes=Math.floor((r.n||0)*3/4);
  if(keep>=IMAGE_GLOBAL||total+bytes>IMAGE_TOTAL){q("DELETE FROM images WHERE id=?").run(r.id); q("UPDATE messages SET image='' WHERE image=?").run(r.id); trimmed++}
  else {keep++; total+=bytes; keepIds.add(r.id)}
 }
 if(trimmed) console.warn("Trimmed "+trimmed+" old pictures so the Supabase backup stays small");
}
function dump(){
 trimImages();
 const o={};
 for(const [t,cols] of Object.entries(CORE)) o[t]=q("SELECT "+cols.join(",")+" FROM "+t).all().map(r=>pick(r,cols));
 for(const [t,cols] of Object.entries(EXTRA)) o[t]=q("SELECT "+cols.join(",")+" FROM "+t).all().map(r=>pick(r,cols));
 o.message_meta=q("SELECT id, reply, edited, deleted, image FROM messages WHERE reply!=0 OR edited!=0 OR deleted!=0 OR ifnull(image,'')!=''").all();
 o.player_flags=q("SELECT id, muted, muted_until FROM players WHERE muted!=0 OR ifnull(muted_until,0)!=0").all();
 return o;
}
function applyExtra(d){
 try{
  for(const [t,cols] of Object.entries(EXTRA)) insertRows(t,d[t],cols);
  for(const row of d.message_meta||[]){
   if(row==null||row.id==null) continue;
   q("UPDATE messages SET reply=?, edited=?, deleted=?, image=? WHERE id=?").run(+row.reply||0, row.edited?1:0, row.deleted?1:0, String(row.image||""), row.id);
  }
  for(const row of d.player_flags||[]){
   if(!row||row.id==null) continue;
   q("UPDATE players SET muted=?, muted_until=? WHERE id=?").run(row.muted?1:0, +row.muted_until||0, String(row.id));
  }
 }catch(e){console.error("Optional backup data skipped:", e.message)}
}
async function restore(){
 if(!SB_ON){console.warn("WARNING: SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Data will be lost when the server sleeps.");return}
 for(let i=0;i<5;i++){
  try{
   const r=await sb("GET","backup?id=eq.1&select=data");
   if(!r.ok)throw new Error(r.status+" "+await r.text());
   const rows=await r.json();
   if(rows.length){const d=rows[0].data||{};
    for(const [t,cols] of Object.entries(CORE)) insertRows(t,d[t],cols);
    applyExtra(d);
    console.log("Restored data from Supabase")}
   else console.log("No backup yet, starting fresh");
   return;
  }catch(e){console.error("Restore attempt failed:",e.message);await new Promise(r=>setTimeout(r,3000))}
 }
 console.error("Could not read the Supabase backup. Stopping so an empty database never overwrites it.");process.exit(1);
}
let saveTimer=null,saving=false,again=false;
async function save(){
 if(!SB_ON)return;if(saving){again=true;return}
 saving=true;
 try{do{again=false;const r=await sb("POST","backup?on_conflict=id",{id:1,data:dump()});if(!r.ok)throw new Error(r.status+" "+await r.text())}while(again)}
 catch(e){console.error("Backup failed:",e.message);setTimeout(scheduleSave,10000)}
 finally{saving=false}
}
function scheduleSave(){if(!SB_ON||saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;save()},2000)}
const bye=async()=>{clearTimeout(saveTimer);saveTimer=null;await save();process.exit(0)};
process.on("SIGTERM",bye);process.on("SIGINT",bye);

(async()=>{
await restore();
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,32).toString("hex");
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
class E extends Error{}
const bad=m=>{throw new E(m)};
const find=id=>q("SELECT * FROM players WHERE id=?").get(String(id||"").toLowerCase());
const clean=(s,n)=>String(s??"").replace(/\u0000/g,"").trim().slice(0,n);

{const salt=crypto.randomBytes(16).toString("hex"),h=hashPw(ADMIN_PW,salt);
 if(find(ROOT))q("UPDATE players SET salt=?,hash=?,admin=1,banned=0 WHERE id=?").run(salt,h,ROOT);
 else q("INSERT INTO players(id,name,salt,hash,admin,infinite) VALUES(?,?,?,?,1,1)").run(ROOT,ROOT,salt,h);
 q("DELETE FROM sessions WHERE ts<?").run(Date.now()-30*864e5)}

const fails=new Map();
const blocked=k=>(fails.get(k)||[]).filter(t=>Date.now()-t<6e5).length>=8;
const strike=k=>fails.set(k,[...(fails.get(k)||[]).filter(t=>Date.now()-t<6e5),Date.now()]);
const lastMsg=new Map(), lastImg=new Map();

function login(b,ip){
 const name=String(b.name||"").replace(/\u0000/g,"").trim(),pw=String(b.pw||""),id=name.toLowerCase();
 if(!/^[A-Za-z0-9_]{2,16}$/.test(name))bad("Use 2–16 letters, numbers or underscores.");
 if(pw.length<6)bad("Password must be at least 6 characters.");
 const key=ip+":"+id;if(blocked(key))bad("Too many tries. Wait a few minutes.");
 const p=find(id);
 if(p){
  if(!same(hashPw(pw,p.salt),p.hash)){strike(key);bad("Wrong username or password.")}
  if(p.banned)bad("This account is banned.");
 }else{
  if(id===ROOT)bad("That name is reserved.");
  if(q("SELECT 1 FROM blocked WHERE id=?").get(id))bad("This account is banned.");
  const salt=crypto.randomBytes(16).toString("hex");
  q("INSERT INTO players(id,name,salt,hash) VALUES(?,?,?,?)").run(id,name,salt,hashPw(pw,salt));
 }
 const token=crypto.randomBytes(24).toString("hex");
 q("INSERT INTO sessions VALUES(?,?,?)").run(token,id,Date.now());
 return{token,id};
}
function auth(req,url){
 const t=(req.headers.authorization||"").replace(/^Bearer /,"")||url.searchParams.get("t")||"";
 const s=q("SELECT pid FROM sessions WHERE token=?").get(t);
 const p=s&&find(s.pid);
 return p&&!p.banned?p:null;
}

const clamp=(v,n)=>Math.max(0,Math.min(n-1,parseInt(v)||0));
const post=(name,text,sys=1)=>q("INSERT INTO messages(name,text,ts,sys) VALUES(?,?,?,?)").run(name,text,Date.now(),sys);
const adm=p=>{if(!p.admin)bad("Admins only")},root=p=>{if(p.id!==ROOT)bad("Only "+ROOT+" can do that")};
const inf=p=>p.id===ROOT&&!!p.infinite;
function isMuted(p){
 if(!p||!p.muted) return false;
 if(p.muted_until&&Date.now()>p.muted_until){
  q("UPDATE players SET muted=0, muted_until=0 WHERE id=?").run(p.id);
  p.muted=0; p.muted_until=0; return false;
 }
 return true;
}
const muteMsg="You’re muted and can’t post right now.";
function mentionIds(text){
 const out=new Set(), re=/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{2,16})/g; let m;
 while((m=re.exec(String(text||"")))) out.add(m[2].toLowerCase());
 return [...out];
}
function addMentions(mid,text,author){
 for(const id of mentionIds(text)){
  if(id===author.id) continue;
  if(!find(id)) continue;
  q("INSERT INTO mentions(mid,pid,seen,ts) VALUES(?,?,0,?)").run(mid,id,Date.now());
 }
}
function dropMessageExtras(id){
 const m=q("SELECT image FROM messages WHERE id=?").get(id);
 q("DELETE FROM reactions WHERE mid=?").run(id);
 q("DELETE FROM mentions WHERE mid=?").run(id);
 q("DELETE FROM pins WHERE mid=?").run(id);
 if(m&&m.image) q("DELETE FROM images WHERE id=?").run(m.image);
}
function hardDeleteMessage(id){dropMessageExtras(id); q("DELETE FROM messages WHERE id=?").run(id)}
const wipe=id=>{
 q("DELETE FROM items WHERE seller=? AND stock!=0").run(id);
 q("DELETE FROM sessions WHERE pid=?").run(id);
 for(const m of q("SELECT id FROM messages WHERE lower(name)=?").all(id)) dropMessageExtras(m.id);
 q("DELETE FROM messages WHERE lower(name)=?").run(id);
 q("DELETE FROM images WHERE pid=?").run(id);
 q("DELETE FROM mentions WHERE pid=?").run(id);
 q("DELETE FROM reactions WHERE pid=?").run(id);
 q("DELETE FROM poll_votes WHERE pid=?").run(id);
 for(const row of q("SELECT id FROM polls WHERE pid=?").all(id)) q("DELETE FROM poll_votes WHERE poll_id=?").run(row.id);
 q("DELETE FROM polls WHERE pid=?").run(id);
 q("DELETE FROM reports WHERE reporter=?").run(id);
 q("UPDATE players SET muted=0, muted_until=0 WHERE id=?").run(id);
 q("DELETE FROM players WHERE id=?").run(id);
};
function sniff(buf){
 if(buf.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff) return "image/jpeg";
 if(buf.length>=8&&buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4e&&buf[3]===0x47&&buf[4]===0x0d&&buf[5]===0x0a&&buf[6]===0x1a&&buf[7]===0x0a) return "image/png";
 if(buf.length>=6&&buf[0]===0x47&&buf[1]===0x49&&buf[2]===0x46&&buf[3]===0x38&&(buf[4]===0x37||buf[4]===0x39)&&buf[5]===0x61) return "image/gif";
 if(buf.length>=12&&buf.toString("ascii",0,4)==="RIFF"&&buf.toString("ascii",8,12)==="WEBP") return "image/webp";
 return "";
}
function normEmoji(e){const s=String(e||""); if(REACTS.includes(s)) return s; if(s==="❤"||s==="❤︎") return "❤️"; return ""}
function setMute(id,hours){
 const until=hours>0?Date.now()+hours*3600000:0;
 q("UPDATE players SET muted=1, muted_until=? WHERE id=?").run(until,id);
}

const actions={
 send(p,b){if(isMuted(p))bad(muteMsg);
  const t=clean(b.text,300); const image=String(b.image||""); const reply=+b.reply||0;
  if(!t&&!image)bad("Write a message or attach a picture.");
  if(Date.now()-(lastMsg.get(p.id)||0)<500)bad("Slow down a little."); lastMsg.set(p.id,Date.now());
  if(image){
   if(!/^[a-f0-9]{24}$/.test(image))bad("That picture isn’t valid.");
   const im=q("SELECT pid FROM images WHERE id=?").get(image);
   if(!im||im.pid!==p.id)bad("Upload the picture again, then send.");
   if(q("SELECT 1 FROM messages WHERE image=? AND deleted=0").get(image))bad("Upload the picture again, then send.");
  }
  if(reply){const prev=q("SELECT id,deleted FROM messages WHERE id=?").get(reply); if(!prev||prev.deleted)bad("That message isn’t there to reply to.")}
  const info=q("INSERT INTO messages(name,text,ts,sys,reply,image) VALUES(?,?,?,0,?,?)").run(p.name,t,Date.now(),reply||0,image);
  addMentions(Number(info.lastInsertRowid),t,p)},
 edit(p,b){if(isMuted(p))bad(muteMsg);
  const id=+b.id, m=q("SELECT * FROM messages WHERE id=?").get(id);
  if(!m||m.sys||m.deleted)bad("That message can’t be edited.");
  if(String(m.name||"").toLowerCase()!==p.id)bad("You can only edit your own messages.");
  if(Date.now()-m.ts>15*60*1000)bad("Messages can only be edited for 15 minutes.");
  const t=clean(b.text,300); if(!t)bad("Message can’t be empty.");
  q("UPDATE messages SET text=?, edited=1 WHERE id=?").run(t,id);
  q("DELETE FROM mentions WHERE mid=?").run(id); addMentions(id,t,p)},
 "msg/delete"(p,b){const id=+b.id, m=q("SELECT * FROM messages WHERE id=?").get(id);
  if(!m||m.sys||m.deleted)bad("That message is already gone.");
  if(String(m.name||"").toLowerCase()!==p.id)bad("You can only delete your own messages.");
  dropMessageExtras(id);
  q("UPDATE messages SET text='', image='', deleted=1, edited=0 WHERE id=?").run(id)},
 react(p,b){const id=+b.id, emoji=normEmoji(b.emoji);
  if(!emoji)bad("That reaction isn’t available.");
  const m=q("SELECT id,deleted,sys FROM messages WHERE id=?").get(id);
  if(!m||m.deleted||m.sys)bad("You can’t react to that message.");
  const ex=q("SELECT 1 FROM reactions WHERE mid=? AND pid=? AND emoji=?").get(id,p.id,emoji);
  if(ex) q("DELETE FROM reactions WHERE mid=? AND pid=? AND emoji=?").run(id,p.id,emoji);
  else {
   if(q("SELECT COUNT(*) c FROM reactions WHERE mid=? AND pid=?").get(id,p.id).c>=3)bad("You can add up to 3 reactions on a message.");
   q("INSERT INTO reactions(mid,pid,emoji) VALUES(?,?,?)").run(id,p.id,emoji);
  }},
 pin(p,b){adm(p); const id=+b.id;
  const m=q("SELECT id,deleted,sys FROM messages WHERE id=?").get(id);
  if(!m||m.deleted||m.sys)bad("That message can’t be pinned.");
  const cur=q("SELECT 1 FROM pins WHERE mid=?").get(id);
  if(cur) q("DELETE FROM pins WHERE mid=?").run(id);
  else {
   if(q("SELECT COUNT(*) c FROM pins").get().c>=5)bad("Unpin one first. You can pin up to 5 messages.");
   q("INSERT INTO pins(mid,by_name,ts) VALUES(?,?,?)").run(id,p.name,Date.now());
  }},
 "mention/seen"(p){q("UPDATE mentions SET seen=1 WHERE pid=? AND seen=0").run(p.id)},
 image(p,b){if(isMuted(p))bad(muteMsg);
  if(Date.now()-(lastImg.get(p.id)||0)<1000)bad("Slow down a little.");
  const raw=String(b.data||"");
  const m=raw.match(/^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if(!m)bad("Use a JPEG, PNG, GIF, or WebP image.");
  let declared=m[1].toLowerCase(); if(declared==="image/jpg") declared="image/jpeg";
  let buf; try{buf=Buffer.from(m[2].replace(/\s/g,""),"base64")}catch{bad("That image could not be read.")}
  if(!buf.length)bad("That image could not be read.");
  if(buf.length>IMAGE_MAX)bad("That image is too big. CatChat keeps pictures small so they can be saved.");
  const mime=sniff(buf);
  if(!mime||mime!==declared||!MIME_OK.has(mime))bad("Use a JPEG, PNG, GIF, or WebP image.");
  if(q("SELECT COUNT(*) c FROM images WHERE pid=?").get(p.id).c>=IMAGE_USER)bad("You can keep up to 8 pictures. Delete an older one first.");
  if(q("SELECT COUNT(*) c FROM images").get().c>=IMAGE_GLOBAL)bad("The chat is storing as many pictures as it can. Delete an older picture and try again.");
  const total=q("SELECT COALESCE(SUM(LENGTH(b64)),0) n FROM images").get().n||0;
  if(Math.floor(total*3/4)+buf.length>IMAGE_TOTAL)bad("Picture storage is full. Delete an older picture and try again.");
  const id=crypto.randomBytes(12).toString("hex");
  q("INSERT INTO images(id,pid,mime,b64,ts) VALUES(?,?,?,?,?)").run(id,p.id,mime,buf.toString("base64"),Date.now());
  lastImg.set(p.id,Date.now());
  return {nopush:1, id}},
 "poll/create"(p,b){if(isMuted(p))bad(muteMsg);
  const question=clean(b.question,120); if(!question)bad("Ask a question.");
  let opts=Array.isArray(b.options)?b.options:[];
  opts=opts.map(s=>clean(s,40)).filter(Boolean);
  if(opts.length<2||opts.length>10)bad("Give the poll 2–10 choices.");
  if(new Set(opts.map(s=>s.toLowerCase())).size!==opts.length)bad("Each choice has to be different.");
  if(Date.now()-(lastMsg.get(p.id)||0)<500)bad("Slow down a little."); lastMsg.set(p.id,Date.now());
  q("INSERT INTO polls(pid,name,question,options,ts,closed) VALUES(?,?,?,?,?,0)").run(p.id,p.name,question,JSON.stringify(opts),Date.now());
  post(p.name, `${p.name} started a poll: ${question}`)},
 "poll/vote"(p,b){const poll=q("SELECT * FROM polls WHERE id=?").get(+b.id);
  if(!poll)bad("That poll is gone."); if(poll.closed)bad("This poll is closed.");
  let opts=[]; try{opts=JSON.parse(poll.options)}catch{opts=[]}
  const opt=+b.opt; if(!(opt>=0&&opt<opts.length))bad("Pick one of the choices.");
  q("INSERT INTO poll_votes(poll_id,pid,opt,ts) VALUES(?,?,?,?) ON CONFLICT(poll_id,pid) DO UPDATE SET opt=excluded.opt, ts=excluded.ts").run(poll.id,p.id,opt,Date.now())},
 "poll/close"(p,b){const poll=q("SELECT * FROM polls WHERE id=?").get(+b.id);
  if(!poll)bad("That poll is gone."); if(poll.closed)bad("This poll is already closed.");
  if(poll.pid!==p.id&&!p.admin)bad("Only the poll’s author or an admin can close it.");
  q("UPDATE polls SET closed=1 WHERE id=?").run(poll.id)},
 report(p,b){const kind=b.kind==="user"?"user":b.kind==="message"?"message":"";
  if(!kind)bad("Say whether you’re reporting a message or a person.");
  const reason=clean(b.reason,200); if(reason.length<3)bad("Add a short reason (at least 3 characters).");
  const since=Date.now()-600000;
  if(q("SELECT COUNT(*) c FROM reports WHERE reporter=? AND ts>?").get(p.id,since).c>=5)bad("You’re reporting too quickly. Try again in a few minutes.");
  const target=kind==="message"?String(+b.target||0):clean(b.target,16).toLowerCase();
  if(kind==="user"){
   const t=find(target); if(!t)bad("That person isn’t here."); if(t.id===p.id)bad("You can’t report yourself.");
   if(q("SELECT 1 FROM reports WHERE reporter=? AND kind='user' AND target=? AND status='open'").get(p.id,t.id))bad("You already reported that.");
   q("INSERT INTO reports(reporter,kind,target,reason,excerpt,status,ts) VALUES(?,?,?,?,?,'open',?)").run(p.id,kind,t.id,reason,t.name,Date.now());
  }else{
   const msg=q("SELECT * FROM messages WHERE id=?").get(+target);
   if(!msg||msg.sys||msg.deleted)bad("That message isn’t there.");
   if(String(msg.name||"").toLowerCase()===p.id)bad("You can’t report your own message.");
   if(q("SELECT 1 FROM reports WHERE reporter=? AND kind='message' AND target=? AND status='open'").get(p.id,String(msg.id)))bad("You already reported that.");
   q("INSERT INTO reports(reporter,kind,target,reason,excerpt,status,ts) VALUES(?,?,?,?,?,'open',?)").run(p.id,kind,String(msg.id),reason,clean(msg.text,200),Date.now());
  }},
 "report/dismiss"(p,b){adm(p); const rep=q("SELECT * FROM reports WHERE id=?").get(+b.id);
  if(!rep||rep.status!=="open")bad("That report is already closed.");
  q("UPDATE reports SET status='dismissed', reviewer=? WHERE id=?").run(p.id,rep.id)},
 "report/act"(p,b){adm(p); const rep=q("SELECT * FROM reports WHERE id=?").get(+b.id);
  if(!rep||rep.status!=="open")bad("That report is already closed.");
  const action=String(b.action||"");
  let kick=null;
  if(action==="delete"){
   if(rep.kind!=="message")bad("Only a message report can delete a message.");
   hardDeleteMessage(+rep.target);
  }else if(action==="mute"||action==="unmute"){
   const pid=rep.kind==="user"?rep.target:String((q("SELECT name FROM messages WHERE id=?").get(+rep.target)||{}).name||"").toLowerCase();
   const t=find(pid); if(!t||t.id===ROOT)bad("You can’t mute that player.");
   if(action==="unmute"||(t.muted&&!(t.muted_until&&Date.now()>t.muted_until)&&b.toggle)){q("UPDATE players SET muted=0, muted_until=0 WHERE id=?").run(t.id); post(p.name, `${t.name} can chat again`)}
   else {const hours=[0,1,24].includes(+b.hours)?+b.hours:24; setMute(t.id,hours); post(p.name, `${t.name} was muted`)}
  }else if(action==="ban"){
   root(p); const pid=rep.kind==="user"?rep.target:String((q("SELECT name FROM messages WHERE id=?").get(+rep.target)||{}).name||"").toLowerCase();
   const t=find(pid); if(!t||t.id===ROOT)bad("You can’t ban that player.");
   q("INSERT OR IGNORE INTO blocked(id) VALUES(?)").run(t.id); const name=t.name; wipe(t.id); post(p.name, `${name} was banned`); kick={kick:t.id,reason:"banned"};
  }else bad("Choose dismiss, delete, mute, or ban.");
  q("UPDATE reports SET status='actioned', reviewer=? WHERE id=?").run(p.id,rep.id);
  return kick},
 "admin/mute"(p,b){adm(p); const t=find(b.to); if(!t||t.id===ROOT)bad("You can’t mute that player.");
  if(isMuted(t)){q("UPDATE players SET muted=0, muted_until=0 WHERE id=?").run(t.id); post(p.name, `${t.name} can chat again`)}
  else {const hours=[0,1,24].includes(+b.hours)?+b.hours:24; setMute(t.id,hours); post(p.name, `${t.name} was muted`)}},
 pay(p,b){const t=find(b.to),n=parseInt(b.amt);
  if(!t||t.banned||t.id===p.id)bad("Pick another player by name");if(!(n>0))bad("Enter an amount");
  if(!inf(p)){if(p.coins<n)bad("You don’t have that many coins");q("UPDATE players SET coins=coins-? WHERE id=?").run(n,p.id)}
  q("UPDATE players SET coins=coins+? WHERE id=?").run(n,t.id);post(p.name,`${p.name} sent ${n} coins to ${t.name}`)},
 daily(p){if(Date.now()-p.daily<864e5)bad("Daily bonus isn’t ready yet");q("UPDATE players SET coins=coins+50,daily=? WHERE id=?").run(Date.now(),p.id)},
 buy(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i)bad("That item is gone");if(i.stock===0)bad("Sold out");if(i.seller&&i.seller===p.id)bad("You can’t buy your own item");if(!inf(p)&&p.coins<i.price)bad("Not enough coins");
  const inv=JSON.parse(p.inv);inv[i.id]=(inv[i.id]||0)+1;
  q("UPDATE players SET coins=coins-?,inv=? WHERE id=?").run(inf(p)?0:i.price,JSON.stringify(inv),p.id);
  const sl=i.seller?find(i.seller):null;if(sl)q("UPDATE players SET coins=coins+? WHERE id=?").run(i.price,sl.id);
  if(i.stock>0)q("UPDATE items SET stock=stock-1 WHERE id=?").run(i.id);
  post(p.name,`${p.name} bought ${i.emoji} ${i.name}${i.kind==="physical"?" (a real one!)":""}${sl?` from ${sl.name}`:""}`)},
 "item/sell"(p,b){const name=clean(b.name,40);if(!name)bad("Give your item a name");
  const price=parseInt(b.price);if(!(price>=1&&price<=1e6))bad("Price must be between 1 and 1,000,000");
  if(!p.admin&&q("SELECT COUNT(*) c FROM items WHERE seller=? AND stock!=0").get(p.id).c>=MAX_SELL)bad(`You can only have ${MAX_SELL} items for sale at once`);
  q("INSERT INTO items(name,emoji,descr,price,stock,kind,seller) VALUES(?,?,?,?,1,'normal',?)").run(name,clean(b.emoji,4)||"🎁",clean(b.desc,80),price,p.id)},
 "item/cancel"(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||i.seller!==p.id||i.stock===0)bad("You can’t cancel that");q("DELETE FROM items WHERE id=?").run(i.id)},
 avatar(p,b){
  const a={mode:b.mode==="photo"?"photo":"cat",fur:clamp(b.fur,8),eyes:clamp(b.eyes,5),pat:clamp(b.pat,4),acc:clamp(b.acc,5)};
  let photo=p.photo,pv=p.pv;
  if(b.photo==="")photo="";
  else if(typeof b.photo==="string"&&b.photo.length<80000&&/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(b.photo)){photo=b.photo;pv++}
  if(!photo)a.mode="cat";
  q("UPDATE players SET avatar=?,photo=?,pv=? WHERE id=?").run(JSON.stringify(a),photo,pv,p.id)},
 sell(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||(i.kind||"normal")!=="normal")bad("That item can’t be sold");
  if(i.seller)bad("Items bought from players can’t be sold back to the shop");
  const inv=JSON.parse(p.inv);if(!inv[i.id])bad("You don’t have that");
  if(--inv[i.id]<=0)delete inv[i.id];
  const got=Math.floor(i.price*0.7);
  q("UPDATE players SET coins=coins+?,inv=? WHERE id=?").run(got,JSON.stringify(inv),p.id);
  if(i.stock>=0)q("UPDATE items SET stock=stock+1 WHERE id=?").run(i.id);
  post(p.name,`${p.name} sold a ${i.emoji} ${i.name} for ${got} coins`)},
 discard(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||i.kind!=="fun")bad("You can only get rid of fun items");
  const inv=JSON.parse(p.inv);if(!inv[i.id])bad("You don’t have that");
  if(--inv[i.id]<=0)delete inv[i.id];
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(inv),p.id);post(p.name,`${p.name} got rid of a ${i.emoji} ${i.name}`)},
 infinite(p,b){root(p);q("UPDATE players SET infinite=? WHERE id=?").run(b.on?1:0,p.id)},
 "item/add"(p,b){adm(p);const name=clean(b.name,40);if(!name)bad("Give the item a name");
  const st=parseInt(b.stock);
  q("INSERT INTO items(name,emoji,descr,price,stock,kind) VALUES(?,?,?,?,?,?)").run(name,clean(b.emoji,4)||"🎁",clean(b.desc,80),Math.max(1,parseInt(b.price)||1),st>0?st:-1,["physical","fun"].includes(b.kind)?b.kind:"normal")},
 "item/remove"(p,b){adm(p);q("DELETE FROM items WHERE id=?").run(parseInt(b.id))},
 "admin/promote"(p,b){adm(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t change that player");
  q("UPDATE players SET admin=? WHERE id=?").run(t.admin?0:1,t.id);post(p.name,`${t.name} ${t.admin?"is no longer":"is now"} an admin`)},
 "admin/give"(p,b){root(p);const t=find(b.to),n=parseInt(b.n);if(!t||!n)bad("Pick a player and an amount");
  q("UPDATE players SET coins=MAX(0,coins+?) WHERE id=?").run(n,t.id);post(p.name,`${p.name} ${n>0?"gave":"took"} ${Math.abs(n)} coins ${n>0?"to":"from"} ${t.name}`)},
 "admin/ban"(p,b){root(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t ban that player");
  q("INSERT OR IGNORE INTO blocked(id) VALUES(?)").run(t.id);const name=t.name;wipe(t.id);post(p.name,`${name} was banned`);return{kick:t.id,reason:"banned"}},
 "admin/unban"(p,b){root(p);const id=String(b.to||"").toLowerCase();q("DELETE FROM blocked WHERE id=?").run(id);post(p.name,`${id} can sign up again`)},
 deleteMe(p,b){if(p.id===ROOT)bad("The admin account can’t be deleted");
  if(!same(hashPw(String(b.pw||""),p.salt),p.hash))bad("Wrong password");
  const name=p.name; wipe(p.id);post("CatChat",`${name} deleted their account`);return{kick:p.id,reason:"deleted"}},
 "admin/delmsg"(p,b){adm(p);hardDeleteMessage(parseInt(b.id))},
 "admin/clear"(p){adm(p);q("DELETE FROM messages").run();q("DELETE FROM reactions").run();q("DELETE FROM mentions").run();q("DELETE FROM pins").run();q("DELETE FROM images").run()},
};
function tx(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r}catch(e){db.exec("ROLLBACK");throw e}}

const clients=new Set();
const typing=new Map();
function typingList(){
 const now=Date.now(), list=[];
 for(const [id,ts] of typing){
  if(now-ts>3500) typing.delete(id);
  else {const u=find(id); if(u&&!u.banned) list.push({id,name:u.name})}
 }
 return list;
}
function broadcastTyping(){
 const data=JSON.stringify(typingList());
 for(const c of clients){try{c.res.write("event: typing\ndata: "+data+"\n\n")}catch(e){}}
}
const pub=p=>{const a=JSON.parse(p.avatar||"{}");
 return{id:p.id,name:p.name,coins:p.coins,admin:!!p.admin,banned:!!p.banned,inf:p.id===ROOT&&!!p.infinite,
  muted:!!(p.muted&&(!p.muted_until||p.muted_until>Date.now())),
  avatar:Object.keys(a).length?{...a,photo:p.photo?`/avatar/${p.id}?v=${p.pv}`:""}:undefined}};
function mapMsg(m){
 const deleted=!!m.deleted;
 const prev=m.reply?q("SELECT name,text,deleted FROM messages WHERE id=?").get(m.reply):null;
 const grouped={};
 if(!deleted) for(const r of q("SELECT emoji,pid FROM reactions WHERE mid=?").all(m.id)) (grouped[r.emoji]||=[]).push(r.pid);
 const image=!deleted&&m.image&&/^[a-f0-9]{24}$/.test(m.image)?`/img/${m.image}`:"";
 return {id:m.id,name:m.name,text:deleted?"":m.text,ts:m.ts,sys:m.sys?1:0,edited:!deleted&&m.edited?1:0,deleted:deleted?1:0,
  image, reply:m.reply||0, replyName:prev?prev.name:"", replyText:prev?(prev.deleted?"":String(prev.text||"").slice(0,80)):"",
  reactions:Object.entries(grouped).map(([emoji,users])=>({emoji,users}))};
}
function mapPolls(){
 return q("SELECT * FROM polls ORDER BY id DESC LIMIT 20").all().map(p=>{
  let options=[]; try{options=JSON.parse(p.options)}catch{options=[]}
  return {id:p.id,pid:p.pid,name:p.name,question:p.question,options,ts:p.ts,closed:p.closed?1:0,
   votes:q("SELECT pid,opt FROM poll_votes WHERE poll_id=?").all(p.id)};
 });
}
function mapPins(){
 return q(`SELECT pins.mid id, pins.ts, messages.name name, messages.text text FROM pins JOIN messages ON messages.id=pins.mid WHERE messages.deleted=0 ORDER BY pins.ts DESC`).all()
  .map(p=>({id:p.id,ts:p.ts,name:p.name,text:String(p.text||"").slice(0,80)}));
}
const snapshot=()=>JSON.stringify({
 players:q("SELECT * FROM players").all().map(pub),
 items:q("SELECT * FROM items").all().map(i=>({id:i.id,name:i.name,emoji:i.emoji,desc:i.descr,price:i.price,stock:i.stock,kind:i.kind||"normal",seller:i.seller||""})),
 messages:q("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 80) ORDER BY id").all().map(mapMsg),
 polls:mapPolls(), pins:mapPins()});
function mentionNotes(pid){
 return q(`SELECT mentions.id id, mentions.mid mid, messages.name name, substr(messages.text,1,80) text, mentions.ts ts
  FROM mentions JOIN messages ON messages.id=mentions.mid
  WHERE mentions.pid=? AND mentions.seen=0 AND messages.deleted=0 ORDER BY mentions.id DESC LIMIT 20`).all(pid);
}
function sendTo(c,base){const m=find(c.pid);if(!m)return;
 const me={inv:JSON.parse(m.inv||"{}"),daily:m.daily,muted:!!(m.muted&&(!m.muted_until||m.muted_until>Date.now())),mentions:mentionNotes(m.id)};
 if(m.id===ROOT) me.blocked=q("SELECT id FROM blocked").all().map(r=>r.id);
 if(m.admin) me.reports=q("SELECT id,reporter,kind,target,reason,excerpt,status,ts,reviewer FROM reports ORDER BY id DESC LIMIT 40").all();
 c.res.write("event: state\ndata: "+base.slice(0,-1)+',"me":'+JSON.stringify(me)+"}\n\n")}
function push(){scheduleSave();if(!clients.size)return;const base=snapshot();for(const c of clients)sendTo(c,base)}
setInterval(()=>{for(const c of clients)c.res.write(": ping\n\n"); broadcastTyping()},25000);

const INDEX=fs.readFileSync(path.join(__dirname,"index.html"));
const CSP="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const J=(res,code,o)=>{if(res.writableEnded||res.headersSent)return; res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","X-Content-Type-Options":"nosniff","Cache-Control":"no-store"});res.end(JSON.stringify(o))};
const readBody=(req,limit)=>new Promise((ok,no)=>{
 let n=0,done=false; const c=[];
 const fail=e=>{if(done)return; done=true; no(e)};
 req.on("data",d=>{if(done)return; n+=d.length; if(n>limit){fail(new E(limit>150000?"That image is too large to upload.":"That’s too large")); return} c.push(d)});
 req.on("end",()=>{if(done)return; done=true; try{const v=JSON.parse(Buffer.concat(c).toString()||"{}"); ok(v&&typeof v==="object"&&!Array.isArray(v)?v:{})}catch{no(new E("Bad request"))}});
 req.on("error",e=>{if(!done){done=true; no(e)}});
});

http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://x");
 try{
  if(req.method==="GET"){
   if(url.pathname==="/"||url.pathname==="/index.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":CSP,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Cache-Control":"no-cache"});return res.end(INDEX)}
   if(url.pathname==="/healthz")return res.end("ok");
   if(url.pathname==="/api/me"){const p=auth(req,url);return p?J(res,200,{id:p.id}):J(res,401,{error:"auth"})}
   if(url.pathname==="/events"){const p=auth(req,url);if(!p)return J(res,401,{error:"auth"});
    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff"});
    res.write("retry: 3000\n\n");const c={res,pid:p.id};clients.add(c);req.on("close",()=>clients.delete(c));return sendTo(c,snapshot())}
   if(url.pathname.startsWith("/avatar/")){const p=find(url.pathname.slice(8).split("?")[0]);
    if(!p||!p.photo||!String(p.photo).startsWith("data:image/jpeg;base64,"))return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"public,max-age=31536000,immutable","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'"});
    return res.end(Buffer.from(p.photo.split(",")[1],"base64"))}
   if(url.pathname.startsWith("/img/")){
    const id=url.pathname.slice(5);
    if(!/^[a-f0-9]{24}$/.test(id)) return res.writeHead(404).end();
    const row=q("SELECT mime,b64 FROM images WHERE id=?").get(id);
    const buf=row&&Buffer.from(row.b64||"","base64");
    if(!row||!MIME_OK.has(row.mime)||!buf||!buf.length||sniff(buf)!==row.mime) return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":row.mime,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'","Content-Disposition":"inline","Cache-Control":"private, max-age=86400"});
    return res.end(buf);
   }
  }
  if(req.method==="POST"&&url.pathname.startsWith("/api/")){
   const act=url.pathname.slice(5);
   const b=await readBody(req, act==="image"?IMAGE_BODY:150000);
   if(act==="login"){const ip=req.headers["fly-client-ip"]||req.socket.remoteAddress;const r=login(b,ip);push();return J(res,200,r)}
   const p=auth(req,url);if(!p)return J(res,401,{error:"auth"});
   if(act==="logout"){q("DELETE FROM sessions WHERE token=?").run((req.headers.authorization||"").replace(/^Bearer /,""));scheduleSave();return J(res,200,{ok:1})}
   if(act==="typing"){typing.set(p.id,Date.now());broadcastTyping();return J(res,200,{ok:1})}
   if(!Object.hasOwn(actions,act))return J(res,404,{error:"Unknown action"});
   const r=tx(()=>actions[act](p,b));
   if(r&&r.nopush) scheduleSave(); else push();
   if(r&&r.kick)for(const c of clients)if(c.pid===r.kick){c.res.write("event: bye\ndata: "+(r.reason||"")+"\n\n");c.res.end();clients.delete(c)}
   const extra={};
   if(r) for(const k of Object.keys(r)) if(k!=="kick"&&k!=="reason"&&k!=="nopush") extra[k]=r[k];
   return J(res,200,{ok:1,...extra});
  }
  res.writeHead(404,{"X-Content-Type-Options":"nosniff"}).end("Not found");
 }catch(e){
  if(e instanceof E)return J(res,400,{error:e.message});
  console.error(e);J(res,500,{error:"Something went wrong on the server. Try again."});
 }
}).listen(PORT,"0.0.0.0",()=>console.log("CatChat listening on "+PORT));
scheduleSave();
})().catch(e=>{console.error(e);process.exit(1)});
