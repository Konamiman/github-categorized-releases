const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const hljs = require('highlight.js');
const { CONFIG, isUrl, fetchUrl } = require('./config');
const { renderMarkdownViaGitHub } = require('./github-api');

// GitHub-style autolink extension for marked
const githubAutolinks = {
  name: 'githubAutolinks',
  level: 'inline',
  start(src) {
    // Look for # or @ as potential starts
    // For #, exclude when preceded by & (HTML entities like &#8203;)
    const hashMatch = src.match(/(?:^|[^&\w/])#(?!\d+;)/);
    const atMatch = src.match(/(?:^|[^\w])@(?![/])/);
    const repoIssueMatch = src.match(/[\w.-]+\/[\w.-]+#(?!\d+;)/);

    const positions = [];
    if (hashMatch) positions.push(hashMatch.index + (hashMatch[0].length - 1));
    if (atMatch) positions.push(atMatch.index + (atMatch[0].length - 1));
    if (repoIssueMatch) positions.push(repoIssueMatch.index);

    return positions.length > 0 ? Math.min(...positions) : -1;
  },
  tokenizer(src, tokens) {
    // Cross-repo issue reference: owner/repo#123
    const repoIssueRule = /^([\w.-]+\/[\w.-]+)#(\d+)/;
    let match = repoIssueRule.exec(src);
    if (match) {
      return {
        type: 'githubAutolinks',
        raw: match[0],
        href: `https://github.com/${match[1]}/issues/${match[2]}`,
        text: match[0]
      };
    }

    // Issue/PR reference: #123
    // Skip if it looks like an HTML entity (e.g., &#8203;)
    const issueRule = /^#(\d+)\b/;
    match = issueRule.exec(src);
    if (match && CONFIG.repo) {
      // Check if this is an HTML entity (digits followed by ;)
      const afterMatch = src.substring(match[0].length);
      if (afterMatch.startsWith(';')) {
        return undefined; // Skip - this is an HTML entity like &#8203;
      }
      return {
        type: 'githubAutolinks',
        raw: match[0],
        href: `https://github.com/${CONFIG.repo}/issues/${match[1]}`,
        text: match[0]
      };
    }

    // User mention: @username (valid GitHub usernames: alphanumeric and hyphens, no consecutive hyphens)
    // Skip if followed by / (package scope like @mui/material) or if looks like email/version
    const userRule = /^@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\b/;
    match = userRule.exec(src);
    if (match) {
      const nextChar = src[match[0].length];
      // Skip if followed by / (scoped package) or @ (package@version)
      if (nextChar === '/' || nextChar === '@') {
        return undefined;
      }
      // Skip if username looks like a version number (e.g., @7.3.6)
      if (/^\d/.test(match[1])) {
        return undefined;
      }
      return {
        type: 'githubAutolinks',
        raw: match[0],
        href: `https://github.com/${match[1]}`,
        text: match[0]
      };
    }

    return undefined;
  },
  renderer(token) {
    return `<a href="${token.href}">${token.text}</a>`;
  }
};

// Configure marked with syntax highlighting
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {
        // Fall through to auto-detection
      }
    }
    // Try auto-detection for unknown languages
    try {
      return hljs.highlightAuto(code).value;
    } catch (err) {
      return code;
    }
  }
}));

// Configure marked with GitHub autolinks and mailto fix
marked.use({
  extensions: [githubAutolinks],
  renderer: {
    link(token) {
      const href = token.href || '';
      const text = token.text || '';
      // Skip mailto links that look like package@version (e.g., material@7.3.6)
      if (href.startsWith('mailto:') && /^[^@]+@[\d.]+/.test(href.slice(7))) {
        return text;  // Return just the text, not a link
      }
      const title = token.title ? ` title="${token.title}"` : '';
      return `<a href="${href}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
    }
  }
});

// ============================================================================
// HTML Generation
// ============================================================================

/**
 * Sanitize rendered HTML by escaping dangerous tags that shouldn't appear in release notes.
 * These tags can break page rendering if passed through from markdown content.
 */
function sanitizeRenderedHtml(html) {
  // Escape tags that could break page structure or execute code
  const dangerousTags = ['title', 'script', 'style', 'head', 'body', 'html', 'meta', 'link', 'iframe', 'object', 'embed'];
  let result = html;
  for (const tag of dangerousTags) {
    // Escape opening tags (with or without attributes)
    result = result.replace(new RegExp(`<(${tag})(\\s|>|/>)`, 'gi'), '&lt;$1$2');
    // Escape closing tags
    result = result.replace(new RegExp(`</(${tag})>`, 'gi'), '&lt;/$1&gt;');
  }
  return result;
}

/**
 * Render markdown to HTML using either local marked or GitHub API
 */
async function renderMarkdown(markdown) {
  if (!markdown) return '';

  let html;
  if (CONFIG.useGitHubMarkdown) {
    html = await renderMarkdownViaGitHub(markdown);
  } else {
    html = marked.parse(markdown);
  }

  return sanitizeRenderedHtml(html);
}

function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, char => map[char]);
}

function formatDate(isoDate) {
  // Return empty span with data attribute for client-side formatting
  if (!isoDate) return '';
  return `<span class="date-value" data-date="${isoDate}"></span>`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function renderReactions(reactions) {
  if (!reactions || reactions.total_count === 0) return '';

  const reactionEmojis = {
    '+1': '👍',
    '-1': '👎',
    laugh: '😄',
    hooray: '🎉',
    confused: '😕',
    heart: '❤️',
    rocket: '🚀',
    eyes: '👀'
  };

  const items = Object.entries(reactionEmojis)
    .filter(([key]) => reactions[key] > 0)
    .map(([key, emoji]) => `<span class="reaction-item" title="${key}">${emoji} ${reactions[key]}</span>`)
    .join('');

  if (!items) return '';

  return `<span class="release-reactions">${items}</span>`;
}

// Generate slug IDs from names
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')  // Remove non-word chars except spaces and hyphens
    .replace(/\s+/g, '-')       // Replace spaces with hyphens
    .replace(/-+/g, '-')        // Collapse multiple hyphens
    .replace(/^-|-$/g, '');     // Trim hyphens from start/end
}

function generateReleaseHtml(release) {
  const latestBadge = release.isLatest
    ? '<span class="badge latest">Latest</span>'
    : '';
  const prereleaseBadge = release.prerelease
    ? '<span class="badge prerelease">Pre-release</span>'
    : '';
  const prereleaseAttr = release.prerelease ? 'true' : 'false';

  // GitHub link to see release on GitHub
  const githubLink = `
        <a href="${escapeHtml(release.url)}" class="release-github-link" title="See release in GitHub" onclick="event.stopPropagation()">
          <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
          </svg>
          <span>See release in GitHub</span>
        </a>`;

  // Render full assets list
  let assetsHtml = '';
  if (release.assets && release.assets.length > 0) {
    // Icons: 3D cube/package for uploaded assets, zipper for source code
    const packageIcon = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
      <path d="m8.878.392 5.25 3.045c.54.314.872.89.872 1.514v6.098a1.75 1.75 0 0 1-.872 1.514l-5.25 3.045a1.75 1.75 0 0 1-1.756 0l-5.25-3.045A1.75 1.75 0 0 1 1 11.049V4.951c0-.624.332-1.201.872-1.514L7.122.392a1.75 1.75 0 0 1 1.756 0ZM7.875 1.69l-4.63 2.685L8 7.133l4.755-2.758-4.63-2.685a.248.248 0 0 0-.25 0ZM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432Zm6.25 8.271 4.625-2.683a.25.25 0 0 0 .125-.216V5.677L8.75 8.432Z"></path>
    </svg>`;
    const zipperIcon = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
      <path d="M3.5 1.75v11.5c0 .09.048.173.126.217a.75.75 0 0 1-.752 1.298A1.748 1.748 0 0 1 2 13.25V1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.185 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 12.25 15h-.5a.75.75 0 0 1 0-1.5h.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177L9.513 1.573a.25.25 0 0 0-.177-.073H7v1.5h1.75a.75.75 0 0 1 0 1.5H7v1.5h1.75a.75.75 0 0 1 0 1.5H7v1.5h1.75a.75.75 0 0 1 0 1.5H7v3a.75.75 0 0 1-1.5 0v-3H3.75a.75.75 0 0 1 0-1.5H5.5V7H3.75a.75.75 0 0 1 0-1.5H5.5V4H3.75a.75.75 0 0 1 0-1.5H5.5v-1a.75.75 0 0 1 .75-.75h3a.25.25 0 0 0-.177-.073H3.75a.25.25 0 0 0-.25.25Z"></path>
    </svg>`;

    assetsHtml = `
      <details class="assets" open>
        <summary class="assets-header">
          <svg class="octicon chevron" viewBox="0 0 16 16" width="16" height="16">
            <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
          </svg>
          <span class="assets-title">Assets</span>
          <span class="assets-count">${release.assets.length}</span>
        </summary>
        <div class="assets-table">
          ${release.assets.map(a => `
            <div class="asset-row">
              ${a.isSourceCode ? zipperIcon : packageIcon}
              <a href="${escapeHtml(a.url)}" class="asset-name">${escapeHtml(a.name)}</a>
              ${a.size != null ? `<span class="asset-size">${formatBytes(a.size)}</span>` : ''}
            </div>
          `).join('')}
        </div>
      </details>
    `;
  }

  // Render full markdown body (use pre-rendered if available)
  let bodyHtml = '';
  if (release.body) {
    const renderedBody = release._renderedBody || sanitizeRenderedHtml(marked.parse(release.body));
    bodyHtml = `<div class="release-body">${renderedBody}</div>`;
  }

  // Only add collapsible content if there's body or assets
  const hasContent = bodyHtml || assetsHtml;
  const contentHtml = hasContent ? `
      <div class="release-content">
        ${bodyHtml}
        ${assetsHtml}
      </div>
  ` : '';

  // Toggle button only if there's content to collapse
  const toggleButton = hasContent ? `
        <button class="release-toggle" onclick="event.stopPropagation(); toggleReleaseCard(this.closest('.release-card'))" title="Toggle details">
          <svg class="octicon chevron-down" viewBox="0 0 16 16" width="16" height="16">
            <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
          </svg>
        </button>
  ` : '';

  // Badges HTML (only if there are any)
  const badgesHtml = (latestBadge || prereleaseBadge) ? `
        <div class="release-badges">
          ${latestBadge}
          ${prereleaseBadge}
        </div>` : '';

  return `
    <div class="release-card" data-release-id="${release.id}" data-is-latest="${release.isLatest || false}" data-is-prerelease="${prereleaseAttr}">
      <div class="release-card-header" onclick="if(event.target.tagName !== 'A' && !event.target.closest('.release-github-link')) toggleReleaseCard(this.closest('.release-card'))">
        <div class="release-header-main">
          <div class="release-info">
            <span class="release-title">${escapeHtml(release.name)}</span>
            ${githubLink}
          </div>
          <div class="release-meta">
            <span class="release-tag">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"></path>
              </svg>
              ${escapeHtml(release.tag)}
            </span>
            <span class="release-date">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z"></path>
              </svg>
              ${formatDate(release.publishedAt)}
            </span>
            ${release.author ? `
            <a href="${escapeHtml(release.author.url)}" class="release-author">
              <img src="${escapeHtml(release.author.avatarUrl)}" alt="${escapeHtml(release.author.login)}" class="author-avatar">
              <span>${escapeHtml(release.author.login)}</span>
            </a>
            ` : ''}
            ${renderReactions(release.reactions)}
          </div>
        </div>
        ${badgesHtml}
        ${toggleButton}
      </div>
      ${contentHtml}
    </div>
  `;
}

function countSubcategoryReleases(categories, filter = {}) {
  let count = 0;
  for (const category of categories) {
    count += countFilteredReleases(category.releases, filter, category.maxDisplayed);
    if (category.categories) {
      count += countSubcategoryReleases(category.categories, filter);
    }
  }
  return count;
}

function countFilteredReleases(releases, filter = {}, maxDisplayed = null) {
  // First apply maxDisplayed truncation (this matches what's actually in the HTML)
  let displayedReleases = releases;
  if (maxDisplayed !== null && maxDisplayed !== undefined && maxDisplayed !== false && releases.length > maxDisplayed) {
    displayedReleases = releases.slice(0, maxDisplayed);
  }
  // Then count how many of the displayed releases match the filter
  return displayedReleases.filter(r => {
    if (filter.latestOnly && !r.isLatest) return false;
    if (filter.hidePrereleases && r.prerelease) return false;
    return true;
  }).length;
}

function formatReleaseCount(directCount, subcategoryCount) {
  if (directCount > 0 && subcategoryCount > 0) {
    return `${directCount}+${subcategoryCount}`;
  } else if (directCount > 0) {
    return `${directCount}`;
  } else if (subcategoryCount > 0) {
    return `+${subcategoryCount}`;
  } else {
    return '0';
  }
}

function calculateAllCounts(category) {
  const hasChildren = category.categories && category.categories.length > 0;

  // All 4 filter combinations
  const filters = [
    { key: 'all', latestOnly: false, hidePrereleases: false },
    { key: 'nopre', latestOnly: false, hidePrereleases: true },
    { key: 'latest', latestOnly: true, hidePrereleases: false },
    { key: 'latestnopre', latestOnly: true, hidePrereleases: true }
  ];

  const counts = {};
  for (const f of filters) {
    const direct = countFilteredReleases(category.releases, f, category.maxDisplayed);
    const sub = hasChildren ? countSubcategoryReleases(category.categories, f) : 0;
    counts[f.key] = formatReleaseCount(direct, sub);
  }

  return counts;
}

function generateSidebarCategoryHtml(category, config, depth = 0) {
  const categoryId = category.id;
  const hasChildren = category.categories && category.categories.length > 0;
  const counts = calculateAllCounts(category);

  // Build tooltip: configured tooltip + truncation info if applicable
  const totalReleases = category.releases.length;
  const maxDisplayed = category.maxDisplayed;
  const isTruncated = maxDisplayed !== null && maxDisplayed !== undefined && maxDisplayed !== false && totalReleases > maxDisplayed;
  const truncationText = isTruncated ? `Displaying ${maxDisplayed} of ${totalReleases} listed releases` : '';

  let tooltipText = '';
  if (category.tooltip && truncationText) {
    tooltipText = `${category.tooltip}\n${truncationText}`;
  } else if (category.tooltip) {
    tooltipText = category.tooltip;
  } else if (truncationText) {
    tooltipText = truncationText;
  }
  const tooltipAttr = tooltipText ? ` title="${escapeHtml(tooltipText)}"` : '';

  const childrenHtml = hasChildren
    ? `<ul class="nav-children">${category.categories.map(c => generateSidebarCategoryHtml(c, config, depth + 1)).join('')}</ul>`
    : '';

  const expandIcon = hasChildren
    ? `<span class="nav-toggle" onclick="event.stopPropagation(); toggleNavCategory('${categoryId}')">
         <svg class="octicon chevron" viewBox="0 0 16 16" width="16" height="16">
           <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path>
         </svg>
       </span>`
    : '<span class="nav-toggle-placeholder"></span>';

  return `
    <li class="nav-item${hasChildren ? ' has-children' : ''}" data-category-id="${categoryId}">
      <div class="nav-link"${tooltipAttr} onclick="selectCategory('${categoryId}')">
        ${expandIcon}
        <span class="nav-name">${escapeHtml(category.name)}</span>
        <span class="nav-count" data-count-all="${counts.all}" data-count-nopre="${counts.nopre}" data-count-latest="${counts.latest}" data-count-latestnopre="${counts.latestnopre}">${counts.all}</span>
      </div>
      ${childrenHtml}
    </li>
  `;
}

function countReleases(category) {
  let count = category.releases.length;
  for (const sub of category.categories || []) {
    count += countReleases(sub);
  }
  return count;
}

function assignCategoryIds(categories, parentPath = '') {
  function process(category, parentPath) {
    const slug = slugify(category.name);
    category.id = parentPath ? `${parentPath}/${slug}` : slug;
    if (category.categories) {
      category.categories.forEach(c => process(c, category.id));
    }
  }
  categories.forEach(c => process(c, parentPath));
}

function collectAllCategories(categories, result = {}) {
  for (const category of categories) {
    result[category.id] = {
      name: category.name,
      description: category.description || '',
      _renderedDescription: category._renderedDescription || '',
      releases: category.releases,
      children: (category.categories || []).map(c => ({ id: c.id, name: c.name })),
      maxDisplayed: category.maxDisplayed
    };
    if (category.categories) {
      collectAllCategories(category.categories, result);
    }
  }
  return result;
}

/**
 * Pre-render all markdown content using either local marked or GitHub API
 * This allows batching API calls for better performance
 */
async function preRenderAllMarkdown(tree, unmatchedReleases, mainMdContent) {
  // Collect all markdown that needs rendering
  const markdownItems = [];

  // Main page content
  if (mainMdContent) {
    markdownItems.push({ type: 'main', content: mainMdContent });
  }

  // Track releases by ID to avoid rendering duplicates
  // (releases can appear in multiple categories)
  const releaseMap = new Map(); // id -> { release instances, body }

  // Category descriptions (recursive)
  function collectCategoryMarkdown(categories) {
    for (const cat of categories) {
      if (cat.description) {
        markdownItems.push({ type: 'category', category: cat, content: cat.description });
      }
      // Collect release instances by ID
      for (const release of cat.releases || []) {
        if (release.body) {
          if (!releaseMap.has(release.id)) {
            releaseMap.set(release.id, { instances: [], body: release.body });
          }
          releaseMap.get(release.id).instances.push(release);
        }
      }
      if (cat.categories) {
        collectCategoryMarkdown(cat.categories);
      }
    }
  }
  collectCategoryMarkdown(tree);

  // Unmatched release bodies
  for (const release of unmatchedReleases) {
    if (release.body) {
      if (!releaseMap.has(release.id)) {
        releaseMap.set(release.id, { instances: [], body: release.body });
      }
      releaseMap.get(release.id).instances.push(release);
    }
  }

  // Add unique releases to markdown items
  for (const [id, data] of releaseMap) {
    markdownItems.push({ type: 'release', instances: data.instances, content: data.body });
  }

  // Render all markdown
  const results = {};
  if (CONFIG.useGitHubMarkdown) {
    // Render sequentially to avoid rate limits (could be parallelized with care)
    const total = markdownItems.length;
    let current = 0;
    for (const item of markdownItems) {
      current++;
      process.stdout.write(`\rRendering markdown via GitHub API: ${current}/${total}`);
      const html = await renderMarkdown(item.content);
      if (item.type === 'main') {
        results.mainPageHtml = html;
      } else if (item.type === 'category') {
        item.category._renderedDescription = html;
      } else if (item.type === 'release') {
        // Apply to all instances of this release (it may appear in multiple categories)
        for (const instance of item.instances) {
          instance._renderedBody = html;
        }
      }
    }
    process.stdout.write('\n'); // Move to next line after completion
  } else {
    // Local rendering is fast, can do synchronously
    for (const item of markdownItems) {
      const html = sanitizeRenderedHtml(marked.parse(item.content));
      if (item.type === 'main') {
        results.mainPageHtml = html;
      } else if (item.type === 'category') {
        item.category._renderedDescription = html;
      } else if (item.type === 'release') {
        // Apply to all instances of this release (it may appear in multiple categories)
        for (const instance of item.instances) {
          instance._renderedBody = html;
        }
      }
    }
  }

  return results;
}

// ============================================================================
// Latest Page Generation
// ============================================================================

function generateAssetsTableHtml(assets) {
  if (assets.length === 0) {
    return '<p class="latest-empty"><em>No downloadable assets found</em></p>';
  }

  const packageIcon = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
    <path d="m8.878.392 5.25 3.045c.54.314.872.89.872 1.514v6.098a1.75 1.75 0 0 1-.872 1.514l-5.25 3.045a1.75 1.75 0 0 1-1.756 0l-5.25-3.045A1.75 1.75 0 0 1 1 11.049V4.951c0-.624.332-1.201.872-1.514L7.122.392a1.75 1.75 0 0 1 1.756 0ZM7.875 1.69l-4.63 2.685L8 7.133l4.755-2.758-4.63-2.685a.248.248 0 0 0-.25 0ZM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432Zm6.25 8.271 4.625-2.683a.25.25 0 0 0 .125-.216V5.677L8.75 8.432Z"></path>
  </svg>`;

  const rows = assets.map(a => `
    <tr class="latest-asset-row" data-name="${escapeHtml(a.name.toLowerCase())}" data-date="${a.releaseDate}">
      <td class="asset-cell asset-cell-icon">${packageIcon}</td>
      <td class="asset-cell asset-cell-name">
        <a href="${escapeHtml(a.url)}" class="asset-name">${escapeHtml(a.name)}</a>
      </td>
      <td class="asset-cell asset-cell-size">${formatBytes(a.size)}</td>
      <td class="asset-cell asset-cell-date">
        <a href="${escapeHtml(a.releaseUrl)}" class="asset-release-link" title="${escapeHtml(a.releaseTitle)}">
          <span class="date-value" data-date="${a.releaseDate}"></span>
        </a>
      </td>
    </tr>
  `).join('');

  return `
    <table class="latest-assets-table">
      <thead>
        <tr>
          <th></th>
          <th>Filename</th>
          <th>Size</th>
          <th>Release Date</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function generateLatestPageHtml(latestReleases, latestAssets, config, defaultMaxDisplayed) {
  // Empty state
  if (latestReleases.length === 0) {
    return '<p class="latest-empty"><em>There are no releases marked as latest</em></p>';
  }

  // Get latest-page specific settings
  const latestPageConfig = config['latest-page'] || {};

  // Resolve max-displayed for releases: explicit value > default (null resets to default, false disables)
  const configMaxDisplayed = latestPageConfig['max-displayed'];
  const releasesMaxDisplayed = configMaxDisplayed === null
    ? defaultMaxDisplayed
    : (configMaxDisplayed !== undefined ? configMaxDisplayed : defaultMaxDisplayed);

  // Resolve max-displayed for assets: explicit value > releases max-displayed > default
  const configAssetsMaxDisplayed = latestPageConfig['assets-max-displayed'];
  const assetsMaxDisplayed = configAssetsMaxDisplayed === null
    ? (releasesMaxDisplayed !== false ? releasesMaxDisplayed : defaultMaxDisplayed)
    : (configAssetsMaxDisplayed !== undefined ? configAssetsMaxDisplayed : releasesMaxDisplayed);

  // Apply max-displayed truncation to releases
  const shouldLimitReleases = releasesMaxDisplayed !== false && releasesMaxDisplayed !== null &&
    releasesMaxDisplayed !== undefined && latestReleases.length > releasesMaxDisplayed;
  const displayedReleases = shouldLimitReleases ? latestReleases.slice(0, releasesMaxDisplayed) : latestReleases;

  // Apply max-displayed truncation to assets
  const shouldLimitAssets = assetsMaxDisplayed !== false && assetsMaxDisplayed !== null &&
    assetsMaxDisplayed !== undefined && latestAssets.length > assetsMaxDisplayed;
  const displayedAssets = shouldLimitAssets ? latestAssets.slice(0, assetsMaxDisplayed) : latestAssets;

  // Generate display mode toggle buttons
  const displayModeHtml = `
    <div class="latest-display-modes">
      <button class="display-mode-btn active" data-mode="releases" onclick="setLatestDisplayMode('releases')">
        <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
          <path d="M1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0ZM1.5 1.75v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25ZM11.75 3a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm-8.25.75a.75.75 0 0 1 1.5 0v5.5a.75.75 0 0 1-1.5 0ZM8 3a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 3Z"></path>
        </svg>
        Releases
      </button>
      <span class="display-mode-divider">|</span>
      <span class="display-mode-label">Assets:</span>
      <button class="display-mode-btn" data-mode="assets-date-desc" onclick="setLatestDisplayMode('assets-date-desc')">
        Date ↓
      </button>
      <button class="display-mode-btn" data-mode="assets-date-asc" onclick="setLatestDisplayMode('assets-date-asc')">
        Date ↑
      </button>
      <button class="display-mode-btn" data-mode="assets-name-asc" onclick="setLatestDisplayMode('assets-name-asc')">
        A-Z
      </button>
      <button class="display-mode-btn" data-mode="assets-name-desc" onclick="setLatestDisplayMode('assets-name-desc')">
        Z-A
      </button>
    </div>
  `;

  // Generate release cards HTML (same as regular categories)
  const releasesHtml = displayedReleases.map(r => generateReleaseHtml(r)).join('');

  // Generate truncation banner for releases if needed
  let releasesTruncationHtml = '';
  if (shouldLimitReleases) {
    releasesTruncationHtml = `
    <div class="releases-truncated">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span>Displaying ${displayedReleases.length} of ${latestReleases.length} latest releases</span>
    </div>
    `;
  }

  // Generate assets table HTML
  const assetsTableHtml = generateAssetsTableHtml(displayedAssets);

  // Generate truncation banner for assets if needed
  let assetsTruncationHtml = '';
  if (shouldLimitAssets) {
    assetsTruncationHtml = `
    <div class="releases-truncated">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span>Displaying ${displayedAssets.length} of ${latestAssets.length} assets</span>
    </div>
    `;
  }

  // No-matches placeholder for filters
  const noMatchesHtml = `
    <div class="no-matches">
      <svg viewBox="0 0 24 24" width="48" height="48">
        <path fill="currentColor" d="M10.5 18.25a.75.75 0 0 1 0-1.5h7a.75.75 0 0 1 0 1.5h-7Zm-4-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Zm0-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Z"/>
      </svg>
      <p>No releases match the current filters</p>
    </div>
  `;

  return `
    ${displayModeHtml}
    <div class="latest-releases-view">${releasesHtml}${noMatchesHtml}${releasesTruncationHtml}</div>
    <div class="latest-assets-view" style="display: none;">${assetsTableHtml}${assetsTruncationHtml}</div>
  `;
}

async function generateFullHtml(tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases = [], latestAssets = []) {
  const siteConfig = config.site || {};
  const title = siteConfig.title || 'Releases';
  const description = siteConfig.description || '';
  const showLatestToggle = siteConfig['show-latest-only-toggle'] !== false;
  const mainPageConfig = siteConfig['main-page'] || {};
  const unmatchedConfig = config.unmatched || {};
  const showUnmatched = unmatchedConfig.show !== false;
  const unmatchedName = unmatchedConfig.name || 'Other';

  // Pre-render all markdown content
  const preRendered = await preRenderAllMarkdown(
    tree,
    unmatchedReleases,
    mainPageConfig.render ? CONFIG.mainMdContent : null
  );

  // Render main page if enabled and content is available
  let mainPageHtml = '';
  let hasMainPage = false;
  if (mainPageConfig.render && CONFIG.mainMdContent) {
    mainPageHtml = preRendered.mainPageHtml || '';
    hasMainPage = true;
  }

  // Assign IDs to all categories
  assignCategoryIds(tree);

  // Add unmatched as a category if needed
  let unmatchedCategory = null;
  if (showUnmatched && unmatchedReleases.length > 0) {
    unmatchedCategory = {
      id: 'category-unmatched',
      name: unmatchedName,
      releases: unmatchedReleases,
      categories: [],
      maxDisplayed: unmatchedMaxDisplayed !== undefined ? unmatchedMaxDisplayed : defaultMaxDisplayed
    };
  }

  // Generate Index entry for main page
  const indexSidebarHtml = hasMainPage ? `
    <li class="nav-item" data-category-id="index">
      <div class="nav-link" onclick="selectCategory('index')">
        <span class="nav-icon">
          <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
            <path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"></path>
          </svg>
        </span>
        <span class="nav-name">Index</span>
      </div>
    </li>
  ` : '';

  // Generate Latest page sidebar entry
  const latestPageConfig = config['latest-page'] || {};
  const showLatestPage = latestPageConfig.enable === true;
  const latestPageTitle = latestPageConfig.title || 'Latest';

  const latestSidebarHtml = showLatestPage ? `
    <li class="nav-item" data-category-id="latest-page">
      <div class="nav-link" onclick="selectCategory('latest-page')" title="${latestReleases.length} releases / ${latestAssets.length} assets">
        <span class="nav-icon">
          <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
            <path fill="currentColor" d="M8 1a7 7 0 0 1 7 7h-1.5A5.5 5.5 0 0 0 8 2.5V1Zm7 7a7 7 0 0 1-7 7v-1.5A5.5 5.5 0 0 0 13.5 8H15ZM8 15a7 7 0 0 1-7-7h1.5A5.5 5.5 0 0 0 8 13.5V15Z"/>
            <path fill="currentColor" d="M8 4a.75.75 0 0 1 .75.75v2.69l1.78 1.78a.75.75 0 1 1-1.06 1.06l-2-2a.75.75 0 0 1-.22-.53V4.75A.75.75 0 0 1 8 4Z"/>
            <path fill="currentColor" d="M2.5 3.5 5.5 8H-.5Z"/>
          </svg>
        </span>
        <span class="nav-name">${escapeHtml(latestPageTitle)}</span>
        <span class="nav-count">${latestReleases.length}/${latestAssets.length}</span>
      </div>
    </li>
  ` : '';

  // Generate sidebar HTML
  const sidebarHtml = tree.map(c => generateSidebarCategoryHtml(c, config)).join('');
  const unmatchedSidebarHtml = unmatchedCategory
    ? generateSidebarCategoryHtml(unmatchedCategory, config)
    : '';

  // Collect all categories for JSON data
  const allCategories = collectAllCategories(tree);
  if (unmatchedCategory) {
    allCategories[unmatchedCategory.id] = {
      name: unmatchedCategory.name,
      description: '',
      releases: unmatchedCategory.releases,
      children: [],
      maxDisplayed: unmatchedCategory.maxDisplayed
    };
  }

  // Add latest page entry if enabled
  if (showLatestPage) {
    allCategories['latest-page'] = {
      name: latestPageTitle,
      description: latestPageConfig.description || '',
      releases: latestReleases,
      assets: latestAssets,
      children: [],
      isLatestPage: true
    };
  }

  // Add index entry if main page exists
  if (hasMainPage) {
    allCategories['index'] = {
      name: 'Index',
      description: '',
      releases: [],
      children: [],
      isIndex: true
    };
  }

  // Calculate unique displayed releases for each filter combination
  // This is used for the sidebar footer and truncation banner info popups
  function calculateUniqueDisplayedCounts() {
    const uniqueAll = new Set();
    const uniqueNoPre = new Set();
    const uniqueLatest = new Set();
    const uniqueLatestNoPre = new Set();

    for (const [id, category] of Object.entries(allCategories)) {
      if (id === 'index') continue; // Skip index page
      const maxDisplayed = category.maxDisplayed;
      const shouldLimit = maxDisplayed !== null && maxDisplayed !== undefined && maxDisplayed !== false && category.releases.length > maxDisplayed;
      const displayedReleases = shouldLimit ? category.releases.slice(0, maxDisplayed) : category.releases;

      for (const r of displayedReleases) {
        uniqueAll.add(r.id);
        if (!r.prerelease) uniqueNoPre.add(r.id);
        if (r.isLatest) uniqueLatest.add(r.id);
        if (r.isLatest && !r.prerelease) uniqueLatestNoPre.add(r.id);
      }
    }

    return {
      all: uniqueAll.size,
      nopre: uniqueNoPre.size,
      latest: uniqueLatest.size,
      latestnopre: uniqueLatestNoPre.size
    };
  }
  const uniqueDisplayedCounts = calculateUniqueDisplayedCounts();

  // Pre-render all releases HTML for each category
  const categoryReleasesHtml = {};
  const categoryDescriptionsHtml = {};
  const noMatchesHtml = `
    <div class="no-matches">
      <svg viewBox="0 0 24 24" width="48" height="48">
        <path fill="currentColor" d="M10.5 18.25a.75.75 0 0 1 0-1.5h7a.75.75 0 0 1 0 1.5h-7Zm-4-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Zm0-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Z"/>
      </svg>
      <p>No releases match the current filters</p>
    </div>
  `;
  for (const [id, category] of Object.entries(allCategories)) {
    const totalReleases = category.releases.length;
    const maxDisplayed = category.maxDisplayed;
    const shouldLimit = maxDisplayed !== null && maxDisplayed !== undefined && maxDisplayed !== false && totalReleases > maxDisplayed;
    const displayedReleases = shouldLimit ? category.releases.slice(0, maxDisplayed) : category.releases;

    const releasesHtml = displayedReleases.map(r => generateReleaseHtml(r)).join('');

    // Generate truncation warning if releases were limited
    // Only show if we have ALL releases from the repository, otherwise we can't know the true matching count
    let truncationHtml = '';
    const hasAllReleases = CONFIG.releaseStats ? CONFIG.releaseStats.hasAllReleases : true;
    if (shouldLimit && hasAllReleases) {
      const firstHiddenRelease = category.releases[maxDisplayed];
      const seeMoreUrl = firstHiddenRelease ? firstHiddenRelease.url : (CONFIG.repo ? `https://github.com/${CONFIG.repo}/releases` : '#');

      // Calculate counts for each filter combination
      const countNonPre = (releases) => releases.filter(r => !r.prerelease).length;
      const countLatest = (releases) => releases.filter(r => r.isLatest).length;
      const countLatestNonPre = (releases) => releases.filter(r => r.isLatest && !r.prerelease).length;

      // Displayed counts (from the truncated list)
      const displayedAll = displayedReleases.length;
      const displayedNoPre = countNonPre(displayedReleases);
      const displayedLatest = countLatest(displayedReleases);
      const displayedLatestNoPre = countLatestNonPre(displayedReleases);

      // Matching counts (all releases that match this category)
      const matchingAll = totalReleases;
      const matchingNoPre = countNonPre(category.releases);
      const matchingLatest = countLatest(category.releases);
      const matchingLatestNoPre = countLatestNonPre(category.releases);

      // Site-wide counts
      const siteListedCount = uniqueDisplayedCounts.all;
      const siteExistingCount = CONFIG.releaseStats ? CONFIG.releaseStats.totalCount : '?';

      truncationHtml = `
    <div class="releases-truncated"
         data-displayed-all="${displayedAll}" data-matching-all="${matchingAll}"
         data-displayed-nopre="${displayedNoPre}" data-matching-nopre="${matchingNoPre}"
         data-displayed-latest="${displayedLatest}" data-matching-latest="${matchingLatest}"
         data-displayed-latestnopre="${displayedLatestNoPre}" data-matching-latestnopre="${matchingLatestNoPre}"
         data-site-listed="${siteListedCount}" data-site-existing="${siteExistingCount}"
         data-category-name="${escapeHtml(category.name)}">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span class="truncated-text">Displaying ${displayedAll} of ${matchingAll} matching releases</span>
      <span class="truncated-info-wrapper">
        <button class="truncated-info-btn" onclick="event.stopPropagation(); toggleTruncationInfo(this)" title="Show details">
          <svg class="octicon" viewBox="0 0 16 16" width="14" height="14">
            <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>
          </svg>
        </button>
        <div class="truncated-info-popup">
          <div class="popup-content"></div>
        </div>
      </span>
      <a href="${escapeHtml(seeMoreUrl)}" target="_blank" rel="noopener">See more on GitHub</a>
    </div>
      `;
    }

    categoryReleasesHtml[id] = releasesHtml ? releasesHtml + truncationHtml + noMatchesHtml : '';
    // Use pre-rendered description if available, otherwise render on the fly (local mode fallback)
    categoryDescriptionsHtml[id] = category._renderedDescription || (category.description ? sanitizeRenderedHtml(marked.parse(category.description)) : '');
  }

  // Add main page content
  if (hasMainPage) {
    categoryDescriptionsHtml['index'] = mainPageHtml;
  }

  // Add latest page content
  if (showLatestPage) {
    categoryReleasesHtml['latest-page'] = generateLatestPageHtml(latestReleases, latestAssets, config, defaultMaxDisplayed);
    categoryDescriptionsHtml['latest-page'] = latestPageConfig.description
      ? sanitizeRenderedHtml(marked.parse(latestPageConfig.description))
      : '';
  }

  const latestToggleHtml = showLatestToggle ? `
          <label class="filter-toggle">
            <input type="checkbox" id="showLatestOnly" onchange="toggleLatestOnly(this.checked)">
            <span>Show latest only</span>
          </label>
  ` : '';

  const prereleasesToggleHtml = `
          <label class="filter-toggle">
            <input type="checkbox" id="showPrereleases" checked onchange="togglePrereleases(this.checked)">
            <span>Show prereleases</span>
          </label>
  `;

  const assetsToggleHtml = `
          <label class="filter-toggle">
            <input type="checkbox" id="showAssets" checked onchange="toggleAssets(this.checked)">
            <span>Show assets</span>
          </label>
  `;

  const expandCollapseButtonsHtml = `
        <div class="expand-collapse-buttons">
          <button class="expand-collapse-btn" onclick="expandAllReleases()" title="Expand all">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path d="M8.177.677l2.896 2.896a.25.25 0 0 1-.177.427H8.75v3.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM5.104 12h2.146v-3.25a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12Z"></path>
            </svg>
            Expand
          </button>
          <button class="expand-collapse-btn" onclick="collapseAllReleases()" title="Collapse all">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path d="M7.823 4.677L5.177 7.323a.25.25 0 0 0 .177.427h2.146v1.5H5.354a.25.25 0 0 0-.177.427l2.646 2.646a.25.25 0 0 0 .354 0l2.646-2.646a.25.25 0 0 0-.177-.427H8.5v-1.5h2.146a.25.25 0 0 0 .177-.427L8.177 4.677a.25.25 0 0 0-.354 0Z"></path>
            </svg>
            Collapse
          </button>
        </div>
  `;

  // Generate repository link
  const repoUrl = CONFIG.repo ? `https://github.com/${CONFIG.repo}` : '#';
  const repoLinkHtml = `
    <a href="${repoUrl}" class="repo-link">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
      </svg>
      Go to repository
    </a>
  `;

  // Find the first category for initial selection (index if available, otherwise first category with releases)
  const firstCategoryId = hasMainPage ? 'index' : (Object.keys(allCategories).find(id => allCategories[id].releases.length > 0) || Object.keys(allCategories)[0]);

  // Favicon link
  const faviconHtml = CONFIG.faviconUrl
    ? `<link rel="icon" href="${escapeHtml(CONFIG.faviconUrl)}">`
    : '';

  // Release stats note for sidebar
  let releaseStatsHtml = '';
  if (CONFIG.releaseStats) {
    const stats = CONFIG.releaseStats;
    const listedDataAttrs = `data-listed-all="${uniqueDisplayedCounts.all}" data-listed-nopre="${uniqueDisplayedCounts.nopre}" data-listed-latest="${uniqueDisplayedCounts.latest}" data-listed-latestnopre="${uniqueDisplayedCounts.latestnopre}" data-existing="${stats.totalCount}"`;
    const allListed = uniqueDisplayedCounts.all === stats.totalCount;
    const listedText = allListed
      ? `${uniqueDisplayedCounts.all} releases listed`
      : `${uniqueDisplayedCounts.all} of ${stats.totalCount} releases listed`;
    const tooltipText = allListed
      ? `${stats.totalCount} releases exist in the repository, all are listed on this site`
      : `${stats.totalCount} releases exist in the repository, ${uniqueDisplayedCounts.all} listed on this site`;
    const lastUpdate = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

    releaseStatsHtml = `
    <div class="sidebar-footer" ${listedDataAttrs}>
      <span class="info-icon" title="${tooltipText}">ℹ️</span>
      <span class="listed-count">${listedText}</span>
      <span class="last-update">Last update: ${lastUpdate}</span>
      <span class="created-with">Created with <a href="https://github.com/Konamiman/github-categorized-releases">GitHub Categorized Releases</a></span>
    </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${faviconHtml}
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="loadingOverlay" class="loading-overlay">
    <div class="loading-spinner"></div>
  </div>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<p class="sidebar-description">${escapeHtml(description)}</p>` : ''}
        ${repoLinkHtml}
      </div>
      <nav class="sidebar-nav">
        <ul class="nav-tree">
          ${indexSidebarHtml}
          ${latestSidebarHtml}
          ${sidebarHtml}
          ${unmatchedSidebarHtml}
        </ul>
        <p class="no-categories">No matching categories</p>
      </nav>
      ${releaseStatsHtml}
    </aside>
    <main class="main-content">
      <div class="content-header">
        <div class="content-header-top">
          <h2 class="category-title" id="categoryTitle">Releases</h2>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${expandCollapseButtonsHtml}
            <button class="theme-toggle" id="themeToggle" title="Toggle dark/light mode">
              <span class="icon-sun">☀</span>
              <span class="icon-moon" style="display: none;">☾</span>
            </button>
          </div>
        </div>
        <div class="content-controls">
          <div class="filter-group">
            <span class="filter-group-label">Filter:</span>
            ${prereleasesToggleHtml}
            ${latestToggleHtml}
          </div>
          <div class="filter-group">
            <span class="filter-group-label">Display:</span>
            ${assetsToggleHtml}
          </div>
        </div>
      </div>
      <div class="category-description" id="categoryDescription">
        <!-- Description will be inserted here by JavaScript -->
      </div>
      <div class="releases-list" id="releasesList">
        <!-- Releases will be inserted here by JavaScript -->
      </div>
    </main>
  </div>
  <script>
    const categoryData = ${JSON.stringify(allCategories)};
    const categoryReleasesHtml = ${JSON.stringify(categoryReleasesHtml)};
    const categoryDescriptionsHtml = ${JSON.stringify(categoryDescriptionsHtml)};
  </script>
  <script src="script.js"></script>
  <script>
    // Apply URL params and select initial category
    applyUrlParams();
    const initialHash = window.location.hash.slice(1);
    // No hash or invalid hash -> use default (index if exists, otherwise first category)
    selectCategory(initialHash && categoryData[initialHash] ? initialHash : '${firstCategoryId}');
    updateSidebarCounts();
  </script>
</body>
</html>`;
}

// ============================================================================
// Multi-page mode generation
// ============================================================================

// Stores pre-processed data for multi-page generation (shared between root and category index files)
let multiPageData = null;

async function prepareMultiPageData(tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases = [], latestAssets = []) {
  const siteConfig = config.site || {};
  const title = siteConfig.title || 'Releases';
  const description = siteConfig.description || '';
  const showLatestToggle = siteConfig['show-latest-only-toggle'] !== false;
  const mainPageConfig = siteConfig['main-page'] || {};
  const unmatchedConfig = config.unmatched || {};
  const showUnmatched = unmatchedConfig.show !== false;
  const unmatchedName = unmatchedConfig.name || 'Other';
  const latestPageConfig = config['latest-page'] || {};
  const showLatestPage = latestPageConfig.enable === true;
  const latestPageTitle = latestPageConfig.title || 'Latest';

  // Pre-render all markdown content
  const preRendered = await preRenderAllMarkdown(
    tree,
    unmatchedReleases,
    mainPageConfig.render ? CONFIG.mainMdContent : null
  );

  // Render main page if enabled and content is available
  let mainPageHtml = '';
  let hasMainPage = false;
  if (mainPageConfig.render && CONFIG.mainMdContent) {
    mainPageHtml = preRendered.mainPageHtml || '';
    hasMainPage = true;
  }

  // Assign IDs to all categories
  assignCategoryIds(tree);

  // Add unmatched as a category if needed
  let unmatchedCategory = null;
  if (showUnmatched && unmatchedReleases.length > 0) {
    unmatchedCategory = {
      id: 'category-unmatched',
      name: unmatchedName,
      releases: unmatchedReleases,
      categories: [],
      maxDisplayed: unmatchedMaxDisplayed !== undefined ? unmatchedMaxDisplayed : defaultMaxDisplayed
    };
  }

  // Generate Index entry for main page
  const indexSidebarHtml = hasMainPage ? `
    <li class="nav-item" data-category-id="index">
      <div class="nav-link" onclick="selectCategory('index')">
        <span class="nav-icon">
          <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
            <path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"></path>
          </svg>
        </span>
        <span class="nav-name">Index</span>
      </div>
    </li>
  ` : '';

  // Generate Latest page sidebar entry
  const latestSidebarHtml = showLatestPage ? `
    <li class="nav-item" data-category-id="latest-page">
      <div class="nav-link" onclick="selectCategory('latest-page')" title="${latestReleases.length} releases / ${latestAssets.length} assets">
        <span class="nav-icon">
          <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
            <path fill="currentColor" d="M8 1a7 7 0 0 1 7 7h-1.5A5.5 5.5 0 0 0 8 2.5V1Zm7 7a7 7 0 0 1-7 7v-1.5A5.5 5.5 0 0 0 13.5 8H15ZM8 15a7 7 0 0 1-7-7h1.5A5.5 5.5 0 0 0 8 13.5V15Z"/>
            <path fill="currentColor" d="M8 4a.75.75 0 0 1 .75.75v2.69l1.78 1.78a.75.75 0 1 1-1.06 1.06l-2-2a.75.75 0 0 1-.22-.53V4.75A.75.75 0 0 1 8 4Z"/>
            <path fill="currentColor" d="M2.5 3.5 5.5 8H-.5Z"/>
          </svg>
        </span>
        <span class="nav-name">${escapeHtml(latestPageTitle)}</span>
        <span class="nav-count">${latestReleases.length}/${latestAssets.length}</span>
      </div>
    </li>
  ` : '';

  // Generate sidebar HTML
  const sidebarHtml = tree.map(c => generateSidebarCategoryHtml(c, config)).join('');
  const unmatchedSidebarHtml = unmatchedCategory
    ? generateSidebarCategoryHtml(unmatchedCategory, config)
    : '';

  // Collect all categories for JSON data
  const allCategories = collectAllCategories(tree);
  if (unmatchedCategory) {
    allCategories[unmatchedCategory.id] = {
      name: unmatchedCategory.name,
      description: '',
      releases: unmatchedCategory.releases,
      children: [],
      maxDisplayed: unmatchedCategory.maxDisplayed,
      hasPages: unmatchedCategory.releases.length > 0
    };
  }

  // Add latest page entry if enabled
  if (showLatestPage) {
    allCategories['latest-page'] = {
      name: latestPageTitle,
      description: latestPageConfig.description || '',
      releases: latestReleases,
      assets: latestAssets,
      children: [],
      isLatestPage: true,
      hasPages: latestReleases.length > 0
    };
  }

  // Add index entry if main page exists
  if (hasMainPage) {
    allCategories['index'] = {
      name: 'Index',
      description: '',
      releases: [],
      children: [],
      isIndex: true
    };
  }

  // Mark categories that have pages (releases)
  for (const [id, category] of Object.entries(allCategories)) {
    if (!category.isIndex) {
      category.hasPages = category.releases.length > 0;
    }
  }

  // Calculate unique displayed releases for sidebar footer
  function calculateUniqueDisplayedCounts() {
    const uniqueAll = new Set();
    const uniqueNoPre = new Set();
    const uniqueLatest = new Set();
    const uniqueLatestNoPre = new Set();

    for (const [id, category] of Object.entries(allCategories)) {
      if (id === 'index') continue;
      const maxDisplayed = category.maxDisplayed;
      const shouldLimit = maxDisplayed !== null && maxDisplayed !== undefined && maxDisplayed !== false && category.releases.length > maxDisplayed;
      const displayedReleases = shouldLimit ? category.releases.slice(0, maxDisplayed) : category.releases;

      for (const r of displayedReleases) {
        uniqueAll.add(r.id);
        if (!r.prerelease) uniqueNoPre.add(r.id);
        if (r.isLatest) uniqueLatest.add(r.id);
        if (r.isLatest && !r.prerelease) uniqueLatestNoPre.add(r.id);
      }
    }

    return {
      all: uniqueAll.size,
      nopre: uniqueNoPre.size,
      latest: uniqueLatest.size,
      latestnopre: uniqueLatestNoPre.size
    };
  }
  const uniqueDisplayedCounts = calculateUniqueDisplayedCounts();

  // For multi-page, we only store descriptions (not release HTML)
  const categoryDescriptionsHtml = {};
  for (const [id, category] of Object.entries(allCategories)) {
    categoryDescriptionsHtml[id] = category._renderedDescription || (category.description ? sanitizeRenderedHtml(marked.parse(category.description)) : '');
  }
  if (hasMainPage) {
    categoryDescriptionsHtml['index'] = mainPageHtml;
  }

  // Simplified category data for multi-page (no releases array)
  const simplifiedCategories = {};
  for (const [id, cat] of Object.entries(allCategories)) {
    simplifiedCategories[id] = {
      name: cat.name,
      children: cat.children,
      isIndex: cat.isIndex || false,
      isLatestPage: cat.isLatestPage || false,
      hasPages: cat.hasPages || false
    };
  }

  // Find the first category for initial selection (index if available, otherwise first category with releases)
  const defaultCategoryId = hasMainPage ? 'index' : (Object.keys(allCategories).find(id => allCategories[id].releases.length > 0) || Object.keys(allCategories)[0]);

  // Store and return the processed data
  multiPageData = {
    title,
    description,
    showLatestToggle,
    hasMainPage,
    indexSidebarHtml,
    latestSidebarHtml,
    sidebarHtml,
    unmatchedSidebarHtml,
    allCategories,
    simplifiedCategories,
    categoryDescriptionsHtml,
    uniqueDisplayedCounts,
    defaultCategoryId
  };

  return multiPageData;
}

function generateMultiPageHtml(data, initialCategoryId = null, assetPathPrefix = '') {
  const {
    title,
    description,
    showLatestToggle,
    indexSidebarHtml,
    latestSidebarHtml,
    sidebarHtml,
    unmatchedSidebarHtml,
    simplifiedCategories,
    categoryDescriptionsHtml,
    uniqueDisplayedCounts
  } = data;

  const categoryId = initialCategoryId || data.defaultCategoryId;

  const latestToggleHtml = showLatestToggle ? `
          <label class="filter-toggle">
            <input type="checkbox" id="showLatestOnly" onchange="toggleLatestOnly(this.checked)">
            <span>Show latest only</span>
          </label>
  ` : '';

  const prereleasesToggleHtml = `
          <label class="filter-toggle">
            <input type="checkbox" id="showPrereleases" checked onchange="togglePrereleases(this.checked)">
            <span>Show prereleases</span>
          </label>
  `;

  const assetsToggleHtml = `
          <label class="filter-toggle">
            <input type="checkbox" id="showAssets" checked onchange="toggleAssets(this.checked)">
            <span>Show assets</span>
          </label>
  `;

  const expandCollapseButtonsHtml = `
        <div class="expand-collapse-buttons">
          <button class="expand-collapse-btn" onclick="expandAllReleases()" title="Expand all">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path d="M8.177.677l2.896 2.896a.25.25 0 0 1-.177.427H8.75v3.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM5.104 12h2.146v-3.25a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12Z"></path>
            </svg>
            Expand
          </button>
          <button class="expand-collapse-btn" onclick="collapseAllReleases()" title="Collapse all">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path d="M7.823 4.677L5.177 7.323a.25.25 0 0 0 .177.427h2.146v1.5H5.354a.25.25 0 0 0-.177.427l2.646 2.646a.25.25 0 0 0 .354 0l2.646-2.646a.25.25 0 0 0-.177-.427H8.5v-1.5h2.146a.25.25 0 0 0 .177-.427L8.177 4.677a.25.25 0 0 0-.354 0Z"></path>
            </svg>
            Collapse
          </button>
        </div>
  `;

  // Repository link
  const repoUrl = CONFIG.repo ? `https://github.com/${CONFIG.repo}` : '#';
  const repoLinkHtml = `
    <a href="${repoUrl}" class="repo-link">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
      </svg>
      Go to repository
    </a>
  `;

  // Favicon link
  const faviconHtml = CONFIG.faviconUrl
    ? `<link rel="icon" href="${assetPathPrefix}${escapeHtml(CONFIG.faviconUrl)}">`
    : '';

  // Release stats for sidebar
  let releaseStatsHtml = '';
  if (CONFIG.releaseStats) {
    const stats = CONFIG.releaseStats;
    const listedDataAttrs = `data-listed-all="${uniqueDisplayedCounts.all}" data-listed-nopre="${uniqueDisplayedCounts.nopre}" data-listed-latest="${uniqueDisplayedCounts.latest}" data-listed-latestnopre="${uniqueDisplayedCounts.latestnopre}" data-existing="${stats.totalCount}"`;
    const allListed = uniqueDisplayedCounts.all === stats.totalCount;
    const listedText = allListed
      ? `${uniqueDisplayedCounts.all} releases listed`
      : `${uniqueDisplayedCounts.all} of ${stats.totalCount} releases listed`;
    const tooltipText = allListed
      ? `${stats.totalCount} releases exist in the repository, all are listed on this site`
      : `${stats.totalCount} releases exist in the repository, ${uniqueDisplayedCounts.all} listed on this site`;
    const lastUpdate = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

    releaseStatsHtml = `
    <div class="sidebar-footer" ${listedDataAttrs}>
      <span class="info-icon" title="${tooltipText}">ℹ️</span>
      <span class="listed-count">${listedText}</span>
      <span class="last-update">Last update: ${lastUpdate}</span>
      <span class="created-with">Created with <a href="https://github.com/Konamiman/github-categorized-releases">GitHub Categorized Releases</a></span>
    </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${faviconHtml}
  <link rel="stylesheet" href="${assetPathPrefix}style.css">
</head>
<body>
  <div id="loadingOverlay" class="loading-overlay">
    <div class="loading-spinner"></div>
  </div>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<p class="sidebar-description">${escapeHtml(description)}</p>` : ''}
        ${repoLinkHtml}
      </div>
      <nav class="sidebar-nav">
        <ul class="nav-tree">
          ${indexSidebarHtml}
          ${latestSidebarHtml}
          ${sidebarHtml}
          ${unmatchedSidebarHtml}
        </ul>
        <p class="no-categories">No matching categories</p>
      </nav>
      ${releaseStatsHtml}
    </aside>
    <main class="main-content">
      <div class="content-header">
        <div class="content-header-top">
          <h2 class="category-title" id="categoryTitle">Releases</h2>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${expandCollapseButtonsHtml}
            <button class="theme-toggle" id="themeToggle" title="Toggle dark/light mode">
              <span class="icon-sun">☀</span>
              <span class="icon-moon" style="display: none;">☾</span>
            </button>
          </div>
        </div>
        <div class="content-controls">
          <div class="filter-group">
            <span class="filter-group-label">Filter:</span>
            ${prereleasesToggleHtml}
            ${latestToggleHtml}
          </div>
          <div class="filter-group">
            <span class="filter-group-label">Display:</span>
            ${assetsToggleHtml}
          </div>
        </div>
      </div>
      <div class="category-description" id="categoryDescription">
        <!-- Description will be inserted here by JavaScript -->
      </div>
      <div class="releases-list" id="releasesList">
        <!-- Releases will be loaded dynamically -->
      </div>
    </main>
  </div>
  <script>
    const categoryData = ${JSON.stringify(simplifiedCategories)};
    const categoryDescriptionsHtml = ${JSON.stringify(categoryDescriptionsHtml)};
  </script>
  <script src="${assetPathPrefix}script.js"></script>
  <script>
    // Apply URL params and select initial category
    applyUrlParams();
    selectCategory('${categoryId}', currentPage || 1);
    updateSidebarCounts();
  </script>
</body>
</html>`;
}

async function generateMultiPageIndex(tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases = [], latestAssets = []) {
  const data = await prepareMultiPageData(tree, unmatchedReleases, config, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases, latestAssets);
  return generateMultiPageHtml(data);
}

async function generateCategoryPages(outputDir, tree, unmatchedReleases, config, pageSize, defaultMaxDisplayed, unmatchedMaxDisplayed, latestReleases = [], latestAssets = []) {
  const fs = require('fs');
  const path = require('path');

  // Collect all categories with their releases
  const allCategories = collectAllCategories(tree);

  // Add unmatched if applicable
  const unmatchedConfig = config.unmatched || {};
  const showUnmatched = unmatchedConfig.show !== false;
  if (showUnmatched && unmatchedReleases.length > 0) {
    allCategories['category-unmatched'] = {
      name: unmatchedConfig.name || 'Other',
      description: '',
      releases: unmatchedReleases,
      children: [],
      maxDisplayed: unmatchedMaxDisplayed !== undefined ? unmatchedMaxDisplayed : defaultMaxDisplayed
    };
  }

  // Add latest page if enabled
  const latestPageConfig = config['latest-page'] || {};
  const showLatestPage = latestPageConfig.enable === true;
  if (showLatestPage) {
    // Resolve max-displayed for releases: explicit value > default (null resets to default, false disables)
    const configMaxDisplayed = latestPageConfig['max-displayed'];
    const releasesMaxDisplayed = configMaxDisplayed === null
      ? defaultMaxDisplayed
      : (configMaxDisplayed !== undefined ? configMaxDisplayed : defaultMaxDisplayed);

    // Resolve max-displayed for assets: explicit value > releases max-displayed > default
    const configAssetsMaxDisplayed = latestPageConfig['assets-max-displayed'];
    const assetsMaxDisplayed = configAssetsMaxDisplayed === null
      ? (releasesMaxDisplayed !== false ? releasesMaxDisplayed : defaultMaxDisplayed)
      : (configAssetsMaxDisplayed !== undefined ? configAssetsMaxDisplayed : releasesMaxDisplayed);

    // Resolve page-size for releases: explicit value > global pageSize (null resets to global, false disables)
    const configPageSize = latestPageConfig['page-size'];
    const releasesPageSize = configPageSize === null
      ? pageSize
      : (configPageSize !== undefined ? configPageSize : pageSize);

    // Resolve page-size for assets: explicit value > releases page-size > global pageSize
    const configAssetsPageSize = latestPageConfig['assets-page-size'];
    const assetsPageSize = configAssetsPageSize === null
      ? (releasesPageSize !== false ? releasesPageSize : pageSize)
      : (configAssetsPageSize !== undefined ? configAssetsPageSize : releasesPageSize);

    allCategories['latest-page'] = {
      name: latestPageConfig.title || 'Latest',
      description: latestPageConfig.description || '',
      releases: latestReleases,
      assets: latestAssets,
      children: [],
      isLatestPage: true,
      maxDisplayed: releasesMaxDisplayed,
      assetsMaxDisplayed: assetsMaxDisplayed,
      pageSize: releasesPageSize,
      assetsPageSize: assetsPageSize
    };
  }

  // Generate pages for each category
  for (const [categoryId, category] of Object.entries(allCategories)) {
    // Create category directory
    const categoryDir = path.join(outputDir, categoryId);
    fs.mkdirSync(categoryDir, { recursive: true });

    // Generate index.html for direct URL access (for ALL categories, including containers)
    // Calculate relative path to root based on category depth
    const depth = categoryId.split('/').length;
    const pathPrefix = '../'.repeat(depth);
    const categoryIndexHtml = generateMultiPageHtml(multiPageData, categoryId, pathPrefix);
    fs.writeFileSync(path.join(categoryDir, 'index.html'), categoryIndexHtml);

    // Handle container categories (no releases, only subcategories)
    if (category.releases.length === 0) {
      if (category.children && category.children.length > 0) {
        // Generate meta.json
        fs.writeFileSync(path.join(categoryDir, 'meta.json'), JSON.stringify({ pageCount: 1 }));

        // Generate pre-rendered subcategory list
        const linksHtml = category.children.map(child =>
          `<li><a href="/${child.id}" onclick="event.preventDefault(); selectCategory('${child.id}')">${escapeHtml(child.name)}</a></li>`
        ).join('');
        const subcategoriesHtml = `
<div class="subcategories">
  <h3>Browse subcategories</h3>
  <ul>${linksHtml}</ul>
</div>`;
        fs.writeFileSync(path.join(categoryDir, 'page-1.html'), subcategoriesHtml);
        console.log(`  Generated index for container category ${categoryId}`);
      }
      continue;
    }

    // Handle latest page specially
    if (category.isLatestPage) {
      // Apply max-displayed truncation to releases
      const releasesMaxDisplayed = category.maxDisplayed;
      const shouldLimitReleases = releasesMaxDisplayed !== false && releasesMaxDisplayed !== null &&
        releasesMaxDisplayed !== undefined && category.releases.length > releasesMaxDisplayed;
      const displayedReleases = shouldLimitReleases ? category.releases.slice(0, releasesMaxDisplayed) : category.releases;

      // Apply max-displayed truncation to assets
      const assetsMaxDisplayed = category.assetsMaxDisplayed;
      const shouldLimitAssets = assetsMaxDisplayed !== false && assetsMaxDisplayed !== null &&
        assetsMaxDisplayed !== undefined && category.assets.length > assetsMaxDisplayed;
      const displayedAssets = shouldLimitAssets ? category.assets.slice(0, assetsMaxDisplayed) : category.assets;

      // Get page sizes (false means all on one page)
      const releasesPageSize = category.pageSize;
      const assetsPageSize = category.assetsPageSize;
      const effectiveReleasesPageSize = releasesPageSize === false ? displayedReleases.length : (releasesPageSize || displayedReleases.length);
      const effectiveAssetsPageSize = assetsPageSize === false ? displayedAssets.length : (assetsPageSize || displayedAssets.length);

      const pageCount = displayedReleases.length > 0 ? Math.ceil(displayedReleases.length / effectiveReleasesPageSize) : 1;
      const assetsPageCount = displayedAssets.length > 0 ? Math.ceil(displayedAssets.length / effectiveAssetsPageSize) : 1;

      // Generate meta.json with assets data for client-side rendering
      const meta = {
        pageCount,
        releaseCount: displayedReleases.length,
        totalReleaseCount: category.releases.length,
        assetsCount: displayedAssets.length,
        totalAssetsCount: category.assets.length,
        assetsPageCount,
        // When assetsPageCount > 1, assets are served as JSON files in assets/{sort-order}/{page}.json
        // When assetsPageCount === 1, assets are served as pre-rendered HTML in assets.html
        assetsPaginated: assetsPageCount > 1
      };
      fs.writeFileSync(path.join(categoryDir, 'meta.json'), JSON.stringify(meta));

      // In multi-page mode, display mode toggle is generated dynamically by doSelectCategory
      // Page files only contain the release cards and pagination placeholders

      const noMatchesHtml = `
    <div class="no-matches">
      <svg viewBox="0 0 24 24" width="48" height="48">
        <path fill="currentColor" d="M10.5 18.25a.75.75 0 0 1 0-1.5h7a.75.75 0 0 1 0 1.5h-7Zm-4-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Zm0-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Z"/>
      </svg>
      <p>No releases match the current filters</p>
    </div>
      `;

      // Generate truncation banner for releases if needed
      let releasesTruncationHtml = '';
      if (shouldLimitReleases) {
        releasesTruncationHtml = `
    <div class="releases-truncated">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span>Displaying ${displayedReleases.length} of ${category.releases.length} latest releases</span>
    </div>
        `;
      }

      // Generate page files for releases view
      if (displayedReleases.length === 0) {
        // Empty state page - just the empty message, display mode toggle added by JS
        const emptyHtml = `<p class="latest-empty"><em>There are no releases marked as latest</em></p>`;
        fs.writeFileSync(path.join(categoryDir, 'page-1.html'), emptyHtml);
      } else {
        for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
          const startIdx = (pageNum - 1) * effectiveReleasesPageSize;
          const endIdx = Math.min(startIdx + effectiveReleasesPageSize, displayedReleases.length);
          const pageReleases = displayedReleases.slice(startIdx, endIdx);

          const releasesHtml = pageReleases.map(r => generateReleaseHtml(r)).join('');

          const paginationTopPlaceholder = '<div id="pagination-top-placeholder"></div>';
          const paginationBottomPlaceholder = '<div id="pagination-bottom-placeholder"></div>';

          // Include truncation banner on last page
          const isLastPage = pageNum === pageCount;
          const pageContent = `${paginationTopPlaceholder}${releasesHtml}${noMatchesHtml}${paginationBottomPlaceholder}${isLastPage ? releasesTruncationHtml : ''}`;

          fs.writeFileSync(path.join(categoryDir, `page-${pageNum}.html`), pageContent);
        }
      }

      // Generate assets files
      if (assetsPageCount === 1) {
        // Single page - generate as pre-rendered HTML (assets.html)
        let assetsTruncationHtml = '';
        if (shouldLimitAssets) {
          assetsTruncationHtml = `
    <div class="releases-truncated">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span>Displaying ${displayedAssets.length} of ${category.assets.length} assets</span>
    </div>
          `;
        }
        fs.writeFileSync(path.join(categoryDir, 'assets.html'), generateAssetsTableHtml(displayedAssets) + assetsTruncationHtml);
        console.log(`  Generated ${pageCount} page(s) for latest-page releases, 1 page for assets (HTML)`);
      } else {
        // Multiple pages - generate JSON files in assets/{sort-order}/{page}.json
        const assetsDir = path.join(categoryDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });

        // Sort orders to generate
        const sortOrders = [
          { key: 'date-desc', sort: (a, b) => new Date(b.releaseDate) - new Date(a.releaseDate) },
          { key: 'date-asc', sort: (a, b) => new Date(a.releaseDate) - new Date(b.releaseDate) },
          { key: 'name-asc', sort: (a, b) => a.name.localeCompare(b.name) },
          { key: 'name-desc', sort: (a, b) => b.name.localeCompare(a.name) }
        ];

        // Convert assets to JSON-serializable format
        const assetsData = displayedAssets.map(a => ({
          name: a.name,
          url: a.url,
          size: a.size,
          releaseDate: a.releaseDate,
          releaseUrl: a.releaseUrl,
          releaseTitle: a.releaseTitle
        }));

        for (const { key, sort } of sortOrders) {
          const sortDir = path.join(assetsDir, key);
          fs.mkdirSync(sortDir, { recursive: true });

          // Sort assets for this order
          const sortedAssets = [...assetsData].sort(sort);

          // Generate paginated JSON files
          for (let pageNum = 1; pageNum <= assetsPageCount; pageNum++) {
            const startIdx = (pageNum - 1) * effectiveAssetsPageSize;
            const endIdx = Math.min(startIdx + effectiveAssetsPageSize, sortedAssets.length);
            const pageAssets = sortedAssets.slice(startIdx, endIdx);

            fs.writeFileSync(
              path.join(sortDir, `${pageNum}.json`),
              JSON.stringify(pageAssets)
            );
          }
        }

        console.log(`  Generated ${pageCount} page(s) for latest-page releases, ${assetsPageCount} page(s) × 4 sort orders for assets (JSON)`);
      }
      continue;
    }

    // Apply maxDisplayed truncation
    const maxDisplayed = category.maxDisplayed;
    const shouldLimit = maxDisplayed !== null && maxDisplayed !== undefined && maxDisplayed !== false && category.releases.length > maxDisplayed;
    const displayedReleases = shouldLimit ? category.releases.slice(0, maxDisplayed) : category.releases;

    // Calculate page count
    const effectivePageSize = pageSize || displayedReleases.length;
    const pageCount = Math.ceil(displayedReleases.length / effectivePageSize);

    // Generate truncation banner HTML if there are hidden releases
    let truncationHtml = '';
    if (shouldLimit) {
      const hasAllReleases = CONFIG.releaseStats ? CONFIG.releaseStats.hasAllReleases : true;
      if (hasAllReleases) {
        const firstHiddenRelease = category.releases[maxDisplayed];
        const seeMoreUrl = firstHiddenRelease ? firstHiddenRelease.url : (CONFIG.repo ? `https://github.com/${CONFIG.repo}/releases` : '#');
        truncationHtml = `
    <div class="releases-truncated">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span>Displaying ${displayedReleases.length} of ${category.releases.length} matching releases</span>
      <a href="${escapeHtml(seeMoreUrl)}" target="_blank" rel="noopener">See more on GitHub</a>
    </div>
        `;
      }
    }

    // Generate meta.json
    const meta = { pageCount };
    fs.writeFileSync(path.join(categoryDir, 'meta.json'), JSON.stringify(meta));

    // Generate page files
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const startIdx = (pageNum - 1) * effectivePageSize;
      const endIdx = Math.min(startIdx + effectivePageSize, displayedReleases.length);
      const pageReleases = displayedReleases.slice(startIdx, endIdx);

      // Generate release cards HTML
      const releasesHtml = pageReleases.map(r => generateReleaseHtml(r)).join('');

      // Pagination placeholders - JavaScript will inject the actual pagination bars
      const paginationTopPlaceholder = '<div id="pagination-top-placeholder"></div>';
      const paginationBottomPlaceholder = '<div id="pagination-bottom-placeholder"></div>';

      // Add no-matches placeholder
      const noMatchesHtml = `
    <div class="no-matches">
      <svg viewBox="0 0 24 24" width="48" height="48">
        <path fill="currentColor" d="M10.5 18.25a.75.75 0 0 1 0-1.5h7a.75.75 0 0 1 0 1.5h-7Zm-4-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Zm0-5.5a.75.75 0 0 1 0-1.5h11a.75.75 0 0 1 0 1.5h-11Z"/>
      </svg>
      <p>No releases match the current filters</p>
    </div>
      `;

      // Build page content (include truncation banner on last page)
      const isLastPage = pageNum === pageCount;
      const pageContent = paginationTopPlaceholder + releasesHtml + noMatchesHtml + paginationBottomPlaceholder + (isLastPage ? truncationHtml : '');

      fs.writeFileSync(path.join(categoryDir, `page-${pageNum}.html`), pageContent);
    }

    console.log(`  Generated ${pageCount} page(s) for ${categoryId}`);
  }
}

function getDefaultCssPath() {
  // Get the directory where this script is located
  const scriptDir = path.dirname(require.main.filename);
  return path.join(scriptDir, 'assets', 'style.css');
}

async function loadCss(config) {
  const configDir = path.dirname(CONFIG.configPath);

  // Load default CSS (required)
  const defaultCssPath = getDefaultCssPath();
  if (!fs.existsSync(defaultCssPath)) {
    throw new Error(`Default style.css not found at ${defaultCssPath}`);
  }
  const defaultCss = fs.readFileSync(defaultCssPath, 'utf8');
  console.log('Loaded default styles from ' + defaultCssPath);

  // Load custom CSS if specified
  let customCss = '';
  const customStylePath = config.site && config.site.style;
  if (customStylePath) {
    try {
      if (isUrl(customStylePath)) {
        // Remote CSS - fetch it
        console.log('Fetching custom styles from ' + customStylePath + '...');
        customCss = await fetchUrl(customStylePath);
      } else {
        // Local CSS - resolve relative to config file
        let fullPath;
        if (isUrl(CONFIG.configPath)) {
          // Config is remote, treat style as relative URL
          const remoteUrl = configDir + '/' + customStylePath;
          console.log('Fetching custom styles from ' + remoteUrl + '...');
          customCss = await fetchUrl(remoteUrl);
        } else {
          // Config is local
          fullPath = path.isAbsolute(customStylePath) ? customStylePath : path.join(configDir, customStylePath);
          if (fs.existsSync(fullPath)) {
            console.log('Loading custom styles from ' + fullPath + '...');
            customCss = fs.readFileSync(fullPath, 'utf8');
          } else {
            console.warn('Custom style file not found: ' + fullPath);
          }
        }
      }
    } catch (err) {
      console.warn('Could not load custom styles:', err.message);
    }
  }

  // Combine: default first, then custom (custom overrides)
  if (customCss) {
    return defaultCss + '\n\n/* Custom styles */\n' + customCss;
  }
  return defaultCss;
}

function loadJs(multiPageMode = false) {
  const scriptDir = path.dirname(require.main.filename);
  const assetsDir = path.join(scriptDir, 'assets');

  // Load common script
  const commonPath = path.join(assetsDir, 'script-common.js');
  if (!fs.existsSync(commonPath)) {
    throw new Error(`script-common.js not found at ${commonPath}`);
  }
  const commonJs = fs.readFileSync(commonPath, 'utf8');

  // Load mode-specific script
  const modePath = path.join(assetsDir, multiPageMode ? 'script-multi-page.js' : 'script-single-page.js');
  if (!fs.existsSync(modePath)) {
    throw new Error(`Mode-specific script not found at ${modePath}`);
  }
  const modeJs = fs.readFileSync(modePath, 'utf8');

  return commonJs + '\n\n' + modeJs;
}

module.exports = {
  escapeHtml,
  formatDate,
  formatBytes,
  slugify,
  generateReleaseHtml,
  generateSidebarCategoryHtml,
  generateFullHtml,
  generateMultiPageIndex,
  generateCategoryPages,
  loadCss,
  loadJs,
  assignCategoryIds,
  collectAllCategories
};
