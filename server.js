const http=require("node:http"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const LEGACY_ROOT="meowmaster100";
// The root admin's login name. Configurable so production can use a different
// name (e.g. ADMIN_NAME=sushi_catie on Render). ids are always lowercase;
// the same letters/numbers/underscores rule as signup applies.
const RAW_ADMIN_NAME=(process.env.ADMIN_NAME||LEGACY_ROOT).trim();
if(!/^[A-Za-z0-9_]{2,16}$/.test(RAW_ADMIN_NAME)){console.error("ADMIN_NAME must be 2–16 letters, numbers or underscores");process.exit(1)}
const ROOT=RAW_ADMIN_NAME.toLowerCase(),PORT=+process.env.PORT||8080,DATA=process.env.DATA_DIR||"/tmp/catchat";
// Never commit a real password here: set ADMIN_PASSWORD in the environment
// (on Render: dashboard > service > Environment). Without one we generate an
// ephemeral password so the app still boots for local dev, and print it once.
let ADMIN_PW=process.env.ADMIN_PASSWORD||"";
if(!ADMIN_PW){ADMIN_PW=crypto.randomBytes(12).toString("hex");console.warn("WARNING: ADMIN_PASSWORD is not set. Generated an ephemeral admin password for this boot only: "+ADMIN_PW)}
if(ADMIN_PW.length<6){console.error("Set ADMIN_PASSWORD (6+ characters), add it under Environment on your host");process.exit(1)}
fs.mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(path.join(DATA,"meow.db"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,name TEXT,salt TEXT,hash TEXT,coins INTEGER DEFAULT 100,admin INTEGER DEFAULT 0,banned INTEGER DEFAULT 0,inv TEXT DEFAULT '{}',daily INTEGER DEFAULT 0,avatar TEXT DEFAULT '{}',photo TEXT DEFAULT '',pv INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,emoji TEXT,descr TEXT,price INTEGER,stock INTEGER);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,text TEXT,ts INTEGER,sys INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,pid TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS blocked(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS cats(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,descr TEXT DEFAULT '',emoji TEXT DEFAULT '🐱',img TEXT DEFAULT '',hp INTEGER DEFAULT 50,price INTEGER DEFAULT 0,stock INTEGER DEFAULT -1,type1 TEXT DEFAULT 'normal',type2 TEXT DEFAULT '',rarity TEXT DEFAULT '',shop INTEGER DEFAULT 1,evo INTEGER DEFAULT 0,evolv INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS catown(id INTEGER PRIMARY KEY AUTOINCREMENT,pid TEXT,cat INTEGER,xp INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS equip(pid TEXT,own INTEGER,item INTEGER,PRIMARY KEY(pid,own));
CREATE TABLE IF NOT EXISTS packs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,descr TEXT DEFAULT '',emoji TEXT DEFAULT '🎁',img TEXT DEFAULT '',price INTEGER DEFAULT 0,stock INTEGER DEFAULT -1,data TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS wilds(id INTEGER PRIMARY KEY AUTOINCREMENT,cat INTEGER,lvl INTEGER DEFAULT 1,moves TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS trainers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,img TEXT DEFAULT '',reward INTEGER DEFAULT 0,team TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS wins(pid TEXT,trainer INTEGER,PRIMARY KEY(pid,trainer));
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT,frm TEXT,too TEXT,give TEXT,want TEXT,ts INTEGER,status TEXT DEFAULT 'open');
CREATE TABLE IF NOT EXISTS words(word TEXT PRIMARY KEY);`);
try{db.exec("ALTER TABLE items ADD COLUMN kind TEXT DEFAULT 'normal'")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN img TEXT DEFAULT ''")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN sale INTEGER")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN sends INTEGER DEFAULT 0")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN dmg INTEGER DEFAULT 0")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN atype TEXT DEFAULT ''")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN infinite INTEGER DEFAULT 0");q("UPDATE players SET infinite=1 WHERE id=?").run(ROOT)}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN lead INTEGER DEFAULT 0")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN seller TEXT DEFAULT ''")}catch(e){}
const MAX_SELL=5;
const q=s=>db.prepare(s);

// ---- persistence: the host's disk is wiped when the server sleeps, so the whole
// database is copied to Supabase (one row) after changes and loaded back on startup.
const SB_URL=(process.env.SUPABASE_URL||"").replace(/\/+$/,""),SB_KEY=process.env.SUPABASE_SERVICE_KEY||"",SB_ON=!!(SB_URL&&SB_KEY);
const TABLES=["players","items","messages","sessions","blocked","cats","catown","equip","packs","wilds","trainers","wins","trades","words"];
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
let SCRATCH=0;

// The admin account always uses ADMIN_PASSWORD; nobody else can register that name.
// Safe migration: if the database (e.g. restored from backup) still has the
// previous hardcoded root, it is demoted to a normal player — its coins,
// items and messages are kept — so only the configured ADMIN_NAME has root.
{const salt=crypto.randomBytes(16).toString("hex"),h=hashPw(ADMIN_PW,salt);
 if(find(ROOT))q("UPDATE players SET salt=?,hash=?,admin=1,infinite=1,banned=0 WHERE id=?").run(salt,h,ROOT);
 else q("INSERT INTO players(id,name,salt,hash,admin,infinite) VALUES(?,?,?,?,1,1)").run(ROOT,RAW_ADMIN_NAME,salt,h);
 if(ROOT!==LEGACY_ROOT)q("UPDATE players SET admin=0,infinite=0 WHERE id=?").run(LEGACY_ROOT);
 q("DELETE FROM sessions WHERE ts<?").run(Date.now()-30*864e5)}
// Everyone starts with a free Scratch (10 damage) ability that fits any cat.
{const s=q("SELECT id FROM items WHERE kind='ability' AND lower(name)='scratch'").get();
 if(s)SCRATCH=s.id;
 else SCRATCH=q("INSERT INTO items(name,emoji,descr,price,stock,kind,dmg,atype) VALUES(?,?,?,?,?,?,?,?)").run("Scratch","🐾","A basic swipe. Fits on all cats.",0,-1,"ability",10,"normal").lastInsertRowid}

const fails=new Map();
const blocked=k=>(fails.get(k)||[]).filter(t=>Date.now()-t<6e5).length>=8;
const strike=k=>fails.set(k,[...(fails.get(k)||[]).filter(t=>Date.now()-t<6e5),Date.now()]);
// Generic per-IP throttle for POST /api/*: 180 requests per minute per IP.
const apiHits=new Map();
function throttled(ip){
 const now=Date.now(),w=6e4,arr=(apiHits.get(ip)||[]).filter(t=>now-t<w);
 arr.push(now);apiHits.set(ip,arr);
 if(apiHits.size>5000)for(const k of apiHits.keys()){if((apiHits.get(k)||[]).every(t=>now-t<w))apiHits.delete(k);if(apiHits.size<4000)break}
 return arr.length>180;
}
// Slice by code point so emoji (surrogate pairs) are never split in half.
const emoji=s=>Array.from(String(s||"").trim()).slice(0,2).join("")||"🎁";
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
  if(q("SELECT 1 FROM words WHERE instr(?,word)>0").get(id))bad("That name isn’t allowed.");
  const salt=crypto.randomBytes(16).toString("hex");
  const inv={};if(SCRATCH)inv[SCRATCH]=1;
  q("INSERT INTO players(id,name,salt,hash,inv) VALUES(?,?,?,?,?)").run(id,name,salt,hashPw(pw,salt),JSON.stringify(inv));
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
const wipe=id=>{q("DELETE FROM items WHERE seller=? AND stock!=0").run(id);q("DELETE FROM catown WHERE pid=?").run(id);q("DELETE FROM equip WHERE pid=?").run(id);q("DELETE FROM trades WHERE frm=? OR too=?").run(id,id);q("DELETE FROM wins WHERE pid=?").run(id);q("DELETE FROM sessions WHERE pid=?").run(id);q("DELETE FROM messages WHERE lower(name)=?").run(id);q("DELETE FROM players WHERE id=?").run(id)};
// JPEG data-URL pictures for items, cats and trainers (same 80k cap as avatars).
const imgOk=v=>typeof v==="string"&&v.length<80000&&/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(v)?v:"";
// Sale price currently in force for an item (percent-off and expiry handled here).
const eff=i=>{const s=(i.sale|0)>0&&(i.sale|0)<i.price?(i.sale|0):0;return(s&&(!i.sends||i.sends>Date.now()))?s:i.price};
const onSale=i=>eff(i)!==i.price;
// Cats, battles and XP.
const catDef=id=>id?q("SELECT * FROM cats WHERE id=?").get(id):null;
const lvlOf=xp=>Math.floor((xp|0)/40)+1;
const abilDmg=id=>{const r=id?q("SELECT dmg FROM items WHERE id=?").get(id):null;return(r&&(r.kind==="ability")&&r.dmg>0)?r.dmg:10};
const catPower=(def,lvl,dmg)=>def.hp+(lvl-1)*10+Math.max(10,...dmg);
const roll=pw=>pw*(0.85+Math.random()*0.3);
const duel=(a,b)=>{for(let k=0;k<3;k++){const x=roll(a),y=roll(b);if(x!==y)return x>y?1:-1}return 0};
function leadOf(p){
 let o=(p.lead|0)?q("SELECT * FROM catown WHERE id=? AND pid=?").get(p.lead|0,p.id):null;
 if(!o)o=q("SELECT * FROM catown WHERE pid=? ORDER BY id LIMIT 1").get(p.id);
 if(!o)return null;
 const def=catDef(o.cat);if(!def)return null;
 const eq=q("SELECT item FROM equip WHERE pid=? AND own=?").get(p.id,o.id);
 return{own:o.id,xp:o.xp,lvl:lvlOf(o.xp),def,name:def.name,moves:[eq?eq.item:0]};
}
function grantXp(own,xp){
 const o=q("SELECT * FROM catown WHERE id=?").get(own);if(!o)return null;
 const nx=o.xp+xp,def=catDef(o.cat);let cat=o.cat,evo=null;
 if(def&&def.evo&&def.evolv>0&&lvlOf(nx)>=def.evolv&&catDef(def.evo)){cat=def.evo;evo=catDef(def.evo).name;q("UPDATE catown SET xp=?,cat=? WHERE id=?").run(0,cat,own)}
 else q("UPDATE catown SET xp=? WHERE id=?").run(nx,own);
 return{evo,lvl:lvlOf(evo?0:nx)};
}
const actions={
 send(p,b){const t=String(b.text||"").trim().slice(0,300);if(!t)bad("Empty message");
  if(Date.now()-(lastMsg.get(p.id)||0)<500)bad("Slow down");lastMsg.set(p.id,Date.now());post(p.name,t,0)},
 pay(p,b){const t=find(b.to),n=parseInt(b.amt);
  if(!t||t.banned||t.id===p.id)bad("Pick another player by name");if(!(n>=1&&n<=1e9))bad("Enter an amount between 1 and 1,000,000,000");
  if(!inf(p)){if(p.coins<n)bad("You don’t have that many coins");q("UPDATE players SET coins=coins-? WHERE id=?").run(n,p.id)}
  q("UPDATE players SET coins=coins+? WHERE id=?").run(n,t.id);post(p.name,`${p.name} sent ${n} coins to ${t.name}`)},
 daily(p){if(Date.now()-p.daily<864e5)bad("Daily bonus isn’t ready yet");q("UPDATE players SET coins=coins+50,daily=? WHERE id=?").run(Date.now(),p.id)},
 buy(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i)bad("That item is gone");if(i.stock===0)bad("Sold out");if(i.seller&&i.seller===p.id)bad("You can’t buy your own item");
  const price=eff(i),sale=onSale(i);
  if(!inf(p)&&p.coins<price)bad("Not enough coins");
  const inv=JSON.parse(p.inv);inv[i.id]=(inv[i.id]||0)+1;
  q("UPDATE players SET coins=coins-?,inv=? WHERE id=?").run(inf(p)?0:price,JSON.stringify(inv),p.id);
  const sl=i.seller?find(i.seller):null;if(sl)q("UPDATE players SET coins=coins+? WHERE id=?").run(price,sl.id);
  if(i.stock>0)q("UPDATE items SET stock=stock-1 WHERE id=?").run(i.id);
  post(p.name,`${p.name} bought ${i.emoji} ${i.name} for ${price} coins${sale?` (was ${i.price})`:""}${i.kind==="physical"?" (a real one!)":""}${sl?` from ${sl.name}`:""}`)},
 "item/sell"(p,b){const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give your item a name");
  const price=parseInt(b.price);if(!(price>=1&&price<=1e6))bad("Price must be between 1 and 1,000,000");
  const qty=Math.max(1,Math.min(99,parseInt(b.qty)||1));
  if(!p.admin&&q("SELECT COUNT(*) c FROM items WHERE seller=? AND stock!=0").get(p.id).c>=MAX_SELL)bad(`You can only have ${MAX_SELL} items for sale at once`);
  q("INSERT INTO items(name,emoji,img,descr,price,stock,kind,seller) VALUES(?,?,?,?,?,?,?,?)").run(name,emoji(b.emoji),imgOk(b.img),String(b.desc||"").trim().slice(0,80),price,qty,["physical","fun"].includes(b.kind)?b.kind:"normal",p.id)},
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
  if(i.stock>0)q("UPDATE items SET stock=stock+1 WHERE id=?").run(i.id);
  post(p.name,`${p.name} sold a ${i.emoji} ${i.name} for ${got} coins`)},
 discard(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||i.kind!=="fun")bad("You can only get rid of fun items");
  const inv=JSON.parse(p.inv);if(!inv[i.id])bad("You don’t have that");
  if(--inv[i.id]<=0)delete inv[i.id];
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(inv),p.id);post(p.name,`${p.name} got rid of a ${i.emoji} ${i.name}`)},
 infinite(p,b){root(p);q("UPDATE players SET infinite=? WHERE id=?").run(b.on?1:0,p.id)},
 "item/add"(p,b){adm(p);const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give the item a name");
  const st=parseInt(b.stock),price=Math.max(1,Math.min(1e6,parseInt(b.price)||1)),kind=["physical","fun","ability"].includes(b.kind)?b.kind:"normal";
  q("INSERT INTO items(name,emoji,img,descr,price,stock,kind,dmg,atype) VALUES(?,?,?,?,?,?,?,?,?)").run(name,emoji(b.emoji),imgOk(b.img),String(b.desc||"").trim().slice(0,80),price,st>0?st:-1,kind,kind==="ability"?Math.max(1,parseInt(b.dmg)||1):0,String(b.atype||"").trim().slice(0,12)||"normal")},
 "item/remove"(p,b){adm(p);q("DELETE FROM items WHERE id=?").run(parseInt(b.id))},
 "item/sale"(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));if(!i)bad("That item is gone");
  if(!(p.admin||(i.seller&&i.seller===p.id)))bad("Only the seller or an admin can do that");
  const v=b.price==null||b.price===""?0:parseInt(b.price);
  if(!v){q("UPDATE items SET sale=NULL,sends=0 WHERE id=?").run(i.id);post(p.name,`${p.name} ended the sale on ${i.emoji} ${i.name}`);return}
  if(!(v>=1&&v<i.price))bad("Sale price must be below the current price");
  const hrs=parseFloat(b.ends)||0;if(!(hrs>=0&&hrs<=720))bad("Sale length must be 0–720 hours");
  q("UPDATE items SET sale=?,sends=? WHERE id=?").run(v,hrs>0?Date.now()+Math.round(hrs*36e5):0,i.id);
  post(p.name,`${p.name} put ${i.emoji} ${i.name} on sale: ${v} coins (was ${i.price})${hrs>0?` for ${hrs}h`:""}`)},
 give(p,b){const t=find(b.to),id=parseInt(b.id),n=parseInt(b.n);
  if(!t||t.banned||t.id===p.id)bad("Pick another player by name");if(!(n>=1&&n<=99))bad("Enter 1–99");
  const i=q("SELECT * FROM items WHERE id=?").get(id);if(!i)bad("That item is gone");
  const inv=JSON.parse(p.inv);if(!(inv[id]>=n))bad("You don’t have that many");
  const tinv=JSON.parse(t.inv);inv[id]-=n;if(inv[id]<=0)delete inv[id];tinv[id]=(tinv[id]||0)+n;
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(inv),p.id);
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(tinv),t.id);
  post(p.name,`${p.name} gave ${n}× ${i.emoji} ${i.name} to ${t.name}`)},
 "cat/add"(p,b){adm(p);const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give the cat a name");
  const hp=Math.max(1,Math.min(9999,parseInt(b.hp)||50)),price=Math.max(0,Math.min(1e6,parseInt(b.price)||0)),st=parseInt(b.stock);
  const em=Array.from(String(b.emoji||"").trim()).slice(0,2).join("")||"🐱",evo=parseInt(b.evo)||0;if(evo&&!catDef(evo))bad("Evolution target not found");
  q("INSERT INTO cats(name,descr,emoji,img,hp,price,stock,type1,type2,rarity,shop,evo,evolv) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(name,String(b.descr||"").trim().slice(0,120),em,imgOk(b.img),hp,price,st>0?st:-1,String(b.type1||"normal").trim().slice(0,12)||"normal",String(b.type2||"").trim().slice(0,12),String(b.rarity||"").trim().slice(0,16),b.shop===0||b.shop==="0"?0:1,evo,Math.max(0,Math.min(100,parseInt(b.evolv)||0)))},
 "cat/shop"(p,b){adm(p);const c=catDef(parseInt(b.id));if(!c)bad("That cat is gone");q("UPDATE cats SET shop=? WHERE id=?").run(c.shop?0:1,c.id)},
 "cat/buy"(p,b){const c=catDef(parseInt(b.id));if(!c||!c.shop)bad("That cat isn’t for sale");if(c.stock===0)bad("Sold out");
  if(!inf(p)&&p.coins<c.price)bad("Not enough coins");
  q("UPDATE players SET coins=coins-? WHERE id=?").run(inf(p)?0:c.price,p.id);
  const own=q("INSERT INTO catown(pid,cat) VALUES(?,?)").run(p.id,c.id).lastInsertRowid;
  if(c.stock>0)q("UPDATE cats SET stock=stock-1 WHERE id=?").run(c.id);
  if(!(p.lead|0))q("UPDATE players SET lead=? WHERE id=?").run(own,p.id);
  post(p.name,`${p.name} adopted ${c.emoji||"🐱"} ${c.name}`)},
 "cat/lead"(p,b){const o=q("SELECT * FROM catown WHERE id=? AND pid=?").get(parseInt(b.own),p.id);if(!o)bad("Pick one of your cats");
  q("UPDATE players SET lead=? WHERE id=?").run(o.id,p.id)},
 equip(p,b){const o=q("SELECT * FROM catown WHERE id=? AND pid=?").get(parseInt(b.own),p.id);if(!o)bad("Pick one of your cats");
  const it=parseInt(b.item)||0;
  if(!it){q("DELETE FROM equip WHERE pid=? AND own=?").run(p.id,o.id);return}
  const r=q("SELECT * FROM items WHERE id=?").get(it);if(!r||r.kind!=="ability")bad("That isn’t an ability");
  if(!(JSON.parse(p.inv)[it]>=1))bad("You don’t own that ability");
  q("INSERT OR REPLACE INTO equip(pid,own,item) VALUES(?,?,?)").run(p.id,o.id,it)},
 "pack/add"(p,b){adm(p);const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give the pack a name");
  const st=parseInt(b.stock),price=Math.max(0,Math.min(1e6,parseInt(b.price)||0));
  const data=Array.isArray(b.data)?b.data:[];if(!data.length||data.length>12)bad("Add 1–12 drops");
  const drops=data.map(d=>{const t=d.t==="cat"?"cat":"item",id=parseInt(d.id);
   if(!(t==="cat"?catDef(id):q("SELECT * FROM items WHERE id=?").get(id)))bad("Unknown pack drop");
   return{t,id,n:Math.max(1,Math.min(99,parseInt(d.n)||1)),ch:Math.max(1,Math.min(100,parseFloat(d.ch)||1))}});
  q("INSERT INTO packs(name,descr,emoji,img,price,stock,data) VALUES(?,?,?,?,?,?,?)").run(name,String(b.descr||"").trim().slice(0,120),emoji(b.emoji),imgOk(b.img),price,st>0?st:-1,JSON.stringify(drops))},
 "pack/buy"(p,b){const k=q("SELECT * FROM packs WHERE id=?").get(parseInt(b.id));if(!k)bad("That pack is gone");if(k.stock===0)bad("Sold out");
  if(!inf(p)&&p.coins<k.price)bad("Not enough coins");
  const drops=JSON.parse(k.data||"[]");if(!drops.length)bad("That pack is empty");
  let x=Math.random()*drops.reduce((a,d)=>a+d.ch,0),pick=drops[0];for(const d of drops){x-=d.ch;if(x<=0){pick=d;break}}
  q("UPDATE players SET coins=coins-? WHERE id=?").run(inf(p)?0:k.price,p.id);
  let got;
  if(pick.t==="cat"){const c=catDef(pick.id);if(!c)bad("That pack is empty");q("INSERT INTO catown(pid,cat) VALUES(?,?)").run(p.id,c.id);got=`${c.emoji||"🐱"} ${c.name}`}
  else{const inv=JSON.parse(p.inv);inv[pick.id]=(inv[pick.id]||0)+pick.n;q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(inv),p.id);
   const r=q("SELECT * FROM items WHERE id=?").get(pick.id);got=`${pick.n}× ${r?r.emoji:"🎁"} ${r?r.name:"item"}`}
  if(k.stock>0)q("UPDATE packs SET stock=stock-1 WHERE id=?").run(k.id);
  post(p.name,`${p.name} opened ${k.emoji} ${k.name} and found ${got}!`)},
 "pack/remove"(p,b){adm(p);q("DELETE FROM packs WHERE id=?").run(parseInt(b.id))},
 "wild/add"(p,b){adm(p);const c=catDef(parseInt(b.cat));if(!c)bad("Pick a cat");
  const moves=(Array.isArray(b.moves)?b.moves:[]).slice(0,4).map(m=>{const r=q("SELECT * FROM items WHERE id=?").get(parseInt(m));return(r&&r.kind==="ability")?r.id:0});
  q("INSERT INTO wilds(cat,lvl,moves) VALUES(?,?,?)").run(c.id,Math.max(1,Math.min(100,parseInt(b.lvl)||1)),JSON.stringify(moves))},
 "wild/remove"(p,b){adm(p);q("DELETE FROM wilds WHERE id=?").run(parseInt(b.id))},
 "trainer/add"(p,b){adm(p);const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give the trainer a name");
  const team=Array.isArray(b.team)?b.team:[];if(!team.length||team.length>6)bad("Add 1–6 team cats");
  const t=team.map(m=>{const c=catDef(parseInt(m.cat));if(!c)bad("Unknown team cat");
   return{cat:c.id,lvl:Math.max(1,Math.min(100,parseInt(m.lvl)||1)),moves:(Array.isArray(m.moves)?m.moves:[]).slice(0,4).map(x=>{const r=q("SELECT * FROM items WHERE id=?").get(parseInt(x));return(r&&r.kind==="ability")?r.id:0})}});
  q("INSERT INTO trainers(name,img,reward,team) VALUES(?,?,?,?)").run(name,imgOk(b.img),Math.max(0,Math.min(1e6,parseInt(b.reward)||0)),JSON.stringify(t))},
 "trainer/remove"(p,b){adm(p);q("DELETE FROM trainers WHERE id=?").run(parseInt(b.id));q("DELETE FROM wins WHERE trainer=?").run(parseInt(b.id))},
 "battle/player"(p,b){const t=find(b.to);if(!t||t.banned||t.id===p.id)bad("Pick another player to challenge");
  const bet=parseInt(b.bet);if(!(bet>=1&&bet<=1e6))bad("Bet 1–1,000,000 coins");
  const A=leadOf(p);if(!A)bad("Pick your lead cat on the Battle tab first");
  const B=leadOf(t);if(!B)bad(`${t.name} has no cats to fight with`);
  if(!inf(p)&&p.coins<bet)bad("You don’t have that many coins");
  if(!inf(t)&&t.coins<bet)bad(`${t.name} doesn’t have that many coins`);
  const r=duel(catPower(A.def,A.lvl,A.moves.map(abilDmg)),catPower(B.def,B.lvl,B.moves.map(abilDmg)));
  if(!r){grantXp(A.own,5);grantXp(B.own,5);post(p.name,`⚔️ ${p.name} drew with ${t.name} (${A.name} vs ${B.name}). No coins changed hands.`);return}
  const W=r>0?p:t,L=r>0?t:p,WA=r>0?A:B,LA=r>0?B:A;
  if(!inf(L))q("UPDATE players SET coins=coins-? WHERE id=?").run(bet,L.id);
  if(!inf(W))q("UPDATE players SET coins=coins+? WHERE id=?").run(bet,W.id);
  const e1=grantXp(WA.own,20),e2=grantXp(LA.own,8);
  post(p.name,`⚔️ ${W.name} beat ${L.name} (${WA.name} vs ${LA.name}) and won ${bet} coins!${e1&&e1.evo?` ${WA.name} evolved into ${e1.evo}!`:""}${e2&&e2.evo?` ${LA.name} evolved into ${e2.evo}!`:""}`)},
 "battle/wild"(p,b){const w=q("SELECT * FROM wilds WHERE id=?").get(parseInt(b.id));if(!w)bad("That wild cat is gone");
  const A=leadOf(p);if(!A)bad("Pick your lead cat on the Battle tab first");
  const def=catDef(w.cat);if(!def)bad("That wild cat is gone");
  const moves=JSON.parse(w.moves||"[]").map(abilDmg);
  const r=duel(catPower(A.def,A.lvl,A.moves.map(abilDmg)),catPower(def,w.lvl,moves));
  if(r>0){q("INSERT INTO catown(pid,cat) VALUES(?,?)").run(p.id,def.id);
   if(!inf(p))q("UPDATE players SET coins=coins+? WHERE id=?").run(w.lvl*10,p.id);
   const e=grantXp(A.own,20);
   post(p.name,`🌿 ${p.name} beat the wild ${def.name} (Lv ${w.lvl}) and caught it! (+${w.lvl*10} coins)${e&&e.evo?` ${A.name} evolved into ${e.evo}!`:""}`)}
  else{grantXp(A.own,5);post(p.name,`🌿 The wild ${def.name} (Lv ${w.lvl}) beat ${p.name}’s ${A.name}. (+5 XP)`)}},
 "battle/trainer"(p,b){const tr=q("SELECT * FROM trainers WHERE id=?").get(parseInt(b.id));if(!tr)bad("That trainer is gone");
  const team=JSON.parse(tr.team||"[]");if(!team.length)bad("That trainer has no team");
  const A=leadOf(p);if(!A)bad("Pick your lead cat on the Battle tab first");
  const apw=catPower(A.def,A.lvl,A.moves.map(abilDmg));
  let won=true;for(const m of team){const def=catDef(m.cat);if(!def){won=false;break}
   if(duel(apw,catPower(def,m.lvl||1,(m.moves||[]).map(abilDmg)))<0){won=false;break}}
  if(!won){grantXp(A.own,5);post(p.name,`🏟️ Trainer ${tr.name} beat ${p.name}’s ${A.name}. (+5 XP)`);return}
  const first=!q("SELECT 1 FROM wins WHERE pid=? AND trainer=?").get(p.id,tr.id);
  const reward=first?tr.reward:Math.floor(tr.reward*0.1);
  if(reward>0&&!inf(p))q("UPDATE players SET coins=coins+? WHERE id=?").run(reward,p.id);
  if(first)q("INSERT OR IGNORE INTO wins(pid,trainer) VALUES(?,?)").run(p.id,tr.id);
  const e=grantXp(A.own,25);
  post(p.name,`🏆 ${p.name} beat trainer ${tr.name}!${reward>0?` (+${reward} coins${first?" first win":""})`:""}${e&&e.evo?` ${A.name} evolved into ${e.evo}!`:""}`)},
 "trade/send"(p,b){const t=find(b.to);if(!t||t.banned||t.id===p.id)bad("Pick another player by name");
  const clean=o=>{const items={},cats=[];
   for(const[k,v]of Object.entries((o&&o.items)||{})){const id=parseInt(k),n=parseInt(v);if(id>0&&n>=1&&n<=99)items[id]=n}
   for(const c of((o&&o.cats)||[])){const id=parseInt(c);if(id>0)cats.push(id)}
   return{items,cats}};
  const give=clean(b.give),want=clean(b.want);
  if(!Object.keys(give.items).length&&!give.cats.length)bad("Offer at least one item or cat");
  const inv=JSON.parse(p.inv);
  for(const[id,n]of Object.entries(give.items))if(!(inv[id]>=n))bad("You don’t have everything you offered");
  for(const id of give.cats)if(!q("SELECT 1 FROM catown WHERE id=? AND pid=?").get(id,p.id))bad("You don’t own every cat you offered");
  q("INSERT INTO trades(frm,too,give,want,ts) VALUES(?,?,?,?,?)").run(p.id,t.id,JSON.stringify(give),JSON.stringify(want),Date.now());
  post(p.name,`${p.name} sent a trade offer to ${t.name}`)},
 "trade/answer"(p,b){const tr=q("SELECT * FROM trades WHERE id=?").get(parseInt(b.id));
  if(!tr||tr.status!=="open"||tr.too!==p.id)bad("That offer is gone");
  const frm=find(tr.frm);if(!frm||frm.banned){q("UPDATE trades SET status='gone' WHERE id=?").run(tr.id);bad("That player is gone")}
  const give=JSON.parse(tr.give),want=JSON.parse(tr.want);
  if(!b.ok){q("UPDATE trades SET status='declined' WHERE id=?").run(tr.id);post(p.name,`${p.name} declined ${frm.name}’s trade offer`);return}
  const finv=JSON.parse(frm.inv),tinv=JSON.parse(p.inv);
  for(const[id,n]of Object.entries(give.items))if(!(finv[id]>=n))bad(`${frm.name} no longer has everything offered`);
  for(const[id,n]of Object.entries(want.items))if(!(tinv[id]>=n))bad("You no longer have everything they asked for");
  for(const id of give.cats)if(!q("SELECT 1 FROM catown WHERE id=? AND pid=?").get(id,frm.id))bad(`${frm.name} no longer has every offered cat`);
  for(const id of want.cats)if(!q("SELECT 1 FROM catown WHERE id=? AND pid=?").get(id,p.id))bad("You no longer have every cat they asked for");
  for(const[id,n]of Object.entries(give.items)){finv[id]-=n;if(finv[id]<=0)delete finv[id];tinv[id]=(tinv[id]||0)+n}
  for(const[id,n]of Object.entries(want.items)){tinv[id]-=n;if(tinv[id]<=0)delete tinv[id];finv[id]=(finv[id]||0)+n}
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(finv),frm.id);
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(tinv),p.id);
  for(const id of[...give.cats,...want.cats]){
   const owner=give.cats.includes(id)?frm.id:p.id,other=owner===frm.id?p.id:frm.id;
   q("UPDATE catown SET pid=? WHERE id=?").run(other,id);
   q("DELETE FROM equip WHERE own=?").run(id);
   q("UPDATE players SET lead=0 WHERE id=? AND lead=?").run(owner,id)}
  q("UPDATE trades SET status='done' WHERE id=?").run(tr.id);
  post(p.name,`${p.name} accepted ${frm.name}’s trade offer`)},
 "trade/cancel"(p,b){const tr=q("SELECT * FROM trades WHERE id=?").get(parseInt(b.id));
  if(!tr||tr.status!=="open"||tr.frm!==p.id)bad("That offer is gone");
  q("DELETE FROM trades WHERE id=?").run(tr.id)},
 "word/add"(p,b){adm(p);const w=String(b.word||"").toLowerCase().trim();
  if(!/^[a-z0-9_]{1,16}$/.test(w))bad("Words are 1–16 letters, numbers or underscores");
  q("INSERT OR IGNORE INTO words(word) VALUES(?)").run(w)},
 "word/remove"(p,b){adm(p);q("DELETE FROM words WHERE word=?").run(String(b.word||"").toLowerCase())},
 "admin/promote"(p,b){adm(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t change that player");
  q("UPDATE players SET admin=? WHERE id=?").run(t.admin?0:1,t.id);post(p.name,`${t.name} ${t.admin?"is no longer":"is now"} an admin`)},
 "admin/give"(p,b){root(p);const t=find(b.to),n=parseInt(b.n);if(!t||!(Math.abs(n)>=1&&Math.abs(n)<=1e9))bad("Pick a player and an amount");
  q("UPDATE players SET coins=MAX(0,coins+?) WHERE id=?").run(n,t.id);post(p.name,`${p.name} ${n>0?"gave":"took"} ${Math.abs(n)} coins ${n>0?"to":"from"} ${t.name}`)},
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
 return{id:p.id,name:p.name,coins:p.coins,admin:!!p.admin,banned:!!p.banned,inf:p.id===ROOT&&!!p.infinite,avatar:Object.keys(a).length?{...a,photo:p.photo?`/avatar/${p.id}?v=${p.pv}`:""}:undefined,inv:JSON.parse(p.inv||"{}"),cowns:q("SELECT o.id own,o.cat FROM catown o WHERE o.pid=?").all(p.id).map(r=>({own:r.own,cat:r.cat}))}};
const snapshot=()=>JSON.stringify({
 players:q("SELECT * FROM players").all().map(pub),
 items:q("SELECT * FROM items").all().map(i=>({id:i.id,name:i.name,emoji:i.emoji,img:i.img||"",desc:i.descr,price:i.price,sale:i.sale||0,sends:i.sends||0,stock:i.stock,kind:i.kind||"normal",dmg:i.dmg||0,atype:i.atype||"",seller:i.seller||""})),
 cats:q("SELECT * FROM cats").all().map(c=>({id:c.id,name:c.name,descr:c.descr||"",emoji:c.emoji||"🐱",img:c.img||"",hp:c.hp,price:c.price,stock:c.stock,type1:c.type1||"normal",type2:c.type2||"",rarity:c.rarity||"",shop:!!c.shop,evo:c.evo||0,evolv:c.evolv||0})),
 packs:q("SELECT * FROM packs").all().map(k=>({id:k.id,name:k.name,descr:k.descr||"",emoji:k.emoji||"🎁",img:k.img||"",price:k.price,stock:k.stock,data:JSON.parse(k.data||"[]")})),
 wilds:q("SELECT * FROM wilds").all().map(w=>({id:w.id,cat:w.cat,lvl:w.lvl,moves:JSON.parse(w.moves||"[]")})),
 trainers:q("SELECT * FROM trainers").all().map(t=>({id:t.id,name:t.name,img:t.img||"",reward:t.reward,team:JSON.parse(t.team||"[]")})),
 messages:q("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 80) ORDER BY id").all()});
function sendTo(c,base){const m=find(c.pid);if(!m)return;
 const cats=q("SELECT o.id own,o.xp,c.* FROM catown o JOIN cats c ON c.id=o.cat WHERE o.pid=? ORDER BY o.id").all(c.pid).map(r=>({own:r.own,cat:r.id,xp:r.xp,lvl:lvlOf(r.xp),name:r.name,emoji:r.emoji,img:r.img,hp:r.hp,type1:r.type1,type2:r.type2,rarity:r.rarity,evo:r.evo,evolv:r.evolv}));
 const eq={};for(const r of q("SELECT own,item FROM equip WHERE pid=?").all(m.id))eq[r.own]=r.item;
 const trades=q("SELECT * FROM trades WHERE status='open' AND (frm=? OR too=?) ORDER BY id DESC").all(m.id,m.id).map(t=>({id:t.id,frm:t.frm,too:t.too,give:JSON.parse(t.give),want:JSON.parse(t.want),ts:t.ts}));
 c.res.write("event: state\ndata: "+base.slice(0,-1)+',"me":'+JSON.stringify({inv:JSON.parse(m.inv),daily:m.daily,lead:m.lead||0,cats,equip:eq,trades,words:m.admin?q("SELECT word FROM words ORDER BY word").all().map(r=>r.word):undefined,blocked:m.id===ROOT?q("SELECT id FROM blocked").all().map(r=>r.id):undefined})+"}\n\n")}
function push(){scheduleSave();if(!clients.size)return;const base=snapshot();for(const c of clients)sendTo(c,base)}
setInterval(()=>{for(const c of clients)c.res.write(": ping\n\n")},25000);

// ---- http
const INDEX=fs.readFileSync(path.join(__dirname,"index.html"));
const CSP="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const SEC={"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Resource-Policy":"same-origin"};
const clientIp=req=>(req.headers["x-forwarded-for"]||"").split(",")[0].trim()||req.headers["fly-client-ip"]||req.socket.remoteAddress||"";
const J=(res,code,o)=>{res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store",...SEC});res.end(JSON.stringify(o))};
const readBody=req=>new Promise((ok,no)=>{let n=0;const c=[];
 req.on("data",d=>{n+=d.length;if(n>150e3){no(new E("That’s too large"));req.destroy()}else c.push(d)});
 req.on("end",()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||"{}"))}catch(e){no(new E("Bad request"))}});
 req.on("error",no)});

http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://x");
 try{
  if(req.method==="GET"){
   if(url.pathname==="/"||url.pathname==="/index.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":CSP,"Referrer-Policy":"no-referrer",...SEC});return res.end(INDEX)}
   if(url.pathname==="/healthz"){res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store",...SEC});return res.end("ok")}
   if(url.pathname==="/api/config")return J(res,200,{root:ROOT,maxSell:MAX_SELL});
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
   const ip=clientIp(req);
   if(throttled(ip))return J(res,429,{error:"Too many requests. Slow down."});
   if(act==="login"){const r=login(b,ip);push();return J(res,200,r)}
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
