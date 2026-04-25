import { supabase } from '../supabase.js'
import { t } from '../i18n.js'
import { state } from '../state.js'

let _searchTimer = null
let _loadSeq = 0

export function initPeople() {
  const input = document.getElementById('people-search-input')
  const clearBtn = document.getElementById('people-search-clear')

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
}

export async function loadPeople(options = {}) {
  const requestedQuery = typeof options.query === 'string'
    ? options.query.trim()
    : document.getElementById('people-search-input')?.value.trim() || ''
  const seq = ++_loadSeq
  const list = document.getElementById('people-list')
  const subtitle = document.getElementById('people-subtitle')
  const clearBtn = document.getElementById('people-search-clear')

  if (!list || !state.user) return
  if (clearBtn) clearBtn.style.display = requestedQuery ? 'flex' : 'none'
  if (subtitle) subtitle.textContent = requestedQuery ? t('people.searching') : t('people.recentlyPublic')
  list.innerHTML = `<div class="people-empty">${t('common.loading')}</div>`

  try {
    const rows = requestedQuery
      ? await _loadSearchPeople(requestedQuery)
      : await _loadRecentPublicPeople()

    if (seq !== _loadSeq) return

    if (!rows.length) {
      if (subtitle) subtitle.textContent = requestedQuery
        ? t('people.noResults', { query: requestedQuery })
        : t('people.recentlyPublic')
      list.innerHTML = `<div class="people-empty">${requestedQuery ? t('people.noMatches') : t('people.noneYet')}</div>`
      return
    }

    if (subtitle) subtitle.textContent = requestedQuery
      ? t('people.resultsCount', { count: rows.length })
      : t('people.recentlyPublic')

    list.innerHTML = rows.map(person => _buildPeopleCard(person)).join('')
    _wireAvatarFallback(list)
  } catch (error) {
    console.warn('Could not load people:', error?.message || error)
    if (seq !== _loadSeq) return
    if (subtitle) subtitle.textContent = t('people.couldNotLoad')
    list.innerHTML = `<div class="people-empty">${t('people.couldNotLoad')}</div>`
  }
}

async function _loadRecentPublicPeople() {
  const { data, error } = await supabase.rpc('search_people_directory', {
    p_query: null,
    p_limit: 24,
  })
  if (error) throw error
  return (data || []).map(_normalizePersonRow)
}

async function _loadSearchPeople(query) {
  const { data, error } = await supabase.rpc('search_people_directory', {
    p_query: query,
    p_limit: 24,
  })
  if (error) throw error
  return (data || []).map(_normalizePersonRow)
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

function _buildPeopleCard(person) {
  const primaryName = person.display_name || (person.username ? `@${person.username}` : t('common.unknown'))
  const handle = person.username ? `@${person.username}` : ''
  const bio = String(person.bio || '').trim()
  const initials = _initials(primaryName.replace(/^@/, ''))
  const avatar = person.avatar_url
    ? `<img class="people-card-avatar-img" src="${_esc(person.avatar_url)}" alt="" data-fallback-initials="${_esc(initials)}">`
    : `<div class="people-card-avatar-fallback">${_esc(initials)}</div>`

  return `<article class="people-card">
    <div class="people-card-head">
      <div class="people-card-avatar">${avatar}</div>
      <div class="people-card-title-wrap">
        <div class="people-card-name">${_esc(primaryName)}</div>
        ${handle ? `<div class="people-card-handle">${_esc(handle)}</div>` : ''}
      </div>
    </div>
    <div class="people-card-bio${bio ? '' : ' people-card-bio-empty'}">${_esc(bio || t('people.noBio'))}</div>
    <div class="people-card-counts">
      ${_buildCount('stats.finds', person.finds)}
      ${_buildCount('stats.species', person.species)}
      ${_buildCount('stats.spores', person.spores)}
    </div>
  </article>`
}

function _buildCount(labelKey, value) {
  return `<div class="people-card-count">
    <div class="people-card-count-val">${Number(value) || 0}</div>
    <div class="people-card-count-lbl">${_esc(t(labelKey))}</div>
  </div>`
}

function _wireAvatarFallback(root) {
  root.querySelectorAll('.people-card-avatar-img[data-fallback-initials]').forEach(img => {
    img.addEventListener('error', () => {
      const initials = img.dataset.fallbackInitials || '?'
      img.replaceWith(_createAvatarFallback(initials))
    }, { once: true })
  })
}

function _createAvatarFallback(initials) {
  const fallback = document.createElement('div')
  fallback.className = 'people-card-avatar-fallback'
  fallback.textContent = initials
  return fallback
}

function _initials(value) {
  return String(value || '')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || '')
    .join('') || '?'
}

function _esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
