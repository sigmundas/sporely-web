import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://zkpjklzfwzefhjluvhfw.supabase.co'
const SUPABASE_KEY = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_nZrERVFN3WR4Aqn2yggc7Q_siAG1TCV'

const GLOBAL_SUPABASE_KEY = '__sporelySupabaseClient__'

function _getSupabaseSingleton() {
  const globalScope = globalThis
  if (!globalScope[GLOBAL_SUPABASE_KEY]) {
    globalScope[GLOBAL_SUPABASE_KEY] = createClient(SUPABASE_URL, SUPABASE_KEY)
  }
  return globalScope[GLOBAL_SUPABASE_KEY]
}

export const supabase = _getSupabaseSingleton()
