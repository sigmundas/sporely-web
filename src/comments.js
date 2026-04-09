import { supabase } from './supabase.js'
import { t } from './i18n.js'

export async function fetchCommentAuthorMap(comments, currentUser = null) {
  const userIds = [...new Set((comments || []).map(comment => comment.user_id).filter(Boolean))]
  const authorMap = {}

  if (userIds.length) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .in('id', userIds)

    if (!error) {
      for (const profile of data || []) authorMap[profile.id] = profile
    }
  }

  if (currentUser?.id && !authorMap[currentUser.id]) {
    authorMap[currentUser.id] = {
      id: currentUser.id,
      username: null,
      display_name: currentUser.user_metadata?.full_name || currentUser.email || t('common.you'),
    }
  }

  return authorMap
}

export function getCommentAuthor(profile) {
  const name = profile?.username ? `@${profile.username}` : (profile?.display_name || t('common.unknown'))
  const initial = name.replace('@', '')[0]?.toUpperCase() || '?'
  return { name, initial }
}
