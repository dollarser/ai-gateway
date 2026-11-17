'use strict';
const $=id=>document.getElementById(id);
let csrf='',user=null,keyTarget=null,registrationRequiresCode=false,registrationCodeTimer=null;
const lunaFields=f=>user?.luna_monthly_tokens===undefined?{}:Object.fromEntries(['luna_monthly_tokens','openai_asr_daily_seconds','openai_tts_daily_characters'].map(k=>[k,Number(f.elements[k].value)]));
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
async function api(path,method='GET',body){const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok){const labels={provider_region_restricted:'OpenAI 拒绝当前地区访问，请联系管理员核查；不要自动重试',provider_auth_failed:'上游密钥异常，请联系管理员，无需重新登录',provider_credit_exhausted:'上游余额或账单限额不足',global_budget_exhausted:'全站模型预算已达到上限，不代表个人额度清零',global_cloud_disabled:'管理员已暂停云模型服务',account_luna_budget_exhausted:'个人 Luna 月额度不足',account_asr_budget_exhausted:'个人今日识别时长不足',account_tts_budget_exhausted:'个人今日合成字符不足',provider_stream_interrupted:'响应未完整结束，用量待核对，请勿自动重发'};const error=new Error((labels[data.error_code]??(typeof data.detail==='string'?data.detail:'请求失败'))+(data.request_id?' · 请求 ID：'+data.request_id:''));error.code=data.error_code;error.retryable=data.retryable===true;error.request_id=data.request_id;error.retry_after=response.headers.get('Retry-After');throw error;}return data;}
function run(fn){return async event=>{event?.preventDefault();const button=event?.submitter;if(button)button.disabled=true;try{await fn(event);}catch(error){message(error.message,true);}finally{if(button)button.disabled=false;}};}
function selected(form){return Array.from(form.querySelectorAll('input[name=services]:checked')).map(x=>x.value);}
function action(text,fn,danger=false){const b=document.createElement('button');b.type='button';b.textContent=text;if(danger)b.className='danger';b.addEventListener('click',run(fn));return b;}
function row(target,values,buttons=[]){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}const td=document.createElement('td');buttons.forEach(b=>td.append(b));tr.append(td);$(target).append(tr);}
function date(value){return new Date(value*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});}
let adminScriptPromise=null;
async function ensureAdminUI(){
 if(window.adminUI)return;
 if(!adminScriptPromise)adminScriptPromise=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src=document.body.dataset.adminScript;
  script.onload=()=>{if(window.adminUI)resolve();else{script.remove();adminScriptPromise=null;reject(new Error('管理页面加载失败'));}};
  script.onerror=()=>{script.remove();adminScriptPromise=null;reject(new Error('管理页面加载失败，请重试'));};
  document.head.append(script);
 });
 await adminScriptPromise;
}
async function tab(name){if(['keys','admin','alerts'].includes(name)&&user?.role!=='admin')name='usage';for(const item of ['keys','usage','password','admin','alerts','notices'])$(item+'-panel').hidden=item!==name;if(name!=='keys'){$('key-value').textContent='';$('key-secret').hidden=true;}if(name!=='admin'){$('user-password').textContent='';$('user-secret').hidden=true;}if(name==='notices'){history.replaceState(null,'','#notices');if(window.noticeUI)await window.noticeUI.load();}if(name==='alerts'){await ensureAdminUI();history.replaceState(null,'','#alerts');if(window.adminUI)await window.adminUI.loadInbox();}else if(['#alerts','#notices'].includes(location.hash)&&name!=='notices')history.replaceState(null,'',location.pathname+location.search);if(name==='keys')await loadKeys();if(name==='usage')await loadUsage();if(name==='admin')await loadUsers();}
async function refresh(){const data=await api('/account/me');user=data.user;csrf=data.csrf;for(const field of document.querySelectorAll('[name=luna_monthly_tokens],[name=openai_asr_daily_seconds],[name=openai_tts_daily_characters]')){field.disabled=user.luna_monthly_tokens===undefined;field.closest('label').hidden=field.disabled;}$('login').hidden=true;$('register').hidden=true;$('password-reset').hidden=true;$('credential-password').hidden=true;$('password-form').elements.username.value=user.username;$('workspace').hidden=false;$('identity').textContent=user.username+(user.role==='admin'?' · 管理员':'');$('admin-tab').hidden=user.role!=='admin';$('alerts-tab').hidden=user.role!=='admin';$('keys-tab').hidden=user.role!=='admin';$('page-title').textContent=user.role==='admin'?'账号管理中心':'我的账号';refreshEmailBinding();for(const box of $('key-services').querySelectorAll('input')){box.disabled=!user.services.includes(box.value);box.checked=!box.disabled;}if(user.must_change){message('首次登录，请先修改初始密码。');await tab('password');}else {if(window.noticeUI)window.noticeUI.start();await tab(location.hash==='#notices'?'notices':user.role==='admin'?(location.hash==='#alerts'?'alerts':'admin'):'usage');}}
async function loadKeys(){const keys=await api(keyTarget?'/admin/keys/'+keyTarget:'/account/keys');$('keys-list').replaceChildren();for(const key of keys)row('keys-list',[key.name+' / '+key.prefix+'…',key.services.join(', '),date(key.expires),key.revoked?'已撤销':key.expires<Date.now()/1000?'已过期':'有效'],key.revoked?[]:[action('撤销',async()=>{if(confirm('撤销此密钥？使用它的应用将无法继续调用。')){await api('/account/keys/'+key.id,'DELETE');await loadKeys();}},true)]);}
async function loadUsage(){
const snapshot=await api('/account/usage-snapshot');const data=snapshot.usage;const isAdmin=user.role==='admin';const used=data.totals.reduce((n,t)=>n+t.requests,0);
$('usage-totals').replaceChildren();const heading=document.createElement('p');
heading.textContent=isAdmin?data.today+' 今日用量 · 每日额度 '+(user.daily_requests===0?'不限':user.daily_requests+' 次')+' · 每分钟额度 '+(user.rpm===0?'不限':user.rpm+' 次')+' · 并发 '+user.concurrency:'今日已使用 '+used+' 次 · '+(user.daily_requests===0?'每日请求不限':'剩余 '+Math.max(0,user.daily_requests-used)+' 次 · 每日额度 '+user.daily_requests+' 次');
$('usage-totals').append(heading);if(user.luna_monthly_tokens!==undefined){const luna=snapshot.luna;const balance=document.createElement('p');const amount=n=>Number(n).toLocaleString('zh-CN');balance.textContent='云文本（Luna / 嵌入） · '+luna.month+' · 月额度 '+amount(luna.monthly_tokens)+' tokens · 已计入 '+amount(luna.used_tokens)+' · 剩余 '+amount(luna.remaining_tokens)+(luna.reserved_tokens?'（其中预留/待核对 '+amount(luna.reserved_tokens)+'）':'');const reset=document.createElement('small');reset.textContent=' 下次重置：'+new Date(luna.resets_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）';balance.append(reset);$('usage-totals').append(balance);}if(user.openai_asr_daily_seconds!==undefined){const a=snapshot.audio;const line=document.createElement('p');line.textContent='OpenAI 语音 · '+a.day+' · 识别剩余 '+(a.asr.remaining/60000).toFixed(2)+' / '+(a.asr.limit/60000).toFixed(0)+' 分钟 · 合成剩余 '+a.tts.remaining.toLocaleString('zh-CN')+' / '+a.tts.limit.toLocaleString('zh-CN')+' 字符'+(a.asr.reserved||a.tts.reserved?'（含预留/待核对用量）':'');line.append(document.createTextNode(' · 下次重置 '+new Date(a.resets_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）'));$('usage-totals').append(line);}const cards=document.createElement('div');cards.className='usage-cards';const names={qwen:'智能对话',asr:'语音识别',tts:'语音合成'};
for(const service of user.services){const card=document.createElement('div');const total=data.totals.find(x=>x.service===service);card.textContent=(isAdmin?service.toUpperCase():names[service]??service)+' · '+(total?.requests??0)+' 次';cards.append(card);}$('usage-totals').append(cards);
const header=document.createElement('tr');for(const title of isAdmin?['时间','服务','状态','耗时','响应字节']:['时间','功能','结果']){const th=document.createElement('th');th.textContent=title;header.append(th);}$('usage-head').replaceChildren(header);
$('usage-list').replaceChildren();for(const r of data.requests){const values=isAdmin?[date(r.started),r.service,r.status??'进行中',r.ended?((r.ended-r.started).toFixed(2)+' 秒'):'—',r.response_bytes]:[date(r.started),names[r.service]??r.service,r.status===null?'处理中':r.status>=200&&r.status<400||r.status===101?'成功':'未完成'];const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}$('usage-list').append(tr);}
if(!data.requests.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=isAdmin?5:3;td.textContent='暂无使用记录';tr.append(td);$('usage-list').append(tr);}
}

async function loadUsers(){await ensureAdminUI();await window.adminUI.load();}
$('login-form').addEventListener('submit',run(async e=>{const f=e.target;const data=await api('/auth/login','POST',{username:f.elements.username.value,password:f.elements.password.value});csrf=data.csrf;f.reset();message('登录成功');await refresh();}));
$('logout').addEventListener('click',run(async()=>{await api('/auth/logout','POST');location.reload();}));
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',run(()=>tab(b.dataset.tab))));
$('key-form').addEventListener('submit',run(async e=>{const f=e.target;const data=await api(keyTarget?'/admin/keys/'+keyTarget:'/account/keys','POST',{name:f.elements.name.value,days:Number(f.elements.days.value),services:selected(f)});$('key-value').textContent=data.key;$('key-secret').hidden=false;await loadKeys();message(data.message);}));
$('copy-key').addEventListener('click',run(async()=>{await navigator.clipboard.writeText($('key-value').textContent);message('密钥已复制');}));
$('dismiss-key').onclick=()=>{$('key-value').textContent='';$('key-secret').hidden=true;};
$('dismiss-password').onclick=()=>{$('user-password').textContent='';$('user-secret').hidden=true;};
$('refresh-usage').addEventListener('click',run(loadUsage));
$('password-form').addEventListener('submit',run(async e=>{const f=e.target;await api('/auth/password','POST',{username:f.elements.username.value,current_password:f.elements.current_password.value,new_password:f.elements.new_password.value});location.reload();}));
$('user-form').addEventListener('submit',run(async e=>{const f=e.target;const data=await api('/admin/users','POST',{username:f.elements.username.value,services:selected(f),rpm:Number(f.elements.rpm.value),daily_requests:Number(f.elements.daily_requests.value),concurrency:Number(f.elements.concurrency.value),...lunaFields(f)});$('user-password').textContent=data.user.username+'\n临时密码：'+data.temporary_password;$('user-secret').hidden=false;await loadUsers();message(data.message);}));
$('edit-form').addEventListener('submit',run(async e=>{const f=e.target;await api('/admin/users/'+Number(f.elements.id.value),'PATCH',{services:selected(f),rpm:Number(f.elements.rpm.value),daily_requests:Number(f.elements.daily_requests.value),concurrency:Number(f.elements.concurrency.value),...lunaFields(f)});f.hidden=true;$('edit-container').hidden=true;await loadUsers();message('账号权限和限额已更新');}));
document.addEventListener('DOMContentLoaded',()=>refresh().catch(()=>{}),{once:true});

$('show-register').addEventListener('click',run(async()=>{const info=await api('/auth/registration-info');if(info.registration_enabled===false)throw new Error('当前暂停公开注册');const q=info.defaults;registrationRequiresCode=info.email_verification===true;$('registration-code-fields').hidden=!registrationRequiresCode;$('register-form').elements.code.required=registrationRequiresCode;$('registration-quotas').textContent='注册后每天可使用 '+q.daily_requests+' 次。'+(registrationRequiresCode?'需要验证邮箱后完成注册。':'');$('login').hidden=true;$('register').hidden=false;message('');}));
$('show-login').onclick=()=>{$('register').hidden=true;$('login').hidden=false;message('');};
$('register-form').addEventListener('submit',run(async e=>{const f=e.target;const email=f.elements.email.value;if(f.elements.password.value!==f.elements.confirm_password.value)throw new Error('两次输入的密码不一致');const data=await api('/auth/register','POST',{email,password:f.elements.password.value,...(registrationRequiresCode?{code:f.elements.code.value.trim()}:{})});f.reset();$('register').hidden=true;$('login').hidden=false;$('login-form').elements.username.value=email;$('login-form').elements.password.focus();message(data.message);}));

window.addEventListener('hashchange',run(async()=>{if(location.hash==='#alerts'&&user?.role==='admin'&&!user.must_change)await tab('alerts');if(location.hash==='#notices'&&user&&!user.must_change)await tab('notices');}));

$('send-registration-code').addEventListener('click',run(async()=>{
 const f=$('register-form'),button=$('send-registration-code');
 if(!f.elements.email.reportValidity())return;
 button.disabled=true;
 try{const data=await api('/auth/registration-code','POST',{email:f.elements.email.value,captcha_token:await window.helixCaptcha.getToken('registration_code')});message(data.message);let remaining=60;button.textContent=remaining+' 秒后重发';clearInterval(registrationCodeTimer);registrationCodeTimer=setInterval(()=>{remaining--;button.textContent=remaining>0?remaining+' 秒后重发':'发送验证码';if(remaining<=0){clearInterval(registrationCodeTimer);button.disabled=false;}},1000);f.elements.code.focus();}
 catch(e){button.disabled=false;throw e;}
}));

let bindingOwner=null,bindingCodeTimer=null;
function refreshEmailBinding(){
 const required=user.email_binding_required===true;
 $('email-binding-reminder').hidden=!required;
 $('open-email-binding').disabled=!!user.must_change;
 $('email-binding-hint').textContent=user.must_change?'请先修改初始密码，再验证并绑定邮箱。':'您的账号尚未验证邮箱，请完成绑定以接收账号通知。绑定不会改变登录名，也不影响当前服务使用。';
 if(!required){$('email-binding-form').reset();$('email-binding-form').hidden=true;clearInterval(bindingCodeTimer);$('send-binding-code').disabled=false;$('send-binding-code').textContent='发送验证码';}
 if(bindingOwner!==user.id){bindingOwner=user.id;$('email-binding-form').elements.email.value=user.email||(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.username)?user.username:'');}
}
$('open-email-binding').addEventListener('click',()=>{$('email-binding-form').hidden=false;$('email-binding-form').elements.email.focus();});
$('defer-email-binding').addEventListener('click',()=>{$('email-binding-form').hidden=true;$('email-binding-form').elements.code.value='';});
$('send-binding-code').addEventListener('click',run(async()=>{
 const f=$('email-binding-form'),button=$('send-binding-code');if(!f.elements.email.reportValidity())return;button.disabled=true;
 try{const data=await api('/account/email/code','POST',{email:f.elements.email.value,captcha_token:await window.helixCaptcha.getToken('email_binding_code')});message(data.message);let remaining=60;button.textContent=remaining+' 秒后重发';clearInterval(bindingCodeTimer);bindingCodeTimer=setInterval(()=>{remaining--;button.textContent=remaining>0?remaining+' 秒后重发':'发送验证码';if(remaining<=0){clearInterval(bindingCodeTimer);button.disabled=false;}},1000);f.elements.code.focus();}catch(e){button.disabled=false;throw e;}
}));
$('email-binding-form').addEventListener('submit',run(async e=>{const f=e.target;const result=await api('/account/email/bind','POST',{email:f.elements.email.value,code:f.elements.code.value.trim()});await refresh();message(result.message);}));
