'use strict';
let resetCodeTimer=null;
function closePasswordReset(){
 $('password-reset').hidden=true;$('password-reset-form').reset();
 clearInterval(resetCodeTimer);$('send-password-reset-code').disabled=false;$('send-password-reset-code').textContent='发送重置验证码';
 $('login').hidden=false;
}
$('show-password-reset').addEventListener('click',()=>{
 $('login').hidden=true;$('register').hidden=true;$('password-reset').hidden=false;
 const email=$('login-form').elements.username.value;
 if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))$('password-reset-form').elements.email.value=email;
 message('');$('password-reset-form').elements.email.focus();
});
$('reset-back-login').addEventListener('click',()=>{closePasswordReset();message('');});
$('send-password-reset-code').addEventListener('click',run(async()=>{
 const f=$('password-reset-form'),button=$('send-password-reset-code');
 if(!f.elements.email.reportValidity())return;
 button.disabled=true;
 try{
  const data=await api('/auth/password-reset/code','POST',{email:f.elements.email.value,captcha_token:await window.helixCaptcha.getToken('password_reset_code')});
  message(data.message);let remaining=data.retry_after??60;
  button.textContent=remaining+' 秒后重发';clearInterval(resetCodeTimer);
  resetCodeTimer=setInterval(()=>{remaining--;button.textContent=remaining>0?remaining+' 秒后重发':'发送重置验证码';if(remaining<=0){clearInterval(resetCodeTimer);button.disabled=false;}},1000);
  f.elements.code.focus();
 }catch(e){button.disabled=false;throw e;}
}));
$('password-reset-form').addEventListener('submit',run(async e=>{
 const f=e.target;
 if(f.elements.new_password.value!==f.elements.confirm_password.value)throw new Error('两次输入的密码不一致');
 const data=await api('/auth/password-reset','POST',{email:f.elements.email.value,code:f.elements.code.value.trim(),new_password:f.elements.new_password.value,revoke_api_keys:f.elements.revoke_api_keys.checked});
 closePasswordReset();csrf='';user=null;$('login-form').elements.password.value='';
 $('login-form').elements.username.focus();message(data.message);
}));

$('show-credential-password').addEventListener('click',()=>{
 closePasswordReset();$('login').hidden=true;$('credential-password').hidden=false;
 $('credential-password-form').elements.username.value=$('login-form').elements.username.value;
 message('');$('credential-password-form').elements.username.focus();
});
function closeCredentialPassword(){
 $('credential-password-form').reset();$('credential-password').hidden=true;$('login').hidden=false;
}
$('credential-back-login').addEventListener('click',()=>{closeCredentialPassword();message('');});
$('credential-password-form').addEventListener('submit',run(async e=>{
 const f=e.target;if(f.elements.new_password.value!==f.elements.confirm_password.value)throw new Error('两次输入的密码不一致');
 const result=await api('/auth/password','POST',{username:f.elements.username.value,current_password:f.elements.current_password.value,new_password:f.elements.new_password.value});
 const username=f.elements.username.value;closeCredentialPassword();csrf='';user=null;
 $('login-form').elements.username.value=username;$('login-form').elements.password.value='';message(result.message);
}));
