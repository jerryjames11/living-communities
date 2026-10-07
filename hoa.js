'use strict';
// HOA program: sponsored (HOA-paid) Plus seats for homeowners, billed per ACTIVE home.
//
// Rules in one place:
//  - The HOA roster (hoa_homes) is the billing source of truth. A home is billable only when it is
//    on the roster AND a homeowner has joined through the HOA join link (state 'active').
//  - 90-day free pilot (pilot_end). After it, billable = max(active homes on the 1st, floor), capped
//    by seat_cap when set. floor = floor_pct% of the active count when the pilot ended; sold/rented
//    removals lower it by one each, other removals do not.
//  - Removals need a reason and take effect on the next billing date (the 1st). Homeowners keep their
//    data when sponsorship ends; Plus features lock and they can keep Plus themselves.
//  - HOA contacts (role 'hoa') only ever see addresses and status, never homeowner names/contact info.
module.exports=function initHoa(D){
const {pool,q,q1,id,sendEmail,emailShell,btn,esc_,APP_URL,send,body,mapUser,safeUser,crypto,hash,newSalt,geocodeAddress,sessions,hashInviteToken,INVITE_TTL_MS,adminNotifyEmail}=D;

class HttpErr extends Error{ constructor(status,msg,extra){ super(msg); this.status=status; this.extra=extra||{}; } }
const bad=(msg,extra)=>new HttpErr(400,msg,extra);

// ---------- dates (all stored as YYYY-MM-DD text, UTC) ----------
const pad=n=>String(n).padStart(2,'0');
const dstr=d=>`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
const firstOfMonth=d=>dstr(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)));
const firstOfNextMonth=d=>dstr(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)));
const addDays=(s,n)=>{ const d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return dstr(d); };
const daysBetween=(a,b)=>Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000);
const isDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
const money=c=>'$'+(Number(c||0)/100).toFixed(2);
const fmtDay=s=>s?new Date(s+'T00:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}):'';

// ---------- addresses ----------
const SUFFIX={street:'st',avenue:'ave',boulevard:'blvd',drive:'dr',road:'rd',lane:'ln',court:'ct',circle:'cir',place:'pl',trail:'trl',parkway:'pkwy',terrace:'ter',highway:'hwy',way:'way',loop:'loop',cove:'cv',path:'path',run:'run',crossing:'xing',square:'sq'};
const SUFFIX_SET=new Set(Object.values(SUFFIX).concat(['st','ave','blvd','dr','rd','ln','ct','cir','pl','trl','pkwy','ter','hwy','cv','xing','sq']));
const DIRS={north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw'};
const DIR_SET=new Set(Object.values(DIRS));
function addressKey(a){
  let s=String(a||'').toLowerCase().split(',')[0];
  s=s.replace(/\b(apt|apartment|unit|ste|suite)\b.*$/,' ').replace(/#.*$/,' ').replace(/[^a-z0-9 ]/g,' ');
  const t=s.split(/\s+/).filter(Boolean).map(w=>SUFFIX[w]||DIRS[w]||w);
  // Drop trailing city/state/zip when the whole address was typed without commas.
  let cut=-1; for(let i=2;i<t.length;i++){ if(SUFFIX_SET.has(t[i])){ cut=i; break; } }
  if(cut>=0){ let end=cut+1; if(DIR_SET.has(t[end])) end++; return t.slice(0,end).join(' '); }
  return t.join(' ');
}
const hasStreetNumber=a=>/^\s*\d+[a-z]?\s+[a-z]/i.test(String(a||''));
function haversineMi(lat1,lng1,lat2,lng2){
  const R=3958.8, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLng=rad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function newJoinCode(){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; const b=crypto.randomBytes(8); for(let i=0;i<8;i++) s+=A[b[i]%A.length]; return s; }
const joinLinkFor=org=>`${APP_URL}/#join=${org.join_code}`;
const PORTAL_LINK=`${APP_URL}/#hoa`;
const confirmSecret=()=>process.env.HOA_TOKEN_SECRET||process.env.INTERNAL_JOB_KEY||process.env.DATABASE_URL||'hoa-dev-secret';
const confirmToken=orgId=>orgId+'.'+crypto.createHmac('sha256',confirmSecret()).update('confirm:'+orgId).digest('hex').slice(0,32);
function verifyConfirmToken(t){
  const [orgId,sig]=String(t||'').split('.'); if(!orgId||!sig) return null;
  const good=crypto.createHmac('sha256',confirmSecret()).update('confirm:'+orgId).digest('hex').slice(0,32);
  try{ if(sig.length===good.length && crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(good))) return orgId; }catch(e){}
  return null;
}

// ---------- schema ----------
async function initSchema(){
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hoa_org_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sponsored_org_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sponsor_ended_name text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sponsor_ended_at timestamptz`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hoa_orgs (
      id text PRIMARY KEY,
      name text NOT NULL,
      join_code text UNIQUE NOT NULL,
      status text NOT NULL DEFAULT 'pilot',
      price_cents integer NOT NULL DEFAULT 699,
      pilot_start text,
      pilot_end text,
      seat_cap integer,
      floor_pct integer NOT NULL DEFAULT 50,
      floor_seats integer NOT NULL DEFAULT 0,
      floor_set boolean NOT NULL DEFAULT false,
      boundary_address text,
      center_lat numeric,
      center_lng numeric,
      radius_mi numeric,
      last_confirmed_at timestamptz,
      last_confirm_reminder_at timestamptz,
      confirm_reminders integer NOT NULL DEFAULT 0,
      notes text NOT NULL DEFAULT '',
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS hoa_homes (
      id text PRIMARY KEY,
      org_id text NOT NULL REFERENCES hoa_orgs(id),
      address text NOT NULL,
      address_key text NOT NULL,
      user_id text REFERENCES users(id),
      state text NOT NULL DEFAULT 'listed',
      source text NOT NULL DEFAULT 'hoa',
      joined_at timestamptz,
      ended_at timestamptz,
      end_reason text,
      removal_effective_at text,
      removal_reason text,
      created_at timestamptz DEFAULT now(),
      UNIQUE(org_id,address_key)
    );
    CREATE TABLE IF NOT EXISTS hoa_changes (
      id text PRIMARY KEY,
      org_id text NOT NULL REFERENCES hoa_orgs(id),
      home_id text,
      address text,
      kind text NOT NULL,
      reason text,
      note text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      flagged boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'new',
      actor_id text,
      actor_name text,
      actor_role text,
      created_at timestamptz DEFAULT now(),
      resolved_by text,
      resolved_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS hoa_invoices (
      id text PRIMARY KEY,
      org_id text NOT NULL REFERENCES hoa_orgs(id),
      period text NOT NULL,
      active_count integer NOT NULL DEFAULT 0,
      floor_seats integer NOT NULL DEFAULT 0,
      billable integer NOT NULL DEFAULT 0,
      price_cents integer NOT NULL DEFAULT 0,
      amount_cents integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'preview',
      preview_sent_at timestamptz,
      issued_at timestamptz,
      paid_at timestamptz,
      note text,
      created_at timestamptz DEFAULT now(),
      UNIQUE(org_id,period)
    );
    CREATE INDEX IF NOT EXISTS hoa_homes_user_idx ON hoa_homes(user_id);
    CREATE INDEX IF NOT EXISTS hoa_homes_org_idx ON hoa_homes(org_id,state);
    CREATE INDEX IF NOT EXISTS hoa_changes_org_idx ON hoa_changes(org_id,created_at DESC);
  `);
}

// ---------- billing math ----------
function computeBilling(org,active,period){
  const price=org.price_cents||699;
  if(org.status==='paused') return {active,floor:0,billable:0,amountCents:0,price,mode:'paused'};
  if(org.pilot_end && period<=org.pilot_end) return {active,floor:0,billable:0,amountCents:0,price,mode:'pilot'};
  const floor=org.floor_set?(org.floor_seats||0):0;
  let billable=Math.max(active,floor);
  let capped=false;
  if(org.seat_cap!=null && billable>org.seat_cap){ billable=org.seat_cap; capped=true; }
  return {active,floor,billable,amountCents:billable*price,price,mode:capped?'capped':(billable>active?'floor':'active')};
}
async function periodActive(orgId,period){
  const r=await q1("SELECT count(*)::int AS n FROM hoa_homes WHERE org_id=$1 AND state='active' AND (removal_effective_at IS NULL OR removal_effective_at>$2)",[orgId,period]);
  return r.n;
}
async function orgStats(orgId){
  return q1(`SELECT
    count(*) FILTER (WHERE state<>'ended')::int AS roster,
    count(*) FILTER (WHERE state='active')::int AS active,
    count(*) FILTER (WHERE state='listed')::int AS not_joined,
    count(*) FILTER (WHERE state='review')::int AS review,
    count(*) FILTER (WHERE state='active' AND removal_effective_at IS NOT NULL)::int AS ending,
    count(*) FILTER (WHERE state='ended')::int AS ended
    FROM hoa_homes WHERE org_id=$1`,[orgId]);
}
const getOrg=orgId=>q1('SELECT * FROM hoa_orgs WHERE id=$1',[orgId]);
const orgContacts=orgId=>q("SELECT * FROM users WHERE role='hoa' AND hoa_org_id=$1 AND suspended=false AND deleted=false ORDER BY created_at",[orgId]);

// ---------- emails ----------
const para=t=>`<p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;margin:0 0 12px">${t}</p>`;
const h2=t=>`<h2 style="margin:0 0 10px;color:#17352f">${t}</h2>`;
function contactInviteHtml(name,orgName,inviterName,link){
  return emailShell('You have been invited to manage your HOA on Living Communities',h2(`Hi ${esc_(name)}, you're invited`)+para(`${esc_(inviterName)} added you as an HOA contact for <b>${esc_(orgName)}</b>. From the HOA portal you can see which homes have joined, keep your roster current, and review your invoices. Set your password to get started. This link works for 7 days.`)+btn('Set my password',link)+`<p style="color:#6b7a75;font-size:12.5px;margin-top:16px">If you weren't expecting this, ignore this email.</p>`);
}
function joinInviteHtml(org,link){
  return emailShell('Your HOA covers Living Communities Plus for your home',h2(`${esc_(org.name)} covers Plus for your home`)+para(`Your HOA has set up Living Communities for your neighborhood. Join with the link below and your home gets Plus at no cost to you: the Home Info Database, maintenance reminders, the Neighborhood feed, and more.`)+btn('Join now',link)+`<p style="color:#6b7a75;font-size:12.5px;margin-top:16px">Create an account (or sign in) with your home address so we can match it to your HOA's list.</p>`);
}
function sponsorStartedHtml(user,orgName,review){
  return emailShell(`${orgName} covers your Plus plan`,h2(`Welcome, ${esc_(user.name.split(' ')[0])}`)+para(review?`Your HOA, <b>${esc_(orgName)}</b>, needs to confirm your address on its list. You have Plus access in the meantime.`:`Your HOA, <b>${esc_(orgName)}</b>, now covers your Plus plan. Nothing to pay.`)+btn('Open my home',APP_URL+'/#homeowner'));
}
function sponsorEndedHtml(user,orgName){
  return emailShell(`${orgName} ended your covered Plus plan`,h2('Your HOA-covered Plus plan has ended')+para(`<b>${esc_(orgName)}</b> no longer covers Plus for your home. Your account is now on the Free plan. Everything you saved, including your Home Profile and documents, is still here. Plus features are locked until you subscribe.`)+para(`You can keep Plus yourself for $9.99/month and everything unlocks right away.`)+btn('Keep Plus',APP_URL+'/#homeowner'));
}
function confirmEmailHtml(org,link){
  return emailShell('Please confirm your HOA roster',h2('Quick check: is your roster still right?')+para(`It has been a while since <b>${esc_(org.name)}</b> confirmed its list of homes. Homes that have sold or changed hands are the usual reason it drifts. One click confirms it is current. Open the portal to fix anything first.`)+btn('Confirm my roster',link)+para(`<a href="${PORTAL_LINK}" style="color:#286b58">Open the HOA portal</a>`));
}
function invoiceHtml(org,inv,kind){
  const pre=kind==='preview';
  return emailShell(pre?'Your invoice preview':'Your HOA invoice',h2(pre?`Invoice preview for ${esc_(fmtDay(inv.period))}`:`Invoice for ${esc_(fmtDay(inv.period))}`)+para(`<b>${esc_(org.name)}</b>: ${inv.billable} home${inv.billable===1?'':'s'} at ${money(inv.price_cents)} = <b>${money(inv.amount_cents)}</b>.`)+para(`${inv.active_count} home${inv.active_count===1?' is':'s are'} active${inv.floor_seats>inv.active_count?`; your agreed minimum is ${inv.floor_seats}`:''}.`)+(pre?para(`This is a preview. If a home has sold or changed hands, update your roster in the portal before ${esc_(fmtDay(inv.period))} and the next invoice will reflect it.`):para(`We will follow up with payment details. Questions? Reply to this email.`))+btn('Open the HOA portal',PORTAL_LINK));
}
function adminChangeHtml(org,ch){
  return emailShell('HOA change reported',h2(`${esc_(org.name)}: ${esc_(ch.kind.replace('_',' '))}`)+para(`${esc_(ch.address||'')}${ch.reason?` (reason: ${esc_(ch.reason)})`:''}${ch.note?`<br>${esc_(ch.note)}`:''}`)+(ch.flagged?para('<b style="color:#a33a2e">Flagged:</b> removals without a verified reason are above 10% of seats this quarter.'):'')+btn('Review in Admin',APP_URL+'/#admin'));
}
async function emailContacts(org,subject,type,html){
  const cs=await orgContacts(org.id);
  for(const c of cs){ await sendEmail({to:c.email,type,subject,html:typeof html==='function'?html(c):html,userId:c.id}).catch(()=>{}); }
  return cs.length;
}

// ---------- sponsorship ----------
async function startSponsorship(user,org,review){
  const sets=['sponsored_org_id=$1','sponsor_ended_name=NULL','sponsor_ended_at=NULL'];
  if((user.subscription||'free')==='free') sets.push("subscription='plus'");
  await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$2`,[org.id,user.id]);
  sendEmail({to:user.email,type:'hoa_sponsor_started',subject:`${org.name} covers your Plus plan`,html:sponsorStartedHtml(user,org.name,review),userId:user.id}).catch(()=>{});
}
// Ends a seat. toState 'listed' reopens it for a new owner; otherwise it is 'ended'.
async function endSponsorship(home,reason,{toState='ended',notify=true}={}){
  const org=await getOrg(home.org_id);
  if(home.user_id){
    const u=await q1('SELECT * FROM users WHERE id=$1',[home.user_id]);
    if(u && u.sponsored_org_id===home.org_id){
      const sets=['sponsored_org_id=NULL'];
      let downgraded=false;
      if(u.subscription==='plus' && !u.stripe_subscription_id){ sets.push("subscription='free'"); downgraded=true; }
      if(downgraded && reason!=='homeowner_left'){ sets.push('sponsor_ended_name=$2','sponsor_ended_at=now()'); }
      await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$1`,downgraded&&reason!=='homeowner_left'?[u.id,org?org.name:'Your HOA']:[u.id]);
      if(notify && downgraded && reason!=='homeowner_left' && !u.deleted) sendEmail({to:u.email,type:'hoa_sponsor_ended',subject:`${org?org.name:'Your HOA'} ended your covered Plus plan`,html:sponsorEndedHtml(mapUser(u),org?org.name:'Your HOA'),userId:u.id}).catch(()=>{});
    }
  }
  if(toState==='listed'){
    await pool.query("UPDATE hoa_homes SET state='listed',user_id=NULL,joined_at=NULL,ended_at=NULL,end_reason=NULL,removal_effective_at=NULL,removal_reason=NULL WHERE id=$1",[home.id]);
  }else{
    await pool.query("UPDATE hoa_homes SET state='ended',ended_at=now(),end_reason=$1,removal_effective_at=NULL,removal_reason=NULL WHERE id=$2",[reason,home.id]);
  }
}

// ---------- change log ----------
async function logChange(org,home,{kind,reason,note,actor,detail,flagged}){
  const cid=id('hch');
  const ch=await q1('INSERT INTO hoa_changes (id,org_id,home_id,address,kind,reason,note,detail,flagged,actor_id,actor_name,actor_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) RETURNING *',
    [cid,org.id,home?home.id:null,home?home.address:null,kind,reason||null,note?String(note).slice(0,500):null,JSON.stringify(detail||{}),!!flagged,actor.id,actor.name,actor.role]);
  if(adminNotifyEmail && actor.role==='hoa') sendEmail({to:adminNotifyEmail,type:'admin_hoa_change',subject:`HOA change: ${org.name}`,html:adminChangeHtml(org,ch)}).catch(()=>{});
  return ch;
}
async function unverifiedRemovalFlag(orgId){
  const r=await q1("SELECT count(*)::int AS n FROM hoa_changes WHERE org_id=$1 AND created_at>now()-interval '90 days' AND (detail->>'unverified')='true' AND status<>'reversed'",[orgId]);
  const s=await orgStats(orgId);
  return r.n/Math.max(1,s.active+r.n)>0.10;
}

// ---------- roster ----------
async function addHomes(org,addresses,source='hoa'){
  const list=(Array.isArray(addresses)?addresses:String(addresses||'').split(/\r?\n/)).map(a=>String(a||'').trim().replace(/\s+/g,' ')).filter(Boolean);
  if(!list.length) throw bad('Add at least one address.');
  if(list.length>2000) throw bad('Add up to 2,000 addresses at a time.');
  let added=0, skipped=0; const invalid=[];
  for(const a of list){
    const addr=a.slice(0,200);
    if(!hasStreetNumber(addr)){ if(invalid.length<20) invalid.push(addr); continue; }
    const key=addressKey(addr);
    const r=await pool.query("INSERT INTO hoa_homes (id,org_id,address,address_key,source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id,address_key) DO NOTHING",[id('hh'),org.id,addr,key,source]);
    if(r.rowCount) added++; else skipped++;
  }
  return {added,skipped,invalid};
}
const NEXT=()=>firstOfNextMonth(new Date());

async function homeAction(org,actor,homeId,b){
  const home=await q1('SELECT * FROM hoa_homes WHERE id=$1 AND org_id=$2',[homeId,org.id]);
  if(!home) throw new HttpErr(404,'Home not found');
  const action=String(b.action||'');
  const note=String(b.note||'').trim().slice(0,300);
  if(action==='remove'){
    const reason=String(b.reason||'');
    if(!['sold','rented','other'].includes(reason)) throw bad('Choose a reason: sold, rented, or other.');
    if(reason==='other' && note.length<3) throw bad('Add a short note explaining why this home is being removed.');
    if(home.state==='ended') throw bad('That home is already removed.');
    if(home.state==='active' && home.removal_effective_at) throw bad('That home is already scheduled to be removed.');
    let effective=null;
    if(home.state==='active'){
      effective=NEXT();
      await pool.query('UPDATE hoa_homes SET removal_effective_at=$1,removal_reason=$2 WHERE id=$3',[effective,reason,home.id]);
    }else{
      await endSponsorship(home,reason==='other'?'hoa_removed':reason);
    }
    const unverified=reason==='other' && home.state==='active';
    let flagged=false;
    const ch=await logChange(org,home,{kind:'remove',reason,note,actor,detail:{unverified,effectiveOn:effective,fromState:home.state},flagged:false});
    if(unverified){ flagged=await unverifiedRemovalFlag(org.id); if(flagged) await pool.query('UPDATE hoa_changes SET flagged=true WHERE id=$1',[ch.id]); }
    return {ok:true,effectiveOn:effective,flagged};
  }
  if(action==='restore'){
    if(home.state==='active' && home.removal_effective_at){
      await pool.query('UPDATE hoa_homes SET removal_effective_at=NULL,removal_reason=NULL WHERE id=$1',[home.id]);
      await logChange(org,home,{kind:'restore',note,actor,detail:{cancelledPendingRemoval:true}});
      return {ok:true,state:'active'};
    }
    if(home.state!=='ended') throw bad('That home is not removed.');
    let state='listed';
    if(home.user_id){
      const u=await q1('SELECT * FROM users WHERE id=$1 AND deleted=false',[home.user_id]);
      const other=u&&await q1("SELECT id FROM hoa_homes WHERE user_id=$1 AND state IN ('active','review') AND id<>$2",[u.id,home.id]);
      if(u && !other && !u.sponsored_org_id && home.end_reason!=='homeowner_left' && home.end_reason!=='moved'){
        await pool.query("UPDATE hoa_homes SET state='active',ended_at=NULL,end_reason=NULL,joined_at=COALESCE(joined_at,now()) WHERE id=$1",[home.id]);
        await startSponsorship(mapUser(u),org,false);
        state='active';
      }
    }
    if(state==='listed') await pool.query("UPDATE hoa_homes SET state='listed',user_id=NULL,ended_at=NULL,end_reason=NULL,joined_at=NULL WHERE id=$1",[home.id]);
    await logChange(org,home,{kind:'restore',note,actor,detail:{toState:state}});
    return {ok:true,state};
  }
  if(action==='new_owner'){
    if(home.state==='active'){
      if(!home.removal_effective_at){
        await pool.query("UPDATE hoa_homes SET removal_effective_at=$1,removal_reason='new_owner' WHERE id=$2",[NEXT(),home.id]);
      }
      const ch=await logChange(org,home,{kind:'new_owner',note,actor,detail:{unverified:true,hadActiveOwner:true}});
      const flagged=await unverifiedRemovalFlag(org.id); if(flagged) await pool.query('UPDATE hoa_changes SET flagged=true WHERE id=$1',[ch.id]);
      return {ok:true,state:'active',note:'The new owner can join right away with the join link. The previous owner\'s Plus ends on the next billing date.'};
    }
    await endSponsorship(home,'new_owner',{toState:'listed'});
    await logChange(org,home,{kind:'new_owner',note,actor,detail:{hadActiveOwner:false}});
    return {ok:true,state:'listed'};
  }
  if(action==='fix_address'){
    const na=String(b.newAddress||'').trim().replace(/\s+/g,' ').slice(0,200);
    if(!hasStreetNumber(na)) throw bad('Enter the corrected street address.');
    const key=addressKey(na);
    const dup=await q1('SELECT id FROM hoa_homes WHERE org_id=$1 AND address_key=$2 AND id<>$3',[org.id,key,home.id]);
    if(dup) throw bad('That address is already on the roster.');
    await pool.query('UPDATE hoa_homes SET address=$1,address_key=$2 WHERE id=$3',[na,key,home.id]);
    await logChange(org,{...home,address:na},{kind:'wrong_address',note,actor,detail:{from:home.address,to:na}});
    return {ok:true};
  }
  if(action==='review_confirm' || action==='review_deny'){
    if(home.state!=='review') throw bad('That home is not waiting for review.');
    if(action==='review_confirm'){
      await pool.query("UPDATE hoa_homes SET state='active' WHERE id=$1",[home.id]);
      await logChange(org,home,{kind:'review_confirm',actor,detail:{}});
    }else{
      await endSponsorship(home,'denied');
      await logChange(org,home,{kind:'review_deny',actor,detail:{}});
    }
    return {ok:true};
  }
  throw bad('Unknown action.');
}

// ---------- contacts ----------
async function inviteContact(org,{name,email},inviterName){
  name=String(name||'').trim().slice(0,120); email=String(email||'').trim().toLowerCase().slice(0,200);
  if(!name) throw bad('Enter a name.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email.');
  if(await q1('SELECT id FROM users WHERE lower(email)=lower($1)',[email])) throw new HttpErr(409,'That email already has an account. Use a different email for the HOA login.');
  const tok=crypto.randomBytes(32).toString('hex'); const salt=newSalt();
  const row=await q1("INSERT INTO users (id,role,name,email,password_hash,salt,hoa_org_id,invite_token_hash,invite_expires_at,invited_by) VALUES ($1,'hoa',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [id('usr'),name,email,hash(crypto.randomBytes(24).toString('hex'),salt),salt,org.id,hashInviteToken(tok),new Date(Date.now()+INVITE_TTL_MS),inviterName]);
  const link=`${APP_URL}/#invite=${tok}`;
  const em=await sendEmail({to:email,type:'hoa_invite',subject:`You're invited to manage ${org.name} on Living Communities`,html:contactInviteHtml(name,org.name,inviterName,link),userId:row.id});
  return {contact:contactView(row),inviteLink:link,emailSent:!!(em&&em.ok&&!em.dryRun)};
}
const contactView=r=>({id:r.id,name:r.name,email:r.email,invitePending:!!r.invite_token_hash,suspended:!!r.suspended});

// ---------- portal payload ----------
const STATE_LABEL={listed:'Not joined',review:'Needs review',active:'Active',ended:'Ended'};
const END_LABEL={sold:'Sold',rented:'Rented',hoa_removed:'Removed by HOA',new_owner:'New owner',homeowner_left:'Left the program',moved:'Moved',denied:'Not confirmed by HOA'};
async function portalData(org,{admin=false}={}){
  const stats=await orgStats(org.id);
  const period=NEXT();
  const active=await periodActive(org.id,period);
  const estFloor=org.floor_set?org.floor_seats:Math.ceil((org.floor_pct||0)/100*active);
  const bill=computeBilling(org,active,period);
  const est=computeBilling({...org,pilot_end:null,floor_set:true,floor_seats:estFloor,status:org.status==='paused'?'paused':'active'},active,period);
  const homes=await q('SELECT id,address,state,removal_effective_at,removal_reason,end_reason,source,user_id IS NOT NULL AS has_user FROM hoa_homes WHERE org_id=$1 ORDER BY address_key LIMIT 3000',[org.id]);
  const invoices=await q('SELECT * FROM hoa_invoices WHERE org_id=$1 ORDER BY period DESC LIMIT 24',[org.id]);
  const contacts=await q("SELECT * FROM users WHERE role='hoa' AND hoa_org_id=$1 AND deleted=false ORDER BY created_at",[org.id]);
  const changes=await q('SELECT * FROM hoa_changes WHERE org_id=$1 ORDER BY created_at DESC LIMIT 40',[org.id]);
  const base=org.last_confirmed_at||org.created_at;
  const daysSince=Math.floor((Date.now()-new Date(base).getTime())/86400000);
  return {
    org:{id:org.id,name:org.name,status:org.status,joinCode:org.join_code,joinLink:joinLinkFor(org),priceCents:org.price_cents,pilotStart:org.pilot_start,pilotEnd:org.pilot_end,
      seatCap:org.seat_cap,floorPct:org.floor_pct,floorSeats:org.floor_seats,floorSet:org.floor_set,lastConfirmedAt:org.last_confirmed_at,confirmStale:daysSince>90,
      confirmDaysSince:daysSince,boundaryAddress:org.boundary_address||'',radiusMi:org.radius_mi!=null?Number(org.radius_mi):null,
      ...(admin?{notes:org.notes||'',createdAt:org.created_at,confirmReminders:org.confirm_reminders}:{})},
    stats:{roster:stats.roster,active:stats.active,notJoined:stats.not_joined,review:stats.review,ending:stats.ending,ended:stats.ended},
    nextInvoice:{period,active,floor:bill.floor,billable:bill.billable,amountCents:bill.amountCents,mode:bill.mode,priceCents:bill.price,
      afterPilot:{floor:estFloor,billable:est.billable,amountCents:est.amountCents}},
    homes:homes.map(h=>({id:h.id,address:h.address,state:h.state,label:STATE_LABEL[h.state],endsOn:h.state==='active'?h.removal_effective_at:null,pendingReason:h.state==='active'?h.removal_reason:null,
      endReason:h.state==='ended'?(END_LABEL[h.end_reason]||h.end_reason||''):null,source:h.source})),
    invoices:invoices.map(i=>({id:i.id,period:i.period,active:i.active_count,floor:i.floor_seats,billable:i.billable,priceCents:i.price_cents,amountCents:i.amount_cents,status:i.status,issuedAt:i.issued_at,paidAt:i.paid_at,note:admin?i.note:undefined})),
    contacts:contacts.map(contactView),
    changes:changes.map(c=>({id:c.id,kind:c.kind,reason:c.reason,note:c.note,address:c.address,status:c.status,flagged:c.flagged,at:c.created_at,by:c.actor_name,byRole:c.actor_role,homeId:c.home_id}))
  };
}

// ---------- maintenance job (daily or hourly; safe to run repeatedly) ----------
let running=false;
async function runMaintenance(asOf){
  if(running) return {skipped:true};
  running=true;
  const out={removalsApplied:0,floorsSet:0,previews:0,invoices:0,confirmReminders:0};
  try{
    const now=asOf||new Date(); const today=dstr(now);
    const orgs=await q('SELECT * FROM hoa_orgs ORDER BY created_at');
    for(let org of orgs){
      // 1. removals that reached their effective date
      const due=await q("SELECT * FROM hoa_homes WHERE org_id=$1 AND state='active' AND removal_effective_at IS NOT NULL AND removal_effective_at<=$2",[org.id,today]);
      for(const h of due){
        const reason=h.removal_reason||'hoa_removed';
        if(reason==='new_owner') await endSponsorship(h,'new_owner',{toState:'listed'});
        else await endSponsorship(h,reason==='other'?'hoa_removed':reason);
        if((reason==='sold'||reason==='rented') && org.floor_set && org.floor_seats>0){
          await pool.query('UPDATE hoa_orgs SET floor_seats=floor_seats-1 WHERE id=$1',[org.id]);
          org={...org,floor_seats:org.floor_seats-1};
        }
        out.removalsApplied++;
      }
      // 2. pilot over: status flips, floor baseline is set once
      if(org.pilot_end && today>org.pilot_end){
        if(org.status==='pilot'){ await pool.query("UPDATE hoa_orgs SET status='active' WHERE id=$1",[org.id]); org={...org,status:'active'}; }
        if(!org.floor_set){
          const a=(await orgStats(org.id)).active;
          const floor=Math.ceil((org.floor_pct||0)/100*a);
          await pool.query('UPDATE hoa_orgs SET floor_seats=$1,floor_set=true WHERE id=$2',[floor,org.id]);
          org={...org,floor_seats:floor,floor_set:true}; out.floorsSet++;
        }
      }
      if(org.status==='paused') continue;
      // 3. invoice preview 5 days before the next billing date
      const nextPeriod=firstOfNextMonth(now);
      if(daysBetween(today,nextPeriod)<=5){
        const existing=await q1('SELECT * FROM hoa_invoices WHERE org_id=$1 AND period=$2',[org.id,nextPeriod]);
        if(!existing || (existing.status==='preview' && !existing.preview_sent_at)){
          const bill=computeBilling(org,await periodActive(org.id,nextPeriod),nextPeriod);
          if(bill.amountCents>0){
            const inv=await q1(`INSERT INTO hoa_invoices (id,org_id,period,active_count,floor_seats,billable,price_cents,amount_cents,status,preview_sent_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'preview',now()) ON CONFLICT (org_id,period) DO UPDATE SET active_count=EXCLUDED.active_count,floor_seats=EXCLUDED.floor_seats,billable=EXCLUDED.billable,price_cents=EXCLUDED.price_cents,amount_cents=EXCLUDED.amount_cents,preview_sent_at=now() RETURNING *`,
              [id('hinv'),org.id,nextPeriod,bill.active,bill.floor,bill.billable,bill.price,bill.amountCents]);
            await emailContacts(org,`Invoice preview for ${fmtDay(nextPeriod)}`,'hoa_invoice_preview',invoiceHtml(org,inv,'preview'));
            out.previews++;
          }
        }
      }
      // 4. issue this month's invoice (once)
      const period=firstOfMonth(now);
      if(String(org.created_at.toISOString?org.created_at.toISOString():org.created_at).slice(0,10)<period){
        const existing=await q1('SELECT * FROM hoa_invoices WHERE org_id=$1 AND period=$2',[org.id,period]);
        if(!existing || existing.status==='preview'){
          const bill=computeBilling(org,await periodActive(org.id,period),period);
          if(bill.amountCents>0){
            const inv=await q1(`INSERT INTO hoa_invoices (id,org_id,period,active_count,floor_seats,billable,price_cents,amount_cents,status,issued_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'issued',now()) ON CONFLICT (org_id,period) DO UPDATE SET active_count=EXCLUDED.active_count,floor_seats=EXCLUDED.floor_seats,billable=EXCLUDED.billable,price_cents=EXCLUDED.price_cents,amount_cents=EXCLUDED.amount_cents,status='issued',issued_at=now() RETURNING *`,
              [id('hinv'),org.id,period,bill.active,bill.floor,bill.billable,bill.price,bill.amountCents]);
            await emailContacts(org,`Your invoice for ${fmtDay(period)}`,'hoa_invoice',invoiceHtml(org,inv,'issued'));
            out.invoices++;
          }
        }
      }
      // 5. quarterly roster confirmation (up to 3 reminders, 14 days apart)
      const base=org.last_confirmed_at||org.created_at;
      const stale=(now.getTime()-new Date(base).getTime())/86400000>90;
      const lastRem=org.last_confirm_reminder_at?new Date(org.last_confirm_reminder_at).getTime():0;
      if(stale && (org.confirm_reminders||0)<3 && (now.getTime()-lastRem)/86400000>=14){
        const link=`${APP_URL}/#hoa-confirm=${confirmToken(org.id)}`;
        const n=await emailContacts(org,'Please confirm your HOA roster','hoa_confirm_roster',confirmEmailHtml(org,link));
        await pool.query('UPDATE hoa_orgs SET last_confirm_reminder_at=now(),confirm_reminders=confirm_reminders+1 WHERE id=$1',[org.id]);
        if(n) out.confirmReminders++;
      }
    }
  } finally { running=false; }
  return out;
}

// ---------- homeowner side ----------
async function sponsorInfo(u){
  if(!u||u.role!=='homeowner') return null;
  const h=await q1("SELECT h.state,h.address,h.removal_effective_at,h.removal_reason,o.name FROM hoa_homes h JOIN hoa_orgs o ON o.id=h.org_id WHERE h.user_id=$1 AND h.state IN ('active','review') ORDER BY h.joined_at DESC NULLS LAST LIMIT 1",[u.id]);
  const row=await q1('SELECT sponsor_ended_name,sponsor_ended_at FROM users WHERE id=$1',[u.id]);
  const info={};
  if(h) info.current={orgName:h.name,state:h.state,address:h.address,endsOn:h.removal_effective_at||null};
  if(row && row.sponsor_ended_name && (u.subscription||'free')==='free') info.ended={orgName:row.sponsor_ended_name,at:row.sponsor_ended_at};
  return (info.current||info.ended)?info:null;
}
// Called when a homeowner's saved home address changes (the explicit profile address route).
async function onAddressChange(user,newAddress){
  const h=await q1("SELECT * FROM hoa_homes WHERE user_id=$1 AND state IN ('active','review')",[user.id]);
  if(!h) return;
  if(addressKey(newAddress)!==h.address_key) await endSponsorship(h,'moved');
}
async function onAccountDeleted(userId){
  const hs=await q("SELECT * FROM hoa_homes WHERE user_id=$1 AND state IN ('active','review')",[userId]);
  for(const h of hs) await endSponsorship(h,'homeowner_left',{notify:false});
}

async function joinProgram(u,b){
  if(u.role!=='homeowner') throw new HttpErr(403,'Only homeowners can join an HOA program.');
  const code=String(b.code||'').trim().toUpperCase();
  const org=code?await q1('SELECT * FROM hoa_orgs WHERE join_code=$1',[code]):null;
  if(!org) throw new HttpErr(404,'That join link is not valid. Ask your HOA for a new one.');
  if(org.status==='paused') throw new HttpErr(403,'This HOA program is paused right now.');
  const fresh=await q1('SELECT * FROM users WHERE id=$1',[u.id]);
  if(fresh.sponsored_org_id && fresh.sponsored_org_id!==org.id) throw new HttpErr(409,'Your home is already covered by another HOA program.');
  let address=String(b.address||'').trim().replace(/\s+/g,' ').slice(0,200)||String(fresh.address||'');
  if(!hasStreetNumber(address)) throw bad('Enter your full home address (street number and name) to join.',{needsAddress:true});
  const key=addressKey(address);
  const mine=await q1("SELECT * FROM hoa_homes WHERE user_id=$1 AND state IN ('active','review')",[u.id]);
  if(mine && !(mine.org_id===org.id && mine.address_key===key)) throw new HttpErr(409,'Your account is already linked to another home in the program. Leave it first.');
  // Keep the profile address in step with what was matched (best-effort geocode).
  let lat=fresh.lat!=null?Number(fresh.lat):null, lng=fresh.lng!=null?Number(fresh.lng):null;
  if(address!==(fresh.address||'') || lat==null){
    const geo=await geocodeAddress(address).catch(()=>null);
    if(geo){ lat=geo.lat; lng=geo.lng; await pool.query('UPDATE users SET address=$1,lat=$2,lng=$3,geocoded_at=now() WHERE id=$4',[address,lat,lng,u.id]); }
    else if(address!==(fresh.address||'')) await pool.query('UPDATE users SET address=$1 WHERE id=$2',[address,u.id]);
  }
  let home=await q1('SELECT * FROM hoa_homes WHERE org_id=$1 AND address_key=$2',[org.id,key]);
  let state='active';
  if(home){
    if((home.state==='active'||home.state==='review') && home.user_id===u.id) return {ok:true,already:true,orgName:org.name,state:home.state};
    if(home.state==='active'||home.state==='review'){
      if(home.state==='active' && home.removal_effective_at && home.removal_reason==='new_owner' && home.user_id!==u.id){
        await endSponsorship(home,'new_owner',{toState:'listed'});
        home=await q1('SELECT * FROM hoa_homes WHERE id=$1',[home.id]);
      }else throw new HttpErr(409,'That home already has an account in the program. Ask your HOA to report a new owner for it.');
    }
    if(home.state==='ended' && !(home.user_id===u.id && home.end_reason==='homeowner_left')) throw new HttpErr(403,"Your HOA isn't covering this home right now. Contact your HOA board.");
  }else{
    if(org.center_lat==null||org.radius_mi==null||lat==null||lng==null) throw new HttpErr(404,"We couldn't match your address to this HOA's list. Check the address, or ask your HOA board to add your home.");
    const d=haversineMi(Number(org.center_lat),Number(org.center_lng),lat,lng);
    if(d>Number(org.radius_mi)) throw new HttpErr(404,"That address isn't inside this HOA's neighborhood. Check the address, or ask your HOA board to add your home.");
    const ins=await q1("INSERT INTO hoa_homes (id,org_id,address,address_key,source,state) VALUES ($1,$2,$3,$4,'homeowner','review') RETURNING *",[id('hh'),org.id,address,key]);
    home=ins; state='review';
  }
  await pool.query("UPDATE hoa_homes SET user_id=$1,state=$2,joined_at=now(),ended_at=NULL,end_reason=NULL,removal_effective_at=NULL,removal_reason=NULL WHERE id=$3",[u.id,state,home.id]);
  await startSponsorship(mapUser(fresh),org,state==='review');
  if(state==='review') emailContacts(org,'A home needs your review','hoa_review_needed',emailShell('A home needs your review',h2('A home asked to join')+para(`Someone joined with an address that is not on your roster yet: <b>${esc_(address)}</b>. Please confirm it or deny it in the portal. It is not billed until you confirm.`)+btn('Review in the portal',PORTAL_LINK))).catch(()=>{});
  return {ok:true,orgName:org.name,state};
}
async function leaveProgram(u){
  const h=await q1("SELECT * FROM hoa_homes WHERE user_id=$1 AND state IN ('active','review')",[u.id]);
  if(!h) throw new HttpErr(404,'You are not in an HOA program.');
  await endSponsorship(h,'homeowner_left');
  return {ok:true};
}

// ---------- shared workspace routes (HOA contact for own org, admin for any org) ----------
const inviteEmailCaps=new Map(); // orgId -> {day,count}
async function workspace(req,res,sub,method,org,actor,isAdmin){
  if(sub==='portal' && method==='GET') return send(res,200,await portalData(org,{admin:isAdmin}));
  if(sub==='homes' && method==='POST'){
    const b=await body(req);
    const r=await addHomes(org,b.addresses!=null?b.addresses:b.text);
    if(r.added) await logChange(org,null,{kind:'roster_upload',note:`${r.added} added`,actor,detail:{added:r.added,skipped:r.skipped}}).catch(()=>{});
    return send(res,200,{ok:true,...r});
  }
  let m=/^homes\/([^/]+)\/action$/.exec(sub);
  if(m && method==='POST'){ const b=await body(req); return send(res,200,await homeAction(org,actor,m[1],b)); }
  if(sub==='contacts' && method==='POST'){
    const b=await body(req);
    if(!isAdmin){
      const n=(await q("SELECT id FROM users WHERE role='hoa' AND hoa_org_id=$1 AND deleted=false",[org.id])).length;
      if(n>=3) throw bad('Up to 3 logins per HOA. Contact support to add more.');
    }
    return send(res,201,await inviteContact(org,b,actor.name));
  }
  if(sub==='confirm-roster' && method==='POST'){
    await pool.query('UPDATE hoa_orgs SET last_confirmed_at=now(),confirm_reminders=0 WHERE id=$1',[org.id]);
    await logChange(org,null,{kind:'roster_confirmed',actor,detail:{}});
    return send(res,200,{ok:true});
  }
  if(sub==='invite-emails' && method==='POST'){
    const b=await body(req);
    const emails=[...new Set((Array.isArray(b.emails)?b.emails:String(b.emails||'').split(/[\s,;]+/)).map(e=>String(e||'').trim().toLowerCase()).filter(e=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
    if(!emails.length) throw bad('Enter at least one valid email.');
    if(emails.length>100) throw bad('Send up to 100 emails at a time.');
    const day=dstr(new Date()); const cap=inviteEmailCaps.get(org.id)||{day,count:0};
    if(cap.day!==day){ cap.day=day; cap.count=0; }
    if(cap.count+emails.length>300) throw new HttpErr(429,'Daily limit reached (300 invite emails). Try again tomorrow.');
    cap.count+=emails.length; inviteEmailCaps.set(org.id,cap);
    const link=joinLinkFor(org); let sent=0;
    for(const e of emails){ const r=await sendEmail({to:e,type:'hoa_join_invite',subject:`${org.name} covers Living Communities Plus for your home`,html:joinInviteHtml(org,link)}).catch(()=>null); if(r&&r.ok) sent++; }
    return send(res,200,{ok:true,sent,requested:emails.length});
  }
  return false;
}

// ---------- admin-only routes ----------
async function adminList(){
  const orgs=await q('SELECT * FROM hoa_orgs ORDER BY created_at DESC');
  const stats=await q(`SELECT org_id,
    count(*) FILTER (WHERE state<>'ended')::int AS roster, count(*) FILTER (WHERE state='active')::int AS active,
    count(*) FILTER (WHERE state='review')::int AS review, count(*) FILTER (WHERE state='active' AND removal_effective_at IS NOT NULL)::int AS ending
    FROM hoa_homes GROUP BY org_id`);
  const chg=await q("SELECT org_id,count(*) FILTER (WHERE status='new')::int AS pending,count(*) FILTER (WHERE status='new' AND flagged)::int AS flagged FROM hoa_changes GROUP BY org_id");
  const ctc=await q("SELECT hoa_org_id AS org_id,count(*)::int AS n FROM users WHERE role='hoa' AND deleted=false GROUP BY hoa_org_id");
  const sm=Object.fromEntries(stats.map(s=>[s.org_id,s])), cm=Object.fromEntries(chg.map(s=>[s.org_id,s])), tm=Object.fromEntries(ctc.map(s=>[s.org_id,s.n]));
  const period=NEXT(); const out=[];
  for(const o of orgs){
    const s=sm[o.id]||{roster:0,active:0,review:0,ending:0};
    const active=await periodActive(o.id,period);
    const floor=o.floor_set?o.floor_seats:Math.ceil((o.floor_pct||0)/100*active);
    const bill=computeBilling(o,active,period);
    const est=computeBilling({...o,pilot_end:null,floor_set:true,floor_seats:floor,status:o.status==='paused'?'paused':'active'},active,period);
    const base=o.last_confirmed_at||o.created_at; const days=Math.floor((Date.now()-new Date(base).getTime())/86400000);
    out.push({id:o.id,name:o.name,status:o.status,pilotEnd:o.pilot_end,roster:s.roster,active:s.active,review:s.review,ending:s.ending,
      nextInvoiceCents:bill.amountCents,estimateAfterPilotCents:est.amountCents,mode:bill.mode,lastConfirmedAt:o.last_confirmed_at,confirmDaysSince:days,stale:days>90,
      pendingChanges:(cm[o.id]||{}).pending||0,flagged:(cm[o.id]||{}).flagged||0,contacts:tm[o.id]||0});
  }
  const totals=out.reduce((t,o)=>({hoas:t.hoas+1,active:t.active+o.active,monthlyCents:t.monthlyCents+o.nextInvoiceCents}),{hoas:0,active:0,monthlyCents:0});
  return {hoas:out,totals};
}
async function adminCounts(){
  const r=await q1("SELECT count(*) FILTER (WHERE status='new')::int AS changes, count(*) FILTER (WHERE status='new' AND flagged)::int AS flagged FROM hoa_changes");
  return {changes:r.changes,flagged:r.flagged};
}
async function adminCreate(u,b){
  const name=String(b.name||'').trim().slice(0,160);
  if(!name) throw bad('Enter the HOA name.');
  // The HOA's list of addresses is how the site knows which homes belong, so one is required to sign an HOA up.
  const valid=(Array.isArray(b.addresses)?b.addresses:String(b.addresses||'').split(/\r?\n/)).filter(a=>hasStreetNumber(String(a||'').trim()));
  if(!valid.length) throw bad('Add the HOA\'s list of home addresses (one per line, with street number and name). The site matches homeowners against this list.');
  const days=Math.max(0,Math.min(365,parseInt(b.pilotDays,10)||90));
  const start=dstr(new Date()); const end=addDays(start,days);
  const cap=b.seatCap===''||b.seatCap==null?null:Math.max(1,parseInt(b.seatCap,10)||0)||null;
  let center=null; const boundary=String(b.boundaryAddress||'').trim().slice(0,200); const radius=b.radiusMi!==''&&b.radiusMi!=null?Math.max(0.1,Math.min(25,Number(b.radiusMi)||0)):null;
  if(boundary && radius){ center=await geocodeAddress(boundary).catch(()=>null); if(!center) throw new HttpErr(422,"We couldn't locate the boundary address. Try a street address inside the neighborhood."); }
  const org=await q1(`INSERT INTO hoa_orgs (id,name,join_code,status,pilot_start,pilot_end,seat_cap,boundary_address,center_lat,center_lng,radius_mi,notes)
    VALUES ($1,$2,$3,'pilot',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id('hoa'),name,newJoinCode(),start,end,cap,boundary||null,center?center.lat:null,center?center.lng:null,center?radius:null,String(b.notes||'').slice(0,2000)]);
  let roster=await addHomes(org,b.addresses);
  let contact=null; if(b.contactEmail) contact=await inviteContact(org,{name:b.contactName||'HOA contact',email:b.contactEmail},u.name);
  return {org:await portalData(org,{admin:true}),roster,contact};
}
async function adminSettings(org,b){
  const sets=[],vals=[]; const set=(col,v)=>{ vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if(b.name!=null){ const n=String(b.name).trim().slice(0,160); if(!n) throw bad('Name cannot be empty.'); set('name',n); }
  if(b.status!=null){ if(!['pilot','active','paused'].includes(b.status)) throw bad('Status must be pilot, active, or paused.'); set('status',b.status); }
  if(b.pilotStart!=null){ if(b.pilotStart!==''&&!isDate(b.pilotStart)) throw bad('Pilot start must be a date.'); set('pilot_start',b.pilotStart||null); }
  if(b.pilotEnd!=null){ if(b.pilotEnd!==''&&!isDate(b.pilotEnd)) throw bad('Pilot end must be a date.'); set('pilot_end',b.pilotEnd||null); }
  if('seatCap' in b){ const c=b.seatCap===''||b.seatCap==null?null:parseInt(b.seatCap,10); if(c!=null&&(!(c>=1))) throw bad('Seat cap must be 1 or more, or blank for none.'); set('seat_cap',c); }
  if(b.floorPct!=null){ const p=parseInt(b.floorPct,10); if(!(p>=0&&p<=100)) throw bad('Floor percent must be 0 to 100.'); set('floor_pct',p); }
  if(b.floorSeats!=null&&b.floorSeats!==''){ const f=parseInt(b.floorSeats,10); if(!(f>=0)) throw bad('Floor seats must be 0 or more.'); set('floor_seats',f); set('floor_set',true); }
  if(b.priceCents!=null){ const p=parseInt(b.priceCents,10); if(!(p>=0&&p<=100000)) throw bad('Price must be between $0 and $1,000.'); set('price_cents',p); }
  if(b.notes!=null) set('notes',String(b.notes).slice(0,4000));
  if(b.boundaryAddress!=null||b.radiusMi!=null){
    const addr=String(b.boundaryAddress!=null?b.boundaryAddress:(org.boundary_address||'')).trim().slice(0,200);
    const rad=b.radiusMi!=null&&b.radiusMi!==''?Math.max(0.1,Math.min(25,Number(b.radiusMi)||0)):(b.radiusMi===''?null:(org.radius_mi!=null?Number(org.radius_mi):null));
    if(addr&&rad){
      const changed=addr!==(org.boundary_address||'')||org.center_lat==null;
      if(changed){ const g=await geocodeAddress(addr).catch(()=>null); if(!g) throw new HttpErr(422,"We couldn't locate the boundary address."); set('center_lat',g.lat); set('center_lng',g.lng); }
      set('boundary_address',addr); set('radius_mi',rad);
    }else if(!addr&&!rad){ set('boundary_address',null); set('radius_mi',null); set('center_lat',null); set('center_lng',null); }
    else throw bad('Boundary needs both an address and a radius, or neither.');
  }
  if(b.regenerateCode) set('join_code',newJoinCode());
  if(!sets.length) throw bad('Nothing to change.');
  vals.push(org.id);
  return q1(`UPDATE hoa_orgs SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`,vals);
}

// ---------- routers ----------
function wrap(res,fn){ return fn().catch(e=>{ if(e instanceof HttpErr) return send(res,e.status,{error:e.message,...e.extra}); throw e; }); }

// Unauthenticated: join-link lookup and one-click roster confirm.
async function handlePublic(req,res,p,url){
  if(p==='/api/hoa/join-info' && req.method==='GET'){
    const code=String(url.searchParams.get('code')||'').trim().toUpperCase();
    const org=code?await q1('SELECT name,status FROM hoa_orgs WHERE join_code=$1',[code]):null;
    if(!org) { send(res,404,{error:'That join link is not valid. Ask your HOA for a new one.'}); return true; }
    send(res,200,{name:org.name,paused:org.status==='paused'}); return true;
  }
  if(p==='/api/auth/hoa-confirm' && req.method==='POST'){
    const b=await body(req); const orgId=verifyConfirmToken(b.token);
    const org=orgId&&await getOrg(orgId);
    if(!org){ send(res,404,{error:'This confirmation link is not valid.'}); return true; }
    await pool.query('UPDATE hoa_orgs SET last_confirmed_at=now(),confirm_reminders=0 WHERE id=$1',[org.id]);
    await logChange(org,null,{kind:'roster_confirmed',actor:{id:null,name:'Confirmed by email link',role:'hoa'},detail:{via:'email'}});
    send(res,200,{ok:true,orgName:org.name}); return true;
  }
  return false;
}

// Authenticated. Returns true when it answered the request.
async function handleAuthed(req,res,p,url,u){
  const method=req.method;
  // homeowner
  if(p==='/api/hoa/join' && method==='POST'){ await wrap(res,async()=>{ const b=await body(req); send(res,200,await joinProgram(u,b)); }); return true; }
  if(p==='/api/hoa/leave' && method==='POST'){ await wrap(res,async()=>{ if(u.role!=='homeowner') throw new HttpErr(403,'Not authorized'); send(res,200,await leaveProgram(u)); }); return true; }
  if(p==='/api/hoa/dismiss-ended' && method==='POST'){ await pool.query('UPDATE users SET sponsor_ended_name=NULL,sponsor_ended_at=NULL WHERE id=$1',[u.id]); send(res,200,{ok:true}); return true; }
  // HOA contact
  if(p.startsWith('/api/hoa/') && u.role==='hoa'){
    await wrap(res,async()=>{
      const org=u.hoaOrgId&&await getOrg(u.hoaOrgId);
      if(!org) throw new HttpErr(403,'Your login is not attached to an HOA.');
      const sub=p.slice('/api/hoa/'.length);
      const r=await workspace(req,res,sub==='portal'?'portal':sub,method,org,{id:u.id,name:u.name,role:'hoa'},false);
      if(r===false) send(res,404,{error:'Not found'});
    });
    return true;
  }
  // admin
  if(p.startsWith('/api/admin/hoas') && u.role==='admin'){
    await wrap(res,async()=>{
      if(p==='/api/admin/hoas' && method==='GET') return send(res,200,await adminList());
      if(p==='/api/admin/hoas/counts' && method==='GET') return send(res,200,await adminCounts());
      if(p==='/api/admin/hoas' && method==='POST'){ const b=await body(req); return send(res,201,await adminCreate(u,b)); }
      if(p==='/api/admin/hoas/run-maintenance' && method==='POST') return send(res,200,{ok:true,...await runMaintenance()});
      let m=/^\/api\/admin\/hoas\/([^/]+)(?:\/(.*))?$/.exec(p);
      if(!m) return send(res,404,{error:'Not found'});
      const org=await getOrg(m[1]); if(!org) return send(res,404,{error:'HOA not found'});
      const sub=m[2]||'portal';
      const actor={id:u.id,name:u.name,role:'admin'};
      if(sub==='settings' && method==='POST'){ const b=await body(req); const o2=await adminSettings(org,b); return send(res,200,await portalData(o2,{admin:true})); }
      let mm=/^invoices\/([^/]+)\/status$/.exec(sub);
      if(mm && method==='POST'){
        const b=await body(req);
        if(!['issued','paid','void'].includes(b.status)) throw bad('Status must be issued, paid, or void.');
        const inv=await q1('SELECT * FROM hoa_invoices WHERE id=$1 AND org_id=$2',[mm[1],org.id]); if(!inv) throw new HttpErr(404,'Invoice not found');
        const r=await q1("UPDATE hoa_invoices SET status=$1,paid_at=CASE WHEN $1='paid' THEN now() ELSE NULL END,note=COALESCE($2,note) WHERE id=$3 RETURNING *",[b.status,b.note?String(b.note).slice(0,300):null,inv.id]);
        return send(res,200,{ok:true,status:r.status});
      }
      mm=/^changes\/([^/]+)\/decision$/.exec(sub);
      if(mm && method==='POST'){
        const b=await body(req);
        const ch=await q1('SELECT * FROM hoa_changes WHERE id=$1 AND org_id=$2',[mm[1],org.id]); if(!ch) throw new HttpErr(404,'Change not found');
        if(b.decision==='reverse'){
          if(!ch.home_id||!['remove','new_owner'].includes(ch.kind)) throw bad('Only removals can be reversed.');
          const home=await q1('SELECT * FROM hoa_homes WHERE id=$1',[ch.home_id]);
          if(home && ((home.state==='active'&&home.removal_effective_at)||home.state==='ended'||home.state==='listed')) await homeAction(org,actor,home.id,{action:'restore'}).catch(e=>{ if(!(e instanceof HttpErr)) throw e; });
          await pool.query("UPDATE hoa_changes SET status='reversed',resolved_by=$1,resolved_at=now() WHERE id=$2",[u.name,ch.id]);
        }else if(b.decision==='ack'){
          await pool.query("UPDATE hoa_changes SET status='ack',resolved_by=$1,resolved_at=now() WHERE id=$2",[u.name,ch.id]);
        }else throw bad('Decision must be ack or reverse.');
        return send(res,200,{ok:true});
      }
      mm=/^contacts\/([^/]+)\/resend-invite$/.exec(sub);
      if(mm && method==='POST'){
        const c=await q1("SELECT * FROM users WHERE id=$1 AND role='hoa' AND hoa_org_id=$2 AND invite_token_hash IS NOT NULL",[mm[1],org.id]); if(!c) throw new HttpErr(404,'No pending invite for that contact.');
        const tok=crypto.randomBytes(32).toString('hex');
        const row=await q1('UPDATE users SET invite_token_hash=$1,invite_expires_at=$2 WHERE id=$3 RETURNING *',[hashInviteToken(tok),new Date(Date.now()+INVITE_TTL_MS),c.id]);
        const link=`${APP_URL}/#invite=${tok}`;
        const em=await sendEmail({to:row.email,type:'hoa_invite',subject:`You're invited to manage ${org.name} on Living Communities`,html:contactInviteHtml(row.name,org.name,u.name,link),userId:row.id});
        return send(res,200,{contact:contactView(row),inviteLink:link,emailSent:!!(em&&em.ok&&!em.dryRun)});
      }
      mm=/^contacts\/([^/]+)\/access$/.exec(sub);
      if(mm && method==='POST'){
        const b=await body(req); const susp=!!b.suspended;
        const c=await q1("SELECT * FROM users WHERE id=$1 AND role='hoa' AND hoa_org_id=$2",[mm[1],org.id]); if(!c) throw new HttpErr(404,'Contact not found');
        await pool.query('UPDATE users SET suspended=$1 WHERE id=$2',[susp,c.id]);
        if(susp){ for(const [tok,uid] of sessions){ if(uid===c.id) sessions.delete(tok); } }
        return send(res,200,{ok:true});
      }
      const r=await workspace(req,res,sub,method,org,actor,true);
      if(r===false) send(res,404,{error:'Not found'});
    });
    return true;
  }
  return false;
}

return {initSchema,handlePublic,handleAuthed,runMaintenance,sponsorInfo,onAddressChange,onAccountDeleted,addressKey,computeBilling,confirmToken,
  _test:{dstr,firstOfNextMonth,addDays}};
};
