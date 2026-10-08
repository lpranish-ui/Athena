import crypto from 'node:crypto';
import { HttpError } from './http.js';

export const RESET_MESSAGE='If an account exists for that email, a password reset link will be sent. Check your inbox and spam folder.';
const INVALID_LINK='This link is invalid or expired. Request a new link.';
const hashToken=(token)=>crypto.createHash('sha256').update(token).digest('hex');

export function createAuthActionService({database,emailSender,hashPassword,verifyPassword,now=Date.now}) {
  async function issue(user,purpose) {
    const token=crypto.randomBytes(32).toString('base64url');
    const expires=new Date(now()+(purpose==='password_reset'?30*60*1000:24*60*60*1000));
    const issued=await database.withTransaction(async(client)=> {
      const current=(await client.query('select id,email,email_verified_at from users where id=$1 for update',[user.id])).rows[0];
      if (!current || (purpose==='email_verification' && current.email_verified_at)) return false;
      await client.query('delete from auth_action_tokens where user_id=$1 and (expires_at<$2 or consumed_at is not null)',[user.id,new Date(now())]);
      await client.query('update auth_action_tokens set consumed_at=$3 where user_id=$1 and purpose=$2 and consumed_at is null',
        [user.id,purpose,new Date(now())]);
      await client.query('insert into auth_action_tokens(user_id,purpose,token_hash,expires_at) values ($1,$2,$3,$4)',
        [user.id,purpose,hashToken(token),expires]);
      return true;
    });
    if (issued) await emailSender.send({to:user.email,purpose,token});
  }

  async function consume(rawToken,purpose,change) {
    const token=typeof rawToken==='string'?rawToken:'';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400,INVALID_LINK);
    const fingerprint=hashToken(token);
    const found=await database.one('select user_id from auth_action_tokens where token_hash=$1 and purpose=$2',[fingerprint,purpose]);
    if (!found) throw new HttpError(400,INVALID_LINK);
    return database.withTransaction(async(client)=> {
      // Consistent user -> token lock order avoids racing another reset or password change.
      const user=(await client.query('select * from users where id=$1 for update',[found.user_id])).rows[0];
      const action=(await client.query(`select id from auth_action_tokens where token_hash=$1 and purpose=$2
        and user_id=$3 and consumed_at is null and expires_at>$4 for update`,
      [fingerprint,purpose,found.user_id,new Date(now())])).rows[0];
      if (!user || !action) throw new HttpError(400,INVALID_LINK);
      await change(client,user);
      await client.query('update auth_action_tokens set consumed_at=$2 where id=$1',[action.id,new Date(now())]);
      return {ok:true};
    });
  }

  function validatePassword(password) {
    if (typeof password!=='string' || password.length<8 || password.length>1024) {
      throw new HttpError(400,'Use a password between 8 and 1024 characters.');
    }
  }

  return {
    async requestReset(email) {
      emailSender.assertAvailable(); // Identical503 before looking up any account.
      const user=await database.one('select id,email from users where lower(email)=$1',[email]);
      if (user) {
        try { await issue(user,'password_reset'); }
        catch { console.error('Password reset delivery failed.'); }
      }
      // Delivery failures must not turn account existence into a public oracle.
      return {message:RESET_MESSAGE};
    },
    async reset(token,password) {
      validatePassword(password);
      const passwordHash=await hashPassword(password);
      return consume(token,'password_reset',async(client,user)=> {
        await client.query('update users set password_hash=$2,token_version=token_version+1 where id=$1',[user.id,passwordHash]);
        await client.query("update auth_action_tokens set consumed_at=$2 where user_id=$1 and purpose='password_reset' and consumed_at is null",[user.id,new Date(now())]);
      });
    },
    async requestVerification(userId) {
      emailSender.assertAvailable();
      const user=await database.one('select id,email,email_verified_at from users where id=$1',[userId]);
      if (!user) throw new HttpError(401,'This account no longer exists.');
      if (user.email_verified_at) return {message:'Your email is already verified.'};
      await issue(user,'email_verification');
      return {message:'A verification link was sent. Check your inbox and spam folder.'};
    },
    async verify(token) {
      return consume(token,'email_verification',async(client,user)=> {
        await client.query('update users set email_verified_at=coalesce(email_verified_at,$2) where id=$1',[user.id,new Date(now())]);
      });
    },
    async revoke(userId,version) {
      const row=await database.one('update users set token_version=token_version+1 where id=$1 and token_version=$2 returning id',[userId,version]);
      if (!row) throw new HttpError(401,'This session is no longer valid. Sign in again.');
      return {ok:true};
    },
    async changePassword(userId,version,currentPassword,password) {
      validatePassword(password);
      if (typeof currentPassword!=='string' || currentPassword.length>1024) throw new HttpError(400,'Enter your current password.');
      const passwordHash=await hashPassword(password);
      return database.withTransaction(async(client)=> {
        const user=(await client.query('select * from users where id=$1 for update',[userId])).rows[0];
        if (!user || user.token_version!==version) throw new HttpError(401,'This session is no longer valid. Sign in again.');
        if (!(await verifyPassword(currentPassword,user.password_hash))) throw new HttpError(400,'Your current password is incorrect.');
        await client.query('update users set password_hash=$2,token_version=token_version+1 where id=$1',[userId,passwordHash]);
        await client.query("update auth_action_tokens set consumed_at=$2 where user_id=$1 and purpose='password_reset' and consumed_at is null",[userId,new Date(now())]);
        return {ok:true};
      });
    },
  };
}
