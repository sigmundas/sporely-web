import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://zkpjklzfwzefhjluvhfw.supabase.co'
const SUPABASE_KEY = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_nZrERVFN3WR4Aqn2yggc7Q_siAG1TCV'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
