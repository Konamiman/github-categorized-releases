const fs = require('fs');
const { CONFIG } = require('./config');

// ============================================================================
// GitHub API & Releases Data
// ============================================================================

/**
 * Generate source code asset entries for a release
 */
function getSourceCodeAssets(repo, tag) {
  if (!repo || !tag) return [];
  return [
    {
      name: 'Source code (zip)',
      url: `https://github.com/${repo}/archive/refs/tags/${tag}.zip`,
      size: null,
      isSourceCode: true
    },
    {
      name: 'Source code (tar.gz)',
      url: `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`,
      size: null,
      isSourceCode: true
    }
  ];
}

/**
 * Load releases from a local JSON file
 */
function loadReleasesFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Releases file not found: ${filePath}`);
  }

  console.log(`Loading releases from ${filePath}...`);
  const content = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(content);

  // Support both { releases: [...] } and plain [...] formats
  const releases = Array.isArray(data) ? data : data.releases;

  if (!Array.isArray(releases)) {
    throw new Error(`Invalid releases file format: expected array or { releases: [...] }`);
  }

  // Use repository from file if not specified via CLI
  if (!CONFIG.repo && data.repository) {
    CONFIG.repo = data.repository;
  }

  const oldestListed = releases.length > 0 ? releases[releases.length - 1] : null;

  return {
    releases,
    totalCount: releases.length,
    listedCount: releases.length,
    oldestListedDate: oldestListed ? oldestListed.publishedAt : null,
    oldestListedUrl: oldestListed ? oldestListed.url : null,
    oldestExistingDate: oldestListed ? oldestListed.publishedAt : null,
    oldestExistingUrl: oldestListed ? oldestListed.url : null
  };
}

/**
 * Save releases data to a JSON file for caching
 */
function saveReleasesToFile(releaseData, filePath) {
  console.log(`Saving releases to ${filePath}...`);

  // Filter out source code assets (they're auto-generated on load)
  const releasesWithoutSourceAssets = releaseData.releases.map(r => ({
    ...r,
    assets: (r.assets || []).filter(a => !a.isSourceCode)
  }));

  const output = {
    savedAt: new Date().toISOString(),
    repository: CONFIG.repo,
    totalCount: releaseData.totalCount,
    listedCount: releaseData.listedCount,
    releases: releasesWithoutSourceAssets
  };
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
}

/**
 * Fetch releases from GitHub API
 */
async function fetchReleasesFromApi(maxReleases = false) {
  if (!CONFIG.repo) {
    throw new Error('No repository specified. Use --repo option.');
  }

  const [owner, repo] = CONFIG.repo.split('/');
  const releases = [];
  let page = 1;
  const perPage = 100;
  let totalCount = 0;
  let oldestExistingRelease = null;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?page=${page}&per_page=${perPage}`;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'github-categorized-releases'
    };

    if (CONFIG.token) {
      headers['Authorization'] = `token ${CONFIG.token}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.length === 0) break;

    for (const r of data) {
      totalCount++;
      oldestExistingRelease = r;

      if (maxReleases !== false && releases.length >= maxReleases) {
        continue; // Keep counting but don't add more releases
      }

      releases.push(r);
    }

    if (data.length < perPage) break;
    page++;
  }

  const mappedReleases = releases.map(r => {
    const uploadedAssets = (r.assets || []).map(a => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size
    }));
    const sourceAssets = getSourceCodeAssets(CONFIG.repo, r.tag_name);

    return {
      id: r.id,
      name: r.name || r.tag_name,
      tag: r.tag_name,
      url: r.html_url,
      body: r.body || '',
      prerelease: r.prerelease,
      draft: r.draft,
      publishedAt: r.published_at,
      author: r.author ? {
        login: r.author.login,
        avatarUrl: r.author.avatar_url,
        url: r.author.html_url
      } : null,
      assets: [...uploadedAssets, ...sourceAssets],
      reactions: r.reactions ? {
        '+1': r.reactions['+1'] || 0,
        '-1': r.reactions['-1'] || 0,
        laugh: r.reactions.laugh || 0,
        hooray: r.reactions.hooray || 0,
        confused: r.reactions.confused || 0,
        heart: r.reactions.heart || 0,
        rocket: r.reactions.rocket || 0,
        eyes: r.reactions.eyes || 0,
        total_count: r.reactions.total_count || 0
      } : null
    };
  });

  const oldestListed = mappedReleases.length > 0 ? mappedReleases[mappedReleases.length - 1] : null;

  return {
    releases: mappedReleases,
    totalCount,
    listedCount: mappedReleases.length,
    oldestListedDate: oldestListed ? oldestListed.publishedAt : null,
    oldestListedUrl: oldestListed ? oldestListed.url : null,
    oldestExistingDate: oldestExistingRelease ? oldestExistingRelease.published_at : null,
    oldestExistingUrl: oldestExistingRelease ? oldestExistingRelease.html_url : null
  };
}

/**
 * Main function to get releases - from file or API based on config
 */
async function fetchAllReleases(maxReleases = false) {
  // Validate options
  if (CONFIG.releasesFile && CONFIG.repo) {
    throw new Error('Cannot specify both --repo and --releases-file. Use one or the other.');
  }

  let releaseData;

  if (CONFIG.releasesFile) {
    // Load from local file
    releaseData = loadReleasesFromFile(CONFIG.releasesFile);

    // Add source code assets to releases (now that CONFIG.repo is set)
    if (CONFIG.repo) {
      releaseData.releases = releaseData.releases.map(r => ({
        ...r,
        assets: [...(r.assets || []), ...getSourceCodeAssets(CONFIG.repo, r.tag)]
      }));
    }

    // Apply maxReleases limit if specified
    if (maxReleases !== false && releaseData.releases.length > maxReleases) {
      releaseData.releases = releaseData.releases.slice(0, maxReleases);
      releaseData.listedCount = releaseData.releases.length;
      const oldestListed = releaseData.releases[releaseData.releases.length - 1];
      releaseData.oldestListedDate = oldestListed ? oldestListed.publishedAt : null;
      releaseData.oldestListedUrl = oldestListed ? oldestListed.url : null;
    }
  } else {
    // Fetch from GitHub API
    releaseData = await fetchReleasesFromApi(maxReleases);
  }

  return releaseData;
}

/**
 * Render markdown using GitHub's API
 * Returns HTML string
 */
async function renderMarkdownViaGitHub(markdown) {
  if (!markdown) return '';

  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'github-categorized-releases',
    'Content-Type': 'application/json'
  };

  if (CONFIG.token) {
    headers['Authorization'] = `token ${CONFIG.token}`;
  }

  const body = {
    text: markdown,
    mode: 'gfm'
  };

  // Add repository context for autolinks if available
  if (CONFIG.repo) {
    body.context = CONFIG.repo;
  }

  const response = await fetch('https://api.github.com/markdown', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`GitHub Markdown API error: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

module.exports = {
  fetchAllReleases,
  loadReleasesFromFile,
  saveReleasesToFile,
  fetchReleasesFromApi,
  renderMarkdownViaGitHub
};
