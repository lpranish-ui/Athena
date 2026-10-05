// ============================================================================
// Athena Edge Function: delete-account
// ============================================================================
// Deletes the signed-in user's account and all of their data (books, chapters,
// questions, attempts, flags, uploaded files). Required for app-store review.
//
// Request (POST, authenticated): {} — the caller's own account is deleted.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, errorMessage, jsonResponse } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    const user = userData?.user;
    if (userError || !user) {
      return jsonResponse({ error: 'You must be signed in.' }, 401);
    }

    // Admin client — bypasses RLS to remove auth user + storage objects.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    // Best effort: clear the user's upload folder from storage first.
    try {
      const { data: files } = await admin.storage.from('books').list(user.id, { limit: 1000 });
      if (files && files.length > 0) {
        await admin.storage
          .from('books')
          .remove(files.map((file) => `${user.id}/${file.name}`));
      }
    } catch {
      // Storage cleanup failure should not block account deletion.
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) {
      return jsonResponse({ error: `Could not delete the account: ${deleteError.message}` }, 500);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: errorMessage(err, 'Could not delete the account.') }, 500);
  }
});
