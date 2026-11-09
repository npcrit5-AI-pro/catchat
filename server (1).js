const http=require("node:http"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const ROOT="meowmaster100",PORT=+process.env.PORT||8080,DATA=process.env.DATA_DIR||"/tmp/catchat";
const ADMIN_PW=process.env.ADMIN_PASSWORD||"";
if(ADMIN_PW.length<6){console.error("Set ADMIN_PASSWORD (6+ characters), add it under Environment on your host");process.exit(1)}
fs.mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(path.join(DATA,"meow.db"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,name TEXT,salt TEXT,hash TEXT,coins INTEGER DEFAULT 100,admin INTEGER DEFAULT 0,banned INTEGER DEFAULT 0,inv TEXT DEFAULT '{}',daily INTEGER DEFAULT 0,avatar TEXT DEFAULT '{}',photo TEXT DEFAULT '',pv INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,emoji TEXT,descr TEXT,price INTEGER,stock INTEGER);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,text TEXT,ts INTEGER,sys INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,pid TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS blocked(id TEXT PRIMARY KEY);`);
try{db.exec("ALTER TABLE items ADD COLUMN kind TEXT DEFAULT 'normal'")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN infinite INTEGER DEFAULT 0");db.exec("UPDATE players SET infinite=1 WHERE id='meowmaster100'")}catch(e){}
const q=s=>db.prepare(s);

// ---- persistence: the host's disk is wiped when the server sleeps, so the whole
// database is copied to Supabase (one row) after changes and loaded back on startup.
const SB_URL=(process.env.SUPABASE_URL||"").replace(/\/+$/,""),SB_KEY=process.env.SUPABASE_SERVICE_KEY||"",SB_ON=!!(SB_URL&&SB_KEY);
const TABLES=["players","items","messages","sessions","blocked"];
const sb=(method,p,body)=>fetch(SB_URL+"/rest/v1/"+p,{method,headers:{apikey:SB_KEY,...(SB_KEY.startsWith("eyJ")?{Authorization:"Bearer "+SB_KEY}:{}),"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:body&&JSON.stringify(body)});
const dump=()=>{const o={};for(const t of TABLES)o[t]=db.prepare("SELECT * FROM "+t).all();return o};
async function restore(){
 if(!SB_ON){console.warn("WARNING: SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Data will be lost when the server sleeps.");return}
 for(let i=0;i<5;i++){
  try{
   const r=await sb("GET","backup?id=eq.1&select=data");
   if(!r.ok)throw new Error(r.status+" "+await r.text());
   const rows=await r.json();
   if(rows.length){const d=rows[0].data||{};
    for(const t of TABLES)for(const row of d[t]||[]){const c=Object.keys(row);
     db.prepare(`INSERT OR REPLACE INTO ${t}(${c.join(",")}) VALUES(${c.map(()=>"?").join(",")})`).run(...c.map(k=>row[k]))}
    console.log("Restored data from Supabase")}
   else console.log("No backup yet, starting fresh");
   return;
  }catch(e){console.error("Restore attempt failed:",e.message);await new Promise(r=>setTimeout(r,3000))}
 }
 console.error("Could not read the Supabase backup. Stopping so an empty database never overwrites it.");process.exit(1);
}
let saveTimer=null,saving=false,again=false,ready=false,lastSnap=0;
async function save(){
 if(!SB_ON||!ready)return;if(saving){again=true;return}
 saving=true;
 try{do{again=false;const data=dump();const r=await sb("POST","backup?on_conflict=id",{id:1,data});if(!r.ok)throw new Error(r.status+" "+await r.text());
  // older safety copies: one of 7 daily slots (ids 10-16), at most every 6 hours, never an empty-looking database
  if(Date.now()-lastSnap>216e5&&data.players.length>1){const r2=await sb("POST","backup?on_conflict=id",{id:10+Math.floor(Date.now()/864e5)%7,data});if(r2.ok)lastSnap=Date.now()}
 }while(again)}
 catch(e){console.error("Backup failed:",e.message);setTimeout(scheduleSave,10000)}
 finally{saving=false}
}
function scheduleSave(){if(!SB_ON||saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;save()},2000)}
const bye=async()=>{clearTimeout(saveTimer);saveTimer=null;if(ready)await save();process.exit(0)};
process.on("SIGTERM",bye);process.on("SIGINT",bye);

(async()=>{
await restore();
ready=true; // saving is only allowed once the backup has been loaded
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,32).toString("hex");
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
class E extends Error{}
const bad=m=>{throw new E(m)};
const find=id=>q("SELECT * FROM players WHERE id=?").get(String(id||"").toLowerCase());

// The admin account always uses ADMIN_PASSWORD; nobody else can register that name.
{const salt=crypto.randomBytes(16).toString("hex"),h=hashPw(ADMIN_PW,salt);
 if(find(ROOT))q("UPDATE players SET salt=?,hash=?,admin=1,banned=0 WHERE id=?").run(salt,h,ROOT);
 else q("INSERT INTO players(id,name,salt,hash,admin,infinite) VALUES(?,?,?,?,1,1)").run(ROOT,ROOT,salt,h);
 q("DELETE FROM sessions WHERE ts<?").run(Date.now()-30*864e5)}

const fails=new Map();
const blocked=k=>(fails.get(k)||[]).filter(t=>Date.now()-t<6e5).length>=8;
const strike=k=>fails.set(k,[...(fails.get(k)||[]).filter(t=>Date.now()-t<6e5),Date.now()]);
const lastMsg=new Map();

function login(b,ip){
 const name=String(b.name||"").trim(),pw=String(b.pw||""),id=name.toLowerCase();
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

// ---- game logic: every rule is enforced here, not in the page
const clamp=(v,n)=>Math.max(0,Math.min(n-1,parseInt(v)||0));
const post=(name,text,sys=1)=>q("INSERT INTO messages(name,text,ts,sys) VALUES(?,?,?,?)").run(name,text,Date.now(),sys);
const adm=p=>{if(!p.admin)bad("Admins only")},root=p=>{if(p.id!==ROOT)bad("Only "+ROOT+" can do that")};
const inf=p=>p.id===ROOT&&!!p.infinite;
const wipe=id=>{q("DELETE FROM sessions WHERE pid=?").run(id);q("DELETE FROM messages WHERE lower(name)=?").run(id);q("DELETE FROM players WHERE id=?").run(id)};
const actions={
 send(p,b){const t=String(b.text||"").trim().slice(0,300);if(!t)bad("Empty message");
  if(Date.now()-(lastMsg.get(p.id)||0)<500)bad("Slow down");lastMsg.set(p.id,Date.now());post(p.name,t,0)},
 pay(p,b){const t=find(b.to),n=parseInt(b.amt);
  if(!t||t.banned||t.id===p.id)bad("Pick another player by name");if(!(n>0))bad("Enter an amount");
  if(!inf(p)){if(p.coins<n)bad("You don’t have that many coins");q("UPDATE players SET coins=coins-? WHERE id=?").run(n,p.id)}
  q("UPDATE players SET coins=coins+? WHERE id=?").run(n,t.id);post(p.name,`${p.name} sent ${n} coins to ${t.name}`)},
 daily(p){if(Date.now()-p.daily<864e5)bad("Daily bonus isn’t ready yet");q("UPDATE players SET coins=coins+50,daily=? WHERE id=?").run(Date.now(),p.id)},
 buy(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i)bad("That item is gone");if(i.stock===0)bad("Sold out");if(!inf(p)&&p.coins<i.price)bad("Not enough coins");
  const inv=JSON.parse(p.inv);inv[i.id]=(inv[i.id]||0)+1;
  q("UPDATE players SET coins=coins-?,inv=? WHERE id=?").run(inf(p)?0:i.price,JSON.stringify(inv),p.id);
  if(i.stock>0)q("UPDATE items SET stock=stock-1 WHERE id=?").run(i.id);
  post(p.name,`${p.name} bought ${i.emoji} ${i.name}${i.kind==="physical"?" (a real one!)":""}`)},
 avatar(p,b){
  const a={mode:b.mode==="photo"?"photo":"cat",fur:clamp(b.fur,8),eyes:clamp(b.eyes,5),pat:clamp(b.pat,4),acc:clamp(b.acc,5)};
  let photo=p.photo,pv=p.pv;
  if(b.photo==="")photo="";
  else if(typeof b.photo==="string"&&b.photo.length<80000&&/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(b.photo)){photo=b.photo;pv++}
  if(!photo)a.mode="cat";
  q("UPDATE players SET avatar=?,photo=?,pv=? WHERE id=?").run(JSON.stringify(a),photo,pv,p.id)},
 sell(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||(i.kind||"normal")!=="normal")bad("That item can’t be sold");
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
 "item/add"(p,b){adm(p);const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give the item a name");
  const st=parseInt(b.stock);
  q("INSERT INTO items(name,emoji,descr,price,stock,kind) VALUES(?,?,?,?,?,?)").run(name,String(b.emoji||"").trim().slice(0,4)||"🎁",String(b.desc||"").trim().slice(0,80),Math.max(1,parseInt(b.price)||1),st>0?st:-1,["physical","fun"].includes(b.kind)?b.kind:"normal")},
 "item/remove"(p,b){adm(p);q("DELETE FROM items WHERE id=?").run(parseInt(b.id))},
 "admin/promote"(p,b){adm(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t change that player");
  q("UPDATE players SET admin=? WHERE id=?").run(t.admin?0:1,t.id);post(p.name,`${t.name} ${t.admin?"is no longer":"is now"} an admin`)},
 "admin/give"(p,b){root(p);const t=find(b.to),n=parseInt(b.n);if(!t||!n)bad("Pick a player and an amount");
  q("UPDATE players SET coins=MAX(0,coins+?) WHERE id=?").run(n,t.id)},
 "admin/ban"(p,b){root(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t ban that player");
  q("INSERT OR IGNORE INTO blocked(id) VALUES(?)").run(t.id);wipe(t.id);post(p.name,`${t.name} was banned`);return{kick:t.id,reason:"banned"}},
 "admin/unban"(p,b){root(p);const id=String(b.to||"").toLowerCase();q("DELETE FROM blocked WHERE id=?").run(id);post(p.name,`${id} can sign up again`)},
 deleteMe(p,b){if(p.id===ROOT)bad("The admin account can’t be deleted");
  if(!same(hashPw(String(b.pw||""),p.salt),p.hash))bad("Wrong password");
  wipe(p.id);post("CatChat",`${p.name} deleted their account`);return{kick:p.id,reason:"deleted"}},
 "admin/delmsg"(p,b){adm(p);q("DELETE FROM messages WHERE id=?").run(parseInt(b.id))},
 "admin/clear"(p){adm(p);q("DELETE FROM messages").run()},
};
function tx(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r}catch(e){db.exec("ROLLBACK");throw e}}

// ---- live updates (Server-Sent Events)
const clients=new Set();
const pub=p=>{const a=JSON.parse(p.avatar||"{}");
 return{id:p.id,name:p.name,coins:p.coins,admin:!!p.admin,banned:!!p.banned,inf:p.id===ROOT&&!!p.infinite,avatar:Object.keys(a).length?{...a,photo:p.photo?`/avatar/${p.id}?v=${p.pv}`:""}:undefined}};
const snapshot=()=>JSON.stringify({
 players:q("SELECT * FROM players").all().map(pub),
 items:q("SELECT * FROM items").all().map(i=>({id:i.id,name:i.name,emoji:i.emoji,desc:i.descr,price:i.price,stock:i.stock,kind:i.kind||"normal"})),
 messages:q("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 80) ORDER BY id").all()});
function sendTo(c,base){const m=find(c.pid);if(!m)return;
 c.res.write("event: state\ndata: "+base.slice(0,-1)+',"me":'+JSON.stringify({inv:JSON.parse(m.inv),daily:m.daily,blocked:m.id===ROOT?q("SELECT id FROM blocked").all().map(r=>r.id):undefined})+"}\n\n")}
function push(){scheduleSave();if(!clients.size)return;const base=snapshot();for(const c of clients)sendTo(c,base)}
setInterval(()=>{for(const c of clients)c.res.write(": ping\n\n")},25000);

// ---- http
const INDEX=fs.readFileSync(path.join(__dirname,"index.html"));
const CSP="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const J=(res,code,o)=>{res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(o))};
const readBody=req=>new Promise((ok,no)=>{let n=0;const c=[];
 req.on("data",d=>{n+=d.length;if(n>150e3){no(new E("That’s too large"));req.destroy()}else c.push(d)});
 req.on("end",()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||"{}"))}catch(e){no(new E("Bad request"))}});
 req.on("error",no)});

http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://x");
 try{
  if(req.method==="GET"){
   if(url.pathname==="/"||url.pathname==="/index.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":CSP,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});return res.end(INDEX)}
   if(url.pathname==="/healthz")return res.end("ok");
   if(url.pathname==="/api/me"){const p=auth(req,url);return p?J(res,200,{id:p.id}):J(res,401,{error:"auth"})}
   if(url.pathname==="/events"){const p=auth(req,url);if(!p)return J(res,401,{error:"auth"});
    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","X-Accel-Buffering":"no"});
    res.write("retry: 3000\n\n");const c={res,pid:p.id};clients.add(c);req.on("close",()=>clients.delete(c));return sendTo(c,snapshot())}
   if(url.pathname.startsWith("/avatar/")){const p=find(url.pathname.slice(8));
    if(!p||!p.photo)return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"public,max-age=31536000,immutable","X-Content-Type-Options":"nosniff"});
    return res.end(Buffer.from(p.photo.split(",")[1],"base64"))}
  }
  if(req.method==="POST"&&url.pathname.startsWith("/api/")){
   const act=url.pathname.slice(5),b=await readBody(req);
   if(act==="login"){const ip=req.socket.remoteAddress;const r=login(b,ip);push();return J(res,200,r)}
   const p=auth(req,url);if(!p)return J(res,401,{error:"auth"});
   if(act==="logout"){q("DELETE FROM sessions WHERE token=?").run((req.headers.authorization||"").replace(/^Bearer /,""));scheduleSave();return J(res,200,{ok:1})}
   if(!Object.hasOwn(actions,act))return J(res,404,{error:"Unknown action"});
   const r=tx(()=>actions[act](p,b));push();
   if(r&&r.kick)for(const c of clients)if(c.pid===r.kick){c.res.write("event: bye\ndata: "+(r.reason||"")+"\n\n");c.res.end();clients.delete(c)}
   return J(res,200,{ok:1});
  }
  res.writeHead(404).end("Not found");
 }catch(e){
  if(e instanceof E)return J(res,400,{error:e.message});
  console.error(e);J(res,500,{error:"Server error"});
 }
}).listen(PORT,"0.0.0.0",()=>console.log("CatChat listening on "+PORT));
scheduleSave();
})().catch(e=>{console.error(e);process.exit(1)});
