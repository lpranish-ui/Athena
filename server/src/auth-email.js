import { HttpError } from './http.js';

const UNAVAILABLE='Account email delivery is currently unavailable. You can still sign in with your existing password. Please try again later.';

/** Sender injection is used in tests; tokens are delivered only through email. */
export function createAuthEmailSender({ apiKey=process.env.RESEND_API_KEY,
  from=process.env.AUTH_EMAIL_FROM, publicUrl=process.env.AUTH_PUBLIC_URL, fetchImpl=fetch }={}) {
  function assertAvailable() {
    let url;
    try { url=new URL(publicUrl); } catch { throw new HttpError(503,UNAVAILABLE); }
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if (!apiKey?.trim() || !from?.trim() || url.username || url.password ||
        !(url.protocol==='https:' || (local && url.protocol==='http:'))) throw new HttpError(503,UNAVAILABLE);
  }
  return {
    assertAvailable,
    async send({to,purpose,token}) {
      assertAvailable();
      const reset=purpose==='password_reset';
      const url=new URL(reset?'/reset-password':'/verify-email',publicUrl);
      url.searchParams.set('token',token);
      const response=await fetchImpl('https://api.resend.com/emails',{
        method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({from,to:[to],subject:reset?'Reset your Athena password':'Verify your Athena email',
          text:`${reset?'Set a new password':'Verify your email'} for Athena using this link:\n\n${url}\n\n`+
            `This link expires in ${reset?'30 minutes':'24 hours'} and can be used once. If you did not request it, you can ignore this email.`}),
        signal:AbortSignal.timeout(15000),
      });
      // Never include provider response bodies, addresses or tokens in errors/logs.
      if (!response.ok) throw new HttpError(503,'Account email delivery is temporarily unavailable.');
    },
  };
}
