// Canonical HTML escaping utility — replaces duplicated definitions across screen files.
// Escapes &, <, >, and " to safely inject strings into both content and attribute contexts.
export function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
