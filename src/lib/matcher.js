// ============================================================================
// Matcher Logic
// ============================================================================

function testMatcher(release, matcher) {
  let result = true;

  // Handle nested match-all (AND logic)
  if (matcher['match-all']) {
    result = result && matcher['match-all'].every(m => testMatcher(release, m));
  }

  // Handle nested match-any (OR logic)
  if (matcher['match-any']) {
    result = result && matcher['match-any'].some(m => testMatcher(release, m));
  }

  // Simple matchers (case-insensitive by default, AND logic)
  if (matcher.title !== undefined) {
    const regex = new RegExp(matcher.title, 'i');
    if (!regex.test(release.name)) return false;
  }

  if (matcher['title-not'] !== undefined) {
    const regex = new RegExp(matcher['title-not'], 'i');
    if (regex.test(release.name)) return false;
  }

  if (matcher.tag !== undefined) {
    const regex = new RegExp(matcher.tag, 'i');
    if (!regex.test(release.tag)) return false;
  }

  if (matcher['tag-not'] !== undefined) {
    const regex = new RegExp(matcher['tag-not'], 'i');
    if (regex.test(release.tag)) return false;
  }

  if (matcher.body !== undefined) {
    const regex = new RegExp(matcher.body, 'i');
    if (!regex.test(release.body)) return false;
  }

  if (matcher['body-not'] !== undefined) {
    const regex = new RegExp(matcher['body-not'], 'i');
    if (regex.test(release.body)) return false;
  }

  // assets: match against asset names (excluding source code), joined by newlines
  if (matcher.assets !== undefined) {
    const assetNames = (release.assets || [])
      .filter(a => !a.isSourceCode)
      .map(a => a.name)
      .join('\n');
    const regex = new RegExp(matcher.assets, 'i');
    if (!regex.test(assetNames)) return false;
  }

  if (matcher['assets-not'] !== undefined) {
    const assetNames = (release.assets || [])
      .filter(a => !a.isSourceCode)
      .map(a => a.name)
      .join('\n');
    const regex = new RegExp(matcher['assets-not'], 'i');
    if (regex.test(assetNames)) return false;
  }

  // is-prerelease
  if (matcher['is-prerelease'] !== undefined) {
    if (release.prerelease !== matcher['is-prerelease']) return false;
  }

  // is-latest (requires release.isLatest to be set before matching)
  if (matcher['is-latest'] !== undefined) {
    if (release.isLatest !== matcher['is-latest']) return false;
  }

  return result;
}

// Simple matcher keys that can appear directly on a category
const SIMPLE_MATCHER_KEYS = [
  'title', 'title-not',
  'tag', 'tag-not',
  'body', 'body-not',
  'assets', 'assets-not',
  'is-prerelease', 'is-latest'
];

function matchesCategory(release, category) {
  const hasMatchAny = category['match-any'] && category['match-any'].length > 0;
  const hasMatchAll = category['match-all'] && category['match-all'].length > 0;

  // Check for direct matchers at category level
  const directMatchers = {};
  for (const key of SIMPLE_MATCHER_KEYS) {
    if (category[key] !== undefined) {
      directMatchers[key] = category[key];
    }
  }
  const hasDirectMatchers = Object.keys(directMatchers).length > 0;

  // No matchers defined = nothing matches (category is container-only)
  if (!hasMatchAny && !hasMatchAll && !hasDirectMatchers) {
    return false;
  }

  let matches = true;

  // match-any: at least one must match (OR logic)
  if (hasMatchAny) {
    matches = category['match-any'].some(m => testMatcher(release, m));
  }

  // match-all: all must match (AND logic), applied after match-any
  if (matches && hasMatchAll) {
    matches = category['match-all'].every(m => testMatcher(release, m));
  }

  // Direct matchers: all must match (AND logic), applied after match-any/match-all
  if (matches && hasDirectMatchers) {
    matches = testMatcher(release, directMatchers);
  }

  return matches;
}

/**
 * Evaluates a filter block (for include/exclude) against a release.
 * Similar to matchesCategory but:
 * - Empty/undefined filter = matches all releases (returns true)
 * - Supports full matcher syntax: simple matchers, match-any, match-all with nesting
 */
function matchesFilter(release, filter) {
  // No filter or empty filter = match all
  if (!filter || typeof filter !== 'object') {
    return true;
  }

  const hasMatchAny = filter['match-any'] && filter['match-any'].length > 0;
  const hasMatchAll = filter['match-all'] && filter['match-all'].length > 0;

  // Check for direct matchers
  const directMatchers = {};
  for (const key of SIMPLE_MATCHER_KEYS) {
    if (filter[key] !== undefined) {
      directMatchers[key] = filter[key];
    }
  }
  const hasDirectMatchers = Object.keys(directMatchers).length > 0;

  // No matchers defined = match all (different from matchesCategory!)
  if (!hasMatchAny && !hasMatchAll && !hasDirectMatchers) {
    return true;
  }

  let matches = true;

  // match-any: at least one must match (OR logic)
  if (hasMatchAny) {
    matches = filter['match-any'].some(m => testMatcher(release, m));
  }

  // match-all: all must match (AND logic), applied after match-any
  if (matches && hasMatchAll) {
    matches = filter['match-all'].every(m => testMatcher(release, m));
  }

  // Direct matchers: all must match (AND logic), applied after match-any/match-all
  if (matches && hasDirectMatchers) {
    matches = testMatcher(release, directMatchers);
  }

  return matches;
}

module.exports = {
  testMatcher,
  matchesCategory,
  matchesFilter
};
