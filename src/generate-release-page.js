const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { CONFIG, isUrl, fetchUrl } = require('./lib/config');
const { fetchAllReleases } = require('./lib/github-api');
const { classifyReleases } = require('./lib/tree-builder');
const { matchesFilter } = require('./lib/matcher');
const {
  generateFullHtml,
  generateMultiPageIndex,
  generateCategoryPages,
  loadCss,
  loadJs
} = require('./lib/html-generator');

/**
 * Strip content between hide tags from release bodies.
 * The tags are custom HTML-like tags (e.g., <hide-in-categorized-releases>...</hide-in-categorized-releases>)
 * that are stripped by GitHub when rendering but preserved in raw body.
 * @param {Array} releases - Array of release objects
 * @param {string} hideTag - The tag name to look for
 * @returns {Array} - Releases with stripped bodies
 */
function stripHiddenContent(releases, hideTag) {
  if (!hideTag) return releases;

  // Escape special regex characters in tag name
  const escapedTag = hideTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match <tag>...</tag> including multiline content (non-greedy)
  const regex = new RegExp(`<${escapedTag}>[\\s\\S]*?</${escapedTag}>`, 'gi');

  return releases.map(release => ({
    ...release,
    body: release.body ? release.body.replace(regex, '') : release.body
  }));
}

// ============================================================================
// Helper Functions
// ============================================================================

function copyDirRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function generateMultiPageSite(outputDir, tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases, latestAssets) {
  const pageSize = CONFIG.multiPage.pageSize;

  // Generate main index.html with sidebar
  const indexHtml = await generateMultiPageIndex(tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases, latestAssets);
  fs.writeFileSync(path.join(outputDir, 'index.html'), indexHtml);

  // Generate pages for each category
  await generateCategoryPages(outputDir, tree, unmatchedReleases, config, pageSize, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases, latestAssets);
}

// ============================================================================
// Main
// ============================================================================

async function loadConfig() {
  console.log(`Loading configuration from ${CONFIG.configPath}...`);

  let configContent;
  let configDir;

  if (isUrl(CONFIG.configPath)) {
    configContent = await fetchUrl(CONFIG.configPath);
    // For remote configs, derive MAIN.md URL from config URL
    configDir = CONFIG.configPath.substring(0, CONFIG.configPath.lastIndexOf('/'));
  } else {
    if (!fs.existsSync(CONFIG.configPath)) {
      throw new Error(`Configuration file not found: ${CONFIG.configPath}`);
    }
    configContent = fs.readFileSync(CONFIG.configPath, 'utf8');
    configDir = path.dirname(CONFIG.configPath);
  }

  const config = yaml.load(configContent);

  // Handle main-page configuration
  const mainPageConfig = config.site && config.site['main-page'];
  if (mainPageConfig && mainPageConfig.render) {
    try {
      if (mainPageConfig.content) {
        // Inline content takes priority
        console.log('Using inline main page content');
        CONFIG.mainMdContent = mainPageConfig.content;
      } else {
        // Use content-file or default to MAIN.md
        const contentFile = mainPageConfig['content-file'] || 'MAIN.md';

        if (isUrl(contentFile)) {
          // Absolute URL
          console.log(`Loading main page from ${contentFile}...`);
          CONFIG.mainMdContent = await fetchUrl(contentFile);
        } else if (isUrl(CONFIG.configPath)) {
          // Config is remote, resolve relative path
          const fileUrl = `${configDir}/${contentFile}`;
          console.log(`Loading main page from ${fileUrl}...`);
          CONFIG.mainMdContent = await fetchUrl(fileUrl);
        } else {
          // Config is local, resolve relative path
          const filePath = path.isAbsolute(contentFile) ? contentFile : path.join(configDir, contentFile);
          if (fs.existsSync(filePath)) {
            console.log(`Loading main page from ${filePath}...`);
            CONFIG.mainMdContent = fs.readFileSync(filePath, 'utf8');
          } else {
            console.warn(`Main page file not found: ${filePath}`);
          }
        }
      }
    } catch (err) {
      console.warn('Could not load main page content:', err.message);
    }
  }

  // Handle multi-page configuration
  const multiPageConfig = config['multi-page'] || {};
  CONFIG.multiPage = {
    enabled: multiPageConfig.enabled === true,
    pageSize: multiPageConfig['page-size'] === false ? null : (multiPageConfig['page-size'] || 50)
  };
  if (CONFIG.multiPage.enabled) {
    console.log(`Multi-page mode enabled, page size: ${CONFIG.multiPage.pageSize || 'unlimited'}`);
  }

  // Handle favicon
  if (config.site && config.site.favicon) {
    const favicon = config.site.favicon;
    if (isUrl(favicon)) {
      // Remote favicon - use URL directly
      CONFIG.faviconUrl = favicon;
      console.log(`Using remote favicon: ${favicon}`);
    } else {
      // Local favicon - resolve relative to config file
      let faviconPath;
      if (isUrl(CONFIG.configPath)) {
        // Config is remote, treat favicon as relative URL
        CONFIG.faviconUrl = `${configDir}/${favicon}`;
        console.log(`Using remote favicon: ${CONFIG.faviconUrl}`);
      } else {
        // Config is local, resolve path and mark for copying
        faviconPath = path.isAbsolute(favicon) ? favicon : path.join(configDir, favicon);
        if (fs.existsSync(faviconPath)) {
          CONFIG.faviconPath = faviconPath;
          CONFIG.faviconUrl = path.basename(favicon);
          console.log(`Will copy favicon from: ${faviconPath}`);
        } else {
          console.warn(`Favicon not found: ${faviconPath}`);
        }
      }
    }
  }

  return config;
}

async function main() {
  // If --save-releases is used, just fetch and save releases, then exit
  if (CONFIG.saveReleasesFile) {
    if (!CONFIG.repo) {
      throw new Error('--save-releases requires --repo');
    }
    console.log(`Fetching releases from ${CONFIG.repo}...`);
    const { fetchReleasesFromApi, saveReleasesToFile } = require('./lib/github-api');
    const releaseData = await fetchReleasesFromApi(false); // Fetch all (false = unlimited)
    saveReleasesToFile(releaseData, CONFIG.saveReleasesFile);
    console.log(`Done! Saved ${releaseData.releases.length} releases to ${CONFIG.saveReleasesFile}`);
    return;
  }

  const config = await loadConfig();

  console.log(`Output directory: ${CONFIG.outputDir}`);

  const maxReleases = (config.site && config.site['max-releases']) ?? 1000;
  if (maxReleases !== false && maxReleases < 1) {
    console.error(`Error: site.max-releases must be false or a positive integer, got: ${maxReleases}`);
    process.exit(1);
  }
  console.log('Fetching releases...' + (maxReleases !== false ? ` (limited to ${maxReleases})` : ''));
  const releaseData = await fetchAllReleases(maxReleases);
  let releases = releaseData.releases;

  console.log(`Found ${releaseData.totalCount} releases, fetched ${releaseData.listedCount}`);

  // Strip hidden content from release bodies
  const hideTag = (config.site && config.site['hide-tag']) ?? 'hide-in-categorized-releases';
  if (hideTag !== false) {
    releases = stripHiddenContent(releases, hideTag);
  }

  // Apply global include/exclude filters
  const includeFilter = config.include;
  const excludeFilter = config.exclude;
  if (includeFilter || excludeFilter) {
    const beforeCount = releases.length;
    releases = releases.filter(r =>
      matchesFilter(r, includeFilter) && !matchesFilter(r, excludeFilter)
    );
    const filtered = beforeCount - releases.length;
    if (filtered > 0) {
      console.log(`Filtered out ${filtered} releases by include/exclude rules`);
    }
  }

  if (releaseData.totalCount === 0) {
    console.error('Error: Repository has no releases. Nothing to generate.');
    process.exit(1);
  }

  console.log('Classifying releases...');
  const configDefaults = config.defaults || {};
  const defaults = {
    latestMatch: configDefaults['latest-match'],
    cutoffDate: configDefaults['cutoff-date'],
    maxDisplayed: configDefaults['max-displayed']
  };
  const unmatchedConfig = config.unmatched || {};
  const { tree, unmatchedReleases, defaultMaxDisplayed, unmatchedMaxDisplayed } = classifyReleases(releases, config.categories || [], defaults, unmatchedConfig);

  // Collect all listed releases after classification (cutoff-date filtering, etc.)
  // to get accurate count and oldest listed release
  function collectReleases(categories, releases) {
    for (const cat of categories) {
      for (const r of cat.releases) {
        releases.set(r.id, r);
      }
      if (cat.categories) {
        collectReleases(cat.categories, releases);
      }
    }
  }
  const listedReleases = new Map();
  collectReleases(tree, listedReleases);
  for (const r of unmatchedReleases) {
    listedReleases.set(r.id, r);
  }

  // Collect all releases marked as isLatest from tree + unmatched
  function collectLatestReleases(categories, latestMap) {
    for (const cat of categories) {
      for (const r of cat.releases) {
        if (r.isLatest) latestMap.set(r.id, r);
      }
      if (cat.categories) collectLatestReleases(cat.categories, latestMap);
    }
  }

  const latestReleasesMap = new Map();
  collectLatestReleases(tree, latestReleasesMap);
  for (const r of unmatchedReleases) {
    if (r.isLatest) latestReleasesMap.set(r.id, r);
  }

  // Sort by date descending
  const latestReleases = Array.from(latestReleasesMap.values())
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Extract deduplicated assets (most recent release wins for duplicate names)
  function extractDeduplicatedAssets(releases) {
    const assetMap = new Map();
    for (const release of releases) {
      for (const asset of (release.assets || [])) {
        if (asset.isSourceCode) continue;
        if (!assetMap.has(asset.name)) {
          assetMap.set(asset.name, {
            name: asset.name,
            url: asset.url,
            size: asset.size,
            releaseDate: release.publishedAt,
            releaseUrl: release.url,
            releaseTitle: release.name
          });
        }
      }
    }
    return Array.from(assetMap.values());
  }

  const latestAssets = extractDeduplicatedAssets(latestReleases);

  // Find oldest listed release (by publishedAt date)
  let oldestListed = null;
  for (const r of listedReleases.values()) {
    if (!oldestListed || new Date(r.publishedAt) < new Date(oldestListed.publishedAt)) {
      oldestListed = r;
    }
  }

  // Store release stats for sidebar note
  // hasAllReleases: true if we fetched all existing releases (so per-category counts are accurate)
  const hasAllReleases = releaseData.listedCount >= releaseData.totalCount;
  CONFIG.releaseStats = {
    listedCount: listedReleases.size,
    totalCount: releaseData.totalCount,
    hasAllReleases: hasAllReleases,
    oldestListedDate: oldestListed ? oldestListed.publishedAt : null,
    oldestListedUrl: oldestListed ? oldestListed.url : null,
    oldestExistingDate: releaseData.oldestExistingDate,
    oldestExistingUrl: releaseData.oldestExistingUrl
  };

  console.log(`Listing ${listedReleases.size} releases, unmatched: ${unmatchedReleases.length}`);
  if (latestReleases.length > 0) {
    console.log(`Latest releases: ${latestReleases.length}, unique assets: ${latestAssets.length}`);
  }

  // Validate local favicon exists before starting generation
  if (CONFIG.faviconPath && !fs.existsSync(CONFIG.faviconPath)) {
    throw new Error(`Favicon file not found: ${CONFIG.faviconPath}`);
  }

  // Create temp directory for atomic writes
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'releases-tree-'));

  try {
    // Generate and write all files to temp directory
    console.log('Generating content...');

    const isMultiPage = CONFIG.multiPage && CONFIG.multiPage.enabled;

    if (isMultiPage) {
      // Multi-page mode: generate index.html + category page files
      await generateMultiPageSite(tempDir, tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases, latestAssets);
    } else {
      // Single-page mode: generate single index.html with all content
      fs.writeFileSync(path.join(tempDir, 'index.html'), await generateFullHtml(tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases, latestAssets));
    }

    fs.writeFileSync(path.join(tempDir, 'style.css'), await loadCss(config));
    fs.writeFileSync(path.join(tempDir, 'script.js'), loadJs(isMultiPage));

    if (CONFIG.faviconPath) {
      fs.copyFileSync(CONFIG.faviconPath, path.join(tempDir, CONFIG.faviconUrl));
    }

    // All files generated successfully - copy to final destination
    console.log('Writing output files...');
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });

    // Copy files recursively for multi-page mode
    copyDirRecursive(tempDir, CONFIG.outputDir);

    console.log(`Done! Output written to ${CONFIG.outputDir}`);
  } finally {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
