import { supabase } from '../supabase.js'
import { t } from '../i18n.js'
import { state } from '../state.js'
import { showToast } from '../toast.js'
import { openFinds } from './finds.js'

const PEOPLE_PAGE_SIZE = 50
const PEOPLE_LOAD_MORE_THRESHOLD = 240

let _searchTimer = null
let _loadSeq = 0
let _initialOpenLoadTriggered = false
let _peopleRows = []
let _peopleSocialListenerBound = false
const _paging = {
  queryKey: '',
  queryText: '',
  nextOffset: 0,
  hasMore: true,
  loadingMore: false,
  initialized: false,
}

function _normalizePeopleQuery(query = '') {
  return String(query || '').trim()
}

function _peopleQueryKey(query = '') {
  return _normalizePeopleQuery(query).toLowerCase()
}

function _resetPaging(query = '') {
  _paging.queryText = _normalizePeopleQuery(query)
  _paging.queryKey = _peopleQueryKey(query)
  _paging.nextOffset = 0
  _paging.hasMore = true
  _paging.loadingMore = false
  _paging.initialized = false
  _peopleRows = []
}

function _mergePeopleRows(existingRows, incomingRows) {
  const seen = new Set()
  const merged = []
  for (const row of [...existingRows, ...incomingRows]) {
    if (!row?.user_id || seen.has(row.user_id)) continue
    seen.add(row.user_id)
    merged.push(row)
  }
  return merged
}

function _peopleListScroller() {
  return document.getElementById('screen-people')
}

function _peopleBottomFooterHtml() {
  if (!_paging.initialized) return ''
  if (_paging.loadingMore) {
    return `<div class="people-bottom-sentinel people-bottom-sentinel--loading">${t('common.loading')}</div>`
  }
  if (!_paging.hasMore) {
    return `<div class="people-bottom-sentinel people-bottom-sentinel--done">${t('people.noMore')}</div>`
  }
  return ''
}

function _renderPeopleList(list, emptyMessage = '') {
  if (!list) return
  if (!_peopleRows.length) {
    list.innerHTML = `<div class="people-empty">${emptyMessage || t('common.loading')}</div>`
    return
  }
  list.innerHTML = `${_peopleRows.map(buildPeopleCard).join('')}${_peopleBottomFooterHtml()}`
  wireAvatarFallback(list)
  wirePeopleCardActions(list)
}

export function wirePeopleCardActions(root) {
  const list = root
  if (!list || list.dataset.peopleActionsBound === 'true') return
  list.dataset.peopleActionsBound = 'true'

  list.addEventListener('click', async event => {
    const countBtn = event.target.closest('.people-card-count[data-action]')
    if (countBtn && list.contains(countBtn)) {
      const action = countBtn.dataset.action
      const card = countBtn.closest('.people-card')
      if (!card) return
      openFinds('user', {
        userId: card.dataset.userId,
        username: card.dataset.username,
        avatarUrl: card.dataset.avatarUrl,
        displayName: card.dataset.displayName,
        bio: card.dataset.bio,
        finds: card.dataset.finds,
        species: card.dataset.species,
        spores: card.dataset.spores,
        summaryLoaded: true,
        resetSearch: true,
        resetFilters: true,
        groupBySpecies: action === 'species',
        sporesOnly: action === 'spores',
      })
      return
    }

    const socialBtn = event.target.closest('.people-social-btn')
    if (socialBtn && list.contains(socialBtn)) {
      event.preventDefault()
      event.stopPropagation()
      _togglePeopleSocialMenu(socialBtn)
      return
    }

    const menuItem = event.target.closest('.people-social-menu-item')
    if (menuItem && list.contains(menuItem)) {
      event.preventDefault()
      event.stopPropagation()
      const card = menuItem.closest('.people-card')
      if (!card) return
      await _runPeopleSocialAction(card.dataset.userId, menuItem.dataset.action, card)
    }
  })

  if (!_peopleSocialListenerBound) {
    _peopleSocialListenerBound = true
    document.addEventListener('click', event => {
      if (event.target.closest('.people-social-wrap')) return
      _closePeopleSocialMenus()
    })
  }
}

function _bindPeopleInfiniteScroll() {
  const screen = _peopleListScroller()
  if (!screen || screen.dataset.peopleInfiniteBound === 'true') return
  screen.dataset.peopleInfiniteBound = 'true'
  let scheduled = false
  screen.addEventListener('scroll', () => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(() => {
      scheduled = false
      void _maybeLoadMorePeople()
    })
  }, { passive: true })
}

export function initPeople() {
  const input = document.getElementById('people-search-input')
  const clearBtn = document.getElementById('people-search-clear')
  _bindPeopleInfiniteScroll()

  input?.addEventListener('input', () => {
    const hasValue = !!input.value.trim()
    if (clearBtn) clearBtn.style.display = hasValue ? 'flex' : 'none'
    if (_searchTimer) clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => {
      void loadPeople({ query: input.value.trim() })
    }, hasValue ? 180 : 0)
  })

  clearBtn?.addEventListener('click', () => {
    if (!input) return
    input.value = ''
    clearBtn.style.display = 'none'
    void loadPeople({ query: '' })
    input.focus()
  })

  if (!_initialOpenLoadTriggered && state.currentScreen === 'people') {
    _initialOpenLoadTriggered = true
    void loadPeople({ query: input?.value.trim() || '' })
  }
}

export async function loadPeople(options = {}) {
  const requestedQuery = typeof options.query === 'string'
    ? options.query.trim()
    : document.getElementById('people-search-input')?.value.trim() || ''
  const shouldReset = options.resetPaging !== false
  const seq = ++_loadSeq
  const list = document.getElementById('people-list')
  const subtitle = document.getElementById('people-subtitle')
  const clearBtn = document.getElementById('people-search-clear')

  if (!list || !state.user) return
  if (subtitle) subtitle.textContent = ''

  const nextQueryKey = _peopleQueryKey(requestedQuery)
  if (shouldReset || nextQueryKey !== _paging.queryKey) {
    _resetPaging(requestedQuery)
  }

  if (clearBtn) clearBtn.style.display = requestedQuery ? 'flex' : 'none'

  _paging.loadingMore = true
  _renderPeopleList(list)

  try {
    const rows = await _loadPeoplePage({ query: requestedQuery, offset: 0 })
    if (seq !== _loadSeq || state.currentScreen !== 'people') return

    _peopleRows = _mergePeopleRows([], rows)
    _paging.queryText = requestedQuery
    _paging.queryKey = nextQueryKey
    _paging.nextOffset = rows.length
    _paging.hasMore = rows.length === PEOPLE_PAGE_SIZE
    _paging.initialized = true
    _paging.loadingMore = false
    if (!rows.length) {
      _renderPeopleList(list, requestedQuery ? t('people.noMatches') : t('people.noneYet'))
      return
    }
    _renderPeopleList(list)
  } catch (error) {
    console.warn('Could not load people:', error?.message || error)
    if (seq !== _loadSeq) return
    _paging.loadingMore = false
    _paging.initialized = true
    _paging.hasMore = false
    _peopleRows = []
    _renderPeopleList(list, t('people.couldNotLoad'))
  }
}

async function _maybeLoadMorePeople() {
  if (state.currentScreen !== 'people' || _paging.loadingMore || !_paging.hasMore || !_paging.initialized) return
  const screen = _peopleListScroller()
  if (!screen) return
  const distanceFromBottom = screen.scrollHeight - (screen.scrollTop + screen.clientHeight)
  if (distanceFromBottom > PEOPLE_LOAD_MORE_THRESHOLD) return

  const seq = _loadSeq
  const query = _paging.queryText
  _paging.loadingMore = true

  const list = document.getElementById('people-list')
  _renderPeopleList(list)

  try {
    const rows = await _loadPeoplePage({ query, offset: _paging.nextOffset })
    if (seq !== _loadSeq || state.currentScreen !== 'people') return
    if (!rows.length) {
      _paging.hasMore = false
      _paging.loadingMore = false
      _paging.initialized = true
      _renderPeopleList(list)
      return
    }

    _peopleRows = _mergePeopleRows(_peopleRows, rows)
    _paging.queryKey = _peopleQueryKey(query)
    _paging.queryText = _normalizePeopleQuery(query)
    _paging.nextOffset += rows.length
    _paging.hasMore = rows.length === PEOPLE_PAGE_SIZE
    _paging.initialized = true
    _paging.loadingMore = false
    _renderPeopleList(list)
  } catch (error) {
    console.warn('Could not load more people:', error?.message || error)
    if (seq !== _loadSeq) return
    _paging.loadingMore = false
    _renderPeopleList(list)
  }
}

async function _enrichWithSignedUrls(people) {
  if (!people || !people.length) return people
  const paths = people.map(p => `${p.user_id}/avatar.jpg`)
  const { data: signedData } = await supabase.storage.from('avatars').createSignedUrls(paths, 3600)
  if (signedData) {
    const signedMap = {}
    signedData.forEach(item => {
      if (item.signedUrl) signedMap[item.path.split('/')[0]] = item.signedUrl
    })
    people.forEach(p => {
      if (signedMap[p.user_id]) p.avatar_url = signedMap[p.user_id]
    })
  }
  return people
}

async function _loadBlockedPeopleIds() {
  if (!state.user?.id) return new Set()
  const { data, error } = await supabase
    .from('user_blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${state.user.id},blocked_id.eq.${state.user.id}`)
  if (error) throw error
  const blocked = new Set()
  for (const row of data || []) {
    if (row.blocker_id === state.user.id && row.blocked_id) blocked.add(row.blocked_id)
    if (row.blocked_id === state.user.id && row.blocker_id) blocked.add(row.blocker_id)
  }
  return blocked
}

async function _loadPeopleStats(userIds) {
  const ids = [...new Set((userIds || []).map(id => String(id || '').trim()).filter(Boolean))]
  if (!ids.length) return {}
  const entries = await Promise.all(ids.map(async userId => {
    const { data, error } = await supabase.rpc('get_person_stats', { p_user_id: userId })
    if (error) {
      console.warn('Could not load person stats:', error?.message || error)
      return [userId, null]
    }
    return [userId, data?.[0] || null]
  }))
  return Object.fromEntries(entries)
}

async function _loadPeoplePageFallback({ query = '', offset = 0 } = {}) {
  const normalizedQuery = _normalizePeopleQuery(query)
  const blockedIds = await _loadBlockedPeopleIds()
  let profileQuery = supabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url')

  if (normalizedQuery) {
    const escaped = normalizedQuery.replace(/[%_]/g, match => `\\${match}`)
    profileQuery = profileQuery.or(`username.ilike.%${escaped}%,display_name.ilike.%${escaped}%`)
  }

  const { data, error } = await profileQuery
    .order('display_name', { ascending: true, nullsLast: true })
    .order('username', { ascending: true, nullsLast: true })
    .order('id', { ascending: true })
    .range(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + PEOPLE_PAGE_SIZE - 1)

  if (error) throw error

  const filtered = (data || []).filter(row => row?.id && !blockedIds.has(row.id))
  const statsByUserId = await _loadPeopleStats(filtered.map(row => row.id))
  const rows = await _enrichWithSignedUrls(filtered.map(row => {
    const stats = statsByUserId[row.id] || {}
    return _normalizePersonRow({
      user_id: row.id,
      username: row.username,
      display_name: row.display_name,
      bio: row.bio,
      avatar_url: row.avatar_url,
      public_find_count: stats.public_find_count,
      public_species_count: stats.public_species_count,
      public_spore_count: stats.public_spore_count,
    })
  }))
  return _attachPeopleSocialState(rows)
}

async function _loadPeoplePage({ query = '', offset = 0 } = {}) {
  const normalizedQuery = _normalizePeopleQuery(query) || null
  const { data, error } = await supabase.rpc('search_people_directory', {
    p_limit: PEOPLE_PAGE_SIZE,
    p_offset: Math.max(0, Number(offset) || 0),
    p_query: normalizedQuery,
  })
  if (!error) {
    return _attachPeopleSocialState(await _enrichWithSignedUrls((data || []).map(_normalizePersonRow)))
  }
  console.warn('People RPC failed, using fallback query:', error?.message || error)
  return _loadPeoplePageFallback({ query, offset })
}

async function _attachPeopleSocialState(rows) {
  const socialByUserId = await loadPeopleSocialState(rows.map(row => row.user_id))
  return rows.map(row => ({
    ...row,
    relationship: socialByUserId[row.user_id] || {
      friendStatus: null,
      following: false,
    },
  }))
}

export async function loadPeopleSocialState(userIds) {
  const ids = [...new Set((userIds || []).map(id => String(id || '').trim()).filter(Boolean))]
  const empty = Object.fromEntries(ids.map(id => [id, { friendStatus: null, following: false }]))
  if (!ids.length || !state.user?.id) return empty

  const [friendshipsRes, followsRes] = await Promise.all([
    supabase
      .from('friendships')
      .select('requester_id, addressee_id, status')
      .or(`requester_id.eq.${state.user.id},addressee_id.eq.${state.user.id}`),
    supabase
      .from('follows')
      .select('target_id')
      .eq('user_id', state.user.id)
      .eq('target_type', 'user')
      .in('target_id', ids),
  ])

  if (friendshipsRes.error) {
    console.warn('Could not load people friendships:', friendshipsRes.error?.message || friendshipsRes.error)
  }
  if (followsRes.error) {
    console.warn('Could not load people follows:', followsRes.error?.message || followsRes.error)
  }

  const relationships = Object.fromEntries(ids.map(id => [id, { friendStatus: null, following: false }]))

  for (const row of friendshipsRes.data || []) {
    const otherId = row.requester_id === state.user.id ? row.addressee_id : row.requester_id
    const entry = relationships[String(otherId || '').trim()]
    if (!entry) continue
    if (row.status === 'accepted') {
      entry.friendStatus = 'accepted'
    } else if (!entry.friendStatus) {
      entry.friendStatus = row.status || 'pending'
    }
  }

  for (const row of followsRes.data || []) {
    const entry = relationships[String(row.target_id || '').trim()]
    if (entry) entry.following = true
  }

  return relationships
}

function _normalizePersonRow(row) {
  return {
    user_id: row.user_id,
    username: row.username || null,
    display_name: row.display_name || null,
    bio: row.bio || null,
    avatar_url: row.avatar_url || null,
    finds: Number(row.public_find_count) || 0,
    species: Number(row.public_species_count) || 0,
    spores: Number(row.public_spore_count) || 0,
  }
}

function _updatePeopleRowRelationship(userId, nextRelationship) {
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedUserId) return
  _peopleRows = _peopleRows.map(row => {
    if (String(row.user_id || '').trim() !== normalizedUserId) return row
    return {
      ...row,
      relationship: {
        friendStatus: nextRelationship?.friendStatus || null,
        following: !!nextRelationship?.following,
      },
    }
  })
}

function _togglePeopleSocialMenu(button) {
  const wrap = button.closest('.people-social-wrap')
  const menu = wrap?.querySelector('.people-social-menu')
  if (!wrap || !menu) return

  const isOpening = menu.style.display === 'none' || !menu.style.display
  _closePeopleSocialMenus()
  if (!isOpening) return
  menu.style.display = 'block'
  button.classList.add('menu-open')
}

function _closePeopleSocialMenus() {
  document.querySelectorAll('.people-social-wrap').forEach(wrap => {
    const menu = wrap.querySelector('.people-social-menu')
    const btn = wrap.querySelector('.people-social-btn')
    if (menu) menu.style.display = 'none'
    if (btn) btn.classList.remove('menu-open')
  })
}

async function _runPeopleSocialAction(userId, action, card) {
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedUserId || !state.user?.id || normalizedUserId === state.user.id) return

  const current = _peopleRows.find(row => String(row.user_id || '').trim() === normalizedUserId)
  if (!current) return
  const relationship = current.relationship || { friendStatus: null, following: false }

  const socialWrap = card.querySelector('.people-social-wrap')
  const button = socialWrap?.querySelector('.people-social-btn')
  const menuButtons = socialWrap?.querySelectorAll('.people-social-menu-item')

  if (button) button.disabled = true
  if (menuButtons) menuButtons.forEach(btn => { btn.disabled = true })

  try {
    if (action === 'friend') {
      if (relationship.friendStatus === 'accepted' || relationship.friendStatus === 'pending') return
      const { error } = await supabase
        .from('friendships')
        .insert({ requester_id: state.user.id, addressee_id: normalizedUserId, status: 'pending' })
        .select('id')
        .single()

      if (error && String(error.code || '') !== '23505') {
        console.warn('People friend request failed:', error)
        showToast(t('social.friendFailed'))
        return
      }
      showToast(t('profile.requestSent'))
      _updatePeopleRowRelationship(normalizedUserId, {
        friendStatus: 'pending',
        following: relationship.following,
      })
    } else if (action === 'unfriend') {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .or(`and(requester_id.eq.${state.user.id},addressee_id.eq.${normalizedUserId}),and(requester_id.eq.${normalizedUserId},addressee_id.eq.${state.user.id})`)
      if (error) throw error
      showToast(t('profile.friendRemoved'))
      _updatePeopleRowRelationship(normalizedUserId, {
        friendStatus: null,
        following: relationship.following,
      })
    } else if (action === 'follow') {
      const { error } = await supabase
        .from('follows')
        .upsert({
          user_id: state.user.id,
          target_type: 'user',
          target_id: normalizedUserId,
        }, {
          onConflict: 'user_id,target_type,target_id',
        })
      if (error) throw error
      _updatePeopleRowRelationship(normalizedUserId, {
        friendStatus: relationship.friendStatus,
        following: true,
      })
    } else if (action === 'unfollow') {
      const { error } = await supabase
        .from('follows')
        .delete()
        .eq('user_id', state.user.id)
        .eq('target_type', 'user')
        .eq('target_id', normalizedUserId)
      if (error) throw error
      _updatePeopleRowRelationship(normalizedUserId, {
        friendStatus: relationship.friendStatus,
        following: false,
      })
    }

    _closePeopleSocialMenus()
    const list = document.getElementById('people-list')
    _renderPeopleList(list)
  } catch (error) {
    console.warn('Could not update people relationship:', error?.message || error)
    showToast(t('social.followFailed'))
  } finally {
    if (button) button.disabled = false
    if (menuButtons) menuButtons.forEach(btn => { btn.disabled = false })
  }
}

export function buildPeopleCard(person) {
  const avatarUrl = typeof person.avatar_url === 'string' && /^https?:\/\//i.test(person.avatar_url)
    ? person.avatar_url
    : ''

  const displayName = person.display_name && person.display_name.trim() ? person.display_name : null
  const username = person.username && person.username.trim() ? person.username : null
  const primaryName = displayName || (username ? `@${username}` : t('common.unknown'))
  const initials = _esc(_initials(displayName || username))
  const bio = String(person.bio || '').trim()
  const relationship = person.relationship || {}
  const friendStatus = relationship.friendStatus || null
  const following = !!relationship.following
  const isFriend = friendStatus === 'accepted'
  const isPending = friendStatus === 'pending'
  const avatarHtml = avatarUrl
    ? `<img class="people-card-avatar-img" src="${_esc(avatarUrl)}" alt="" data-fallback-initials="${initials}" data-guessed-url="">`
    : `<div class="people-card-avatar-fallback">${initials}</div>`
  const followMenuFriendLabel = isFriend
    ? t('social.unfriendUser')
    : isPending
      ? t('social.friendPending')
      : t('social.friendRequest')
  const followMenuFriendAction = isFriend ? 'unfriend' : isPending ? 'pending' : 'friend'
  const followMenuFollowLabel = following
    ? t('social.unfollowUser')
    : t('social.followUser')
  const followMenuFollowAction = following ? 'unfollow' : 'follow'
  const followBtnClasses = [
    'people-social-btn',
    following ? 'is-following' : '',
    isFriend ? 'is-friend' : '',
    isPending ? 'is-pending' : '',
  ].filter(Boolean).join(' ')

  return `<article class="people-card" data-user-id="${_esc(person.user_id)}" data-username="${_esc(username || '')}" data-avatar-url="${_esc(avatarUrl)}" data-display-name="${_esc(person.display_name || '')}" data-bio="${_esc(person.bio || '')}" data-finds="${Number(person.finds) || 0}" data-species="${Number(person.species) || 0}" data-spores="${Number(person.spores) || 0}">
      <div class="people-card-head">
        <div class="people-card-avatar">${avatarHtml}</div>
        <div class="people-card-title-wrap">
          <div class="people-card-name">${_esc(primaryName)}</div>
          ${username ? `<div class="people-card-handle">@${_esc(username)}</div>` : ''}
        </div>
        <div class="people-social-wrap">
          <button class="${followBtnClasses}" aria-haspopup="true" aria-expanded="false" type="button">
            <span class="people-social-btn-label">${_esc(t('social.followButton'))}</span>
            ${isFriend ? '<svg class="people-social-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>' : ''}
            <svg class="people-social-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <div class="people-social-menu" style="display:none;">
            <button type="button" class="people-social-menu-item" data-action="${followMenuFriendAction}" ${isPending ? 'disabled' : ''}>
              <span class="people-social-menu-title">${_esc(followMenuFriendLabel)}</span>
            </button>
            <div class="people-social-menu-divider"></div>
            <button type="button" class="people-social-menu-item" data-action="${followMenuFollowAction}">
              <span class="people-social-menu-title">${_esc(followMenuFollowLabel)}</span>
            </button>
          </div>
        </div>
      </div>
      ${bio ? `<div class="people-card-bio">${_esc(bio)}</div>` : ''}
      <div class="people-card-counts">
        ${_buildCount('stats.finds', Number(person.finds) || 0, 'finds')}
        ${_buildCount('stats.species', Number(person.species) || 0, 'species')}
        ${_buildCount('stats.spores', Number(person.spores) || 0, 'spores')}
      </div>
    </article>`
}

function _initials(value) {
  if (!value) return '?'
  return String(value).replace(/^@/, '').split(/[\s@.]/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?'
}

function _buildCount(labelKey, value, actionId) {
  return `<div class="people-card-count" data-action="${actionId}" style="cursor:pointer">
    <div class="people-card-count-val">${Number(value) || 0}</div>
    <div class="people-card-count-lbl">${_esc(t(labelKey))}</div>
  </div>`
}

export function wireAvatarFallback(root) {
  root.querySelectorAll('.people-card-avatar-img[data-fallback-initials]').forEach(img => {
    const handleError = () => {
      const initials = img.dataset.fallbackInitials || '?'
      img.replaceWith(_createAvatarFallback(initials))
    }
    img.addEventListener('error', handleError)
  })
}

function _createAvatarFallback(initials) {
  const fallback = document.createElement('div')
  fallback.className = 'people-card-avatar-fallback'
  fallback.textContent = initials
  return fallback
}

function _esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
