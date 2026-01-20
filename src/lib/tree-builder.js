const { matchesCategory, testMatcher } = require('./matcher');

// ============================================================================
// Tree Building
// ============================================================================

// Sentinel value to indicate "use the configured default"
const USE_DEFAULT = Symbol('USE_DEFAULT');

/**
 * Validate a max-displayed value
 * @param {*} value - The value to validate
 * @param {string} context - Description of where this value came from (for error messages)
 * @throws {Error} if value is invalid (not false and less than 1)
 */
function validateMaxDisplayed(value, context) {
  if (value !== undefined && value !== null && value !== false && value < 1) {
    throw new Error(`${context} must be false or a positive integer, got: ${value}`);
  }
}

/**
 * Parse a cutoff date string and return a Date object
 * Supports:
 * - ISO date/datetime strings (e.g., "2022-01-01", "2022-01-01T00:00:00Z")
 * - Relative dates: -1d (days), -1w (weeks), -1m (months), -1y (years)
 * - false = no cutoff
 * @param {string|false|null} cutoffDate - Cutoff date specification
 * @returns {Date|false|null} - Date object, false (disabled), or null (invalid)
 */
function parseCutoffDate(cutoffDate) {
  if (cutoffDate === false) return false;
  if (!cutoffDate) return null;

  // Check for relative date format: -Nd, -Nw, -Nm, -Ny
  const relativeMatch = String(cutoffDate).match(/^-(\d+)([dwmy])$/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const now = new Date();

    switch (unit) {
      case 'd':
        now.setDate(now.getDate() - amount);
        break;
      case 'w':
        now.setDate(now.getDate() - amount * 7);
        break;
      case 'm':
        now.setMonth(now.getMonth() - amount);
        break;
      case 'y':
        now.setFullYear(now.getFullYear() - amount);
        break;
    }
    return now;
  }

  // Otherwise parse as ISO date
  return new Date(cutoffDate);
}

/**
 * Filter releases by cutoff date
 * @param {Array} releases - Array of release objects
 * @param {Date|false|null} cutoffDate - Cutoff date (releases on or before are excluded), false = no filter
 * @returns {Array}
 */
function filterByCutoffDate(releases, cutoffDate) {
  // false means explicitly disabled, null means not set
  if (cutoffDate === false || !cutoffDate) return releases;
  return releases.filter(r => new Date(r.publishedAt) > cutoffDate);
}

/**
 * Determine which releases should be marked as latest based on latest-match config
 * @param {Array} releases - Array of release objects (already sorted newest first)
 * @param {Array|string|null|false} latestMatch - Latest match configuration
 *   - false: no latest badge
 *   - "newest": only the newest release gets the badge
 *   - null/undefined: same as "newest"
 *   - Array: custom matchers
 * @returns {Array} - Array of release IDs that should be marked as latest
 */
function findLatestReleases(releases, latestMatch) {
  if (releases.length === 0) return [];

  // false = no latest badge
  if (latestMatch === false) return [];

  // null/undefined/"newest" = newest release only
  if (latestMatch === null || latestMatch === undefined || latestMatch === 'newest') {
    return [releases[0].id];
  }

  // Array of matchers - find all matching releases
  // First, temporarily mark the newest as latest for is-latest matcher to work
  const tempReleases = releases.map((r, i) => ({ ...r, isLatest: i === 0 }));

  const latestIds = [];
  for (const release of tempReleases) {
    // Build a matcher object from the latest-match config
    const matcher = Array.isArray(latestMatch)
      ? { 'match-all': latestMatch }
      : latestMatch;

    if (testMatcher(release, matcher)) {
      latestIds.push(release.id);
    }
  }

  return latestIds;
}

/**
 * Classify releases into categories with latest-match, cutoff-date, and max-displayed support
 *
 * Inheritance semantics:
 * - Categories inherit from configured defaults until they get an explicit value
 * - Subcategories inherit from parent until they get an explicit value
 * - null = reset to configured default (propagates to subcategories)
 * - false = disable feature (propagates to subcategories):
 *   - latest-match: no releases have the "latest" badge
 *   - cutoff-date: no cutoff date filtering
 *   - max-displayed: no maximum (show all)
 *
 * @param {Array} releases - Array of release objects
 * @param {Array} categories - Category configuration
 * @param {Object} defaults - Default values from config's "defaults" section
 * @param {Object} unmatchedConfig - Configuration for the unmatched category
 * @returns {Object} - { tree, unmatchedReleases, defaultMaxDisplayed, unmatchedMaxDisplayed }
 */
function classifyReleases(releases, categories, defaults = {}, unmatchedConfig = {}) {
  const matchedReleaseIds = new Set();

  // Configured defaults (from "defaults:" section in config)
  // These are used when a category explicitly sets null to reset to default
  const configuredDefaults = {
    latestMatch: defaults.latestMatch !== undefined ? defaults.latestMatch : 'newest',
    cutoffDate: defaults.cutoffDate !== undefined ? parseCutoffDate(defaults.cutoffDate) : parseCutoffDate('-1y'),
    maxDisplayed: defaults.maxDisplayed !== undefined ? defaults.maxDisplayed : 100,
    inheritParentMatchers: defaults.inheritParentMatchers !== undefined ? defaults.inheritParentMatchers : false
  };

  // Validate defaults.max-displayed
  validateMaxDisplayed(configuredDefaults.maxDisplayed, 'defaults.max-displayed');

  /**
   * Resolve a setting value considering inheritance
   * @param {*} nodeValue - Value explicitly set on the node (or undefined if not set)
   * @param {*} inheritedValue - Value inherited from parent
   * @param {*} configuredDefault - Default from config's "defaults" section
   * @param {boolean} hasExplicitValue - Whether the node has an explicit value set
   * @returns {*} - The effective value to use
   */
  function resolveValue(nodeValue, inheritedValue, configuredDefault, hasExplicitValue) {
    if (!hasExplicitValue) {
      // No explicit value: use inherited if available, otherwise configured default
      return inheritedValue !== undefined ? inheritedValue : configuredDefault;
    }
    // Explicit null: reset to configured default
    if (nodeValue === null) {
      return configuredDefault;
    }
    // Explicit value (including false): use it
    return nodeValue;
  }

  function processNode(node, inheritedLatestMatch, inheritedCutoffDate, inheritedMaxDisplayed, inheritedInheritMode, parentReleaseMatches) {
    // Resolve effective values using new inheritance semantics
    const hasLatestMatch = Object.hasOwn(node, 'latest-match');
    const hasCutoffDate = Object.hasOwn(node, 'cutoff-date');
    const hasMaxDisplayed = Object.hasOwn(node, 'max-displayed');
    const hasInheritParentMatchers = Object.hasOwn(node, 'inherit-parent-matchers');

    // Validate category max-displayed if explicitly set
    if (hasMaxDisplayed) {
      validateMaxDisplayed(node['max-displayed'], `Category "${node.name}" max-displayed`);
    }

    const effectiveLatestMatch = resolveValue(
      node['latest-match'],
      inheritedLatestMatch,
      configuredDefaults.latestMatch,
      hasLatestMatch
    );

    // For cutoff-date, we need to parse the node value if present
    const nodeCutoffDate = hasCutoffDate ? parseCutoffDate(node['cutoff-date']) : undefined;
    const effectiveCutoffDate = resolveValue(
      nodeCutoffDate,
      inheritedCutoffDate,
      configuredDefaults.cutoffDate,
      hasCutoffDate
    );

    // For max-displayed, false means unlimited (null equivalent for display purposes)
    let effectiveMaxDisplayed = resolveValue(
      node['max-displayed'],
      inheritedMaxDisplayed,
      configuredDefaults.maxDisplayed,
      hasMaxDisplayed
    );
    // Convert false to null for max-displayed (false = unlimited = no limit)
    if (effectiveMaxDisplayed === false) {
      effectiveMaxDisplayed = null;
    }

    // Resolve inherit-parent-matchers setting
    const effectiveInheritMode = resolveValue(
      node['inherit-parent-matchers'],
      inheritedInheritMode,
      configuredDefaults.inheritParentMatchers,
      hasInheritParentMatchers
    );

    const result = {
      name: node.name,
      description: node.description || '',
      tooltip: node.tooltip || '',
      releases: [],
      categories: [],
      maxDisplayed: effectiveMaxDisplayed
    };

    // Find releases matching this category (clone each to avoid shared state)
    // Track match results for each release to pass to subcategories
    const releaseMatchResults = new Map();

    // show-releases: false means evaluate matchers (for inheritance) but don't display releases
    const showReleases = node['show-releases'] !== false;

    for (const release of releases) {
      // Get parent's match result for this release (undefined if no parent)
      const parentMatch = parentReleaseMatches ? parentReleaseMatches.get(release.id) : undefined;

      // Evaluate this category's match, considering inheritance
      const matches = matchesCategory(release, node, parentMatch, effectiveInheritMode);
      releaseMatchResults.set(release.id, matches);

      if (matches) {
        if (showReleases) {
          result.releases.push({ ...release, isLatest: false });
        }
        matchedReleaseIds.add(release.id);
      }
    }

    // Apply cutoff-date filter
    result.releases = filterByCutoffDate(result.releases, effectiveCutoffDate);

    // Sort releases by date (newest first)
    result.releases.sort((a, b) =>
      new Date(b.publishedAt) - new Date(a.publishedAt)
    );

    // Apply latest-match logic
    const latestIds = findLatestReleases(result.releases, effectiveLatestMatch);

    // Mark latest releases and sort them to the top
    for (const release of result.releases) {
      release.isLatest = latestIds.includes(release.id);
    }

    // Sort: latest releases first (preserving date order within each group)
    if (latestIds.length > 0) {
      result.releases.sort((a, b) => {
        if (a.isLatest && !b.isLatest) return -1;
        if (!a.isLatest && b.isLatest) return 1;
        return new Date(b.publishedAt) - new Date(a.publishedAt);
      });
    }

    // Process subcategories (pass inherited values and this category's match results)
    if (node.categories) {
      for (const subCategory of node.categories) {
        result.categories.push(processNode(
          subCategory,
          effectiveLatestMatch,
          effectiveCutoffDate,
          effectiveMaxDisplayed,
          effectiveInheritMode,
          releaseMatchResults
        ));
      }
    }

    return result;
  }

  const tree = categories.map(c => processNode(c, undefined, undefined, undefined, undefined, undefined));

  // Filter out empty categories (no releases directly or in any subcategory)
  function filterEmptyCategories(cats) {
    return cats
      .map(cat => ({
        ...cat,
        categories: filterEmptyCategories(cat.categories || [])
      }))
      .filter(cat => cat.releases.length > 0 || cat.categories.length > 0);
  }

  const filteredTree = filterEmptyCategories(tree);

  // Collect unmatched releases (clone to avoid shared state)
  let unmatchedReleases = releases
    .filter(r => !matchedReleaseIds.has(r.id))
    .map(r => ({ ...r, isLatest: false }));

  // Determine unmatched-specific settings (use unmatched config if provided, otherwise defaults)
  const unmatchedCutoffDate = Object.hasOwn(unmatchedConfig, 'cutoff-date')
    ? parseCutoffDate(unmatchedConfig['cutoff-date'])
    : configuredDefaults.cutoffDate;
  const unmatchedLatestMatch = Object.hasOwn(unmatchedConfig, 'latest-match')
    ? unmatchedConfig['latest-match']
    : configuredDefaults.latestMatch;
  const unmatchedMaxDisplayedRaw = Object.hasOwn(unmatchedConfig, 'max-displayed')
    ? unmatchedConfig['max-displayed']
    : configuredDefaults.maxDisplayed;

  // Validate unmatched max-displayed if explicitly set
  if (Object.hasOwn(unmatchedConfig, 'max-displayed')) {
    validateMaxDisplayed(unmatchedConfig['max-displayed'], 'unmatched.max-displayed');
  }

  // Apply cutoff-date to unmatched releases
  unmatchedReleases = filterByCutoffDate(unmatchedReleases, unmatchedCutoffDate);

  unmatchedReleases.sort((a, b) =>
    new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  // Apply latest-match to unmatched releases
  const unmatchedLatestIds = findLatestReleases(unmatchedReleases, unmatchedLatestMatch);
  for (const release of unmatchedReleases) {
    release.isLatest = unmatchedLatestIds.includes(release.id);
  }

  // Sort unmatched: latest first
  if (unmatchedLatestIds.length > 0) {
    unmatchedReleases.sort((a, b) => {
      if (a.isLatest && !b.isLatest) return -1;
      if (!a.isLatest && b.isLatest) return 1;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });
  }

  // Convert false to null for maxDisplayed values (false = unlimited)
  const defaultMaxDisplayed = configuredDefaults.maxDisplayed === false ? null : configuredDefaults.maxDisplayed;
  const unmatchedMaxDisplayed = unmatchedMaxDisplayedRaw === false ? null : unmatchedMaxDisplayedRaw;

  return { tree: filteredTree, unmatchedReleases, defaultMaxDisplayed, unmatchedMaxDisplayed };
}

module.exports = {
  classifyReleases
};
