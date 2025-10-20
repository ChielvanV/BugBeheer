import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Lazy Supabase client initialization; only create after user login.
let client: SupabaseClient | null = null;

export function initSupabase(): SupabaseClient {
  if (!client) {
    const supabaseUrl = process.env.REACT_APP_SUPABASE_URL as string;
    const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY as string;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn('[Supabase] Missing REACT_APP_SUPABASE_URL or REACT_APP_SUPABASE_ANON_KEY');
    }

    client = createClient(supabaseUrl, supabaseAnonKey);
  }

  return client;
}

export function getSupabase(): SupabaseClient | null {
  return client;
}
