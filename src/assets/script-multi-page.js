// ============================================================================
// Multi-page mode specific functionality
// Requires: script-common.js to be loaded first
// ============================================================================

// Cache for fetched content
const pageCache = new Map();
const metaCache = new Map();
const assetsCache = new Map();

let currentPage = 1;
let currentAssetsPage = 1;

function updateUrlParams() {
  const params = new URLSearchParams();

  const latestOnly = document.getElementById('showLatestOnly');
  const prereleases = document.getElementById('showPrereleases');
  const assets = document.getElementById('showAssets');

  if (latestOnly && latestOnly.checked) params.set('latest', '1');
  if (prereleases && !prereleases.checked) params.set('prereleases', '0');
  if (assets && !assets.checked) params.set('assets', '0');
  if (currentPage > 1) params.set('page', currentPage.toString());

  // Include display mode for latest-page
  if (currentCategoryId === 'latest-page' && typeof currentLatestDisplayMode !== 'undefined' && currentLatestDisplayMode !== 'releases') {
    params.set('mode', currentLatestDisplayMode);
    if (currentAssetsPage > 1) params.set('apage', currentAssetsPage.toString());
  }

  const queryString = params.toString();
  const newUrl = '/' + currentCategoryId + (queryString ? '?' + queryString : '');
  history.replaceState({ categoryId: currentCategoryId, page: currentPage }, '', newUrl);
}

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);

  const latestOnly = document.getElementById('showLatestOnly');
  const prereleases = document.getElementById('showPrereleases');
  const assets = document.getElementById('showAssets');

  if (params.has('latest')) {
    const val = params.get('latest') === '1';
    if (latestOnly) {
      latestOnly.checked = val;
      document.body.classList.toggle('latest-only', val);
    }
  }

  if (params.has('prereleases')) {
    const val = params.get('prereleases') !== '0';
    if (prereleases) {
      prereleases.checked = val;
      document.body.classList.toggle('hide-prereleases', !val);
    }
  }

  if (params.has('assets')) {
    const val = params.get('assets') !== '0';
    if (assets) {
      assets.checked = val;
      document.body.classList.toggle('hide-assets', !val);
    }
  }

  if (params.has('page')) {
    currentPage = parseInt(params.get('page'), 10) || 1;
  }

  // Restore display mode for latest-page
  if (params.has('mode') && typeof setLatestDisplayMode === 'function') {
    const mode = params.get('mode');
    if (['releases', 'assets-date-desc', 'assets-date-asc', 'assets-name-asc', 'assets-name-desc'].includes(mode)) {
      // Will be applied after category loads
      window.pendingLatestDisplayMode = mode;
    }
  }

  // Restore assets page
  if (params.has('apage')) {
    window.pendingAssetsPage = parseInt(params.get('apage'), 10) || 1;
  }
}

function getCategoryPath(categoryId) {
  // Convert category ID to path (e.g., "packages/muimaterial" -> "packages/muimaterial")
  return categoryId;
}

async function fetchMeta(categoryId) {
  if (metaCache.has(categoryId)) {
    return metaCache.get(categoryId);
  }

  const path = getCategoryPath(categoryId);
  const response = await fetch(`/${path}/meta.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata for ${categoryId}`);
  }

  const meta = await response.json();
  metaCache.set(categoryId, meta);
  return meta;
}

async function fetchPage(categoryId, pageNum) {
  const cacheKey = `${categoryId}:${pageNum}`;
  if (pageCache.has(cacheKey)) {
    return pageCache.get(cacheKey);
  }

  const path = getCategoryPath(categoryId);
  const response = await fetch(`/${path}/page-${pageNum}.html`);
  if (!response.ok) {
    throw new Error(`Failed to fetch page ${pageNum} for ${categoryId}`);
  }

  const html = await response.text();
  pageCache.set(cacheKey, html);
  return html;
}

// Fetch pre-rendered HTML assets (single page mode)
async function fetchAssetsHtml(categoryId) {
  const cacheKey = `${categoryId}:assets:html`;
  if (assetsCache.has(cacheKey)) {
    return assetsCache.get(cacheKey);
  }

  const path = getCategoryPath(categoryId);
  const response = await fetch(`/${path}/assets.html`);
  if (!response.ok) {
    throw new Error(`Failed to fetch assets for ${categoryId}`);
  }

  const html = await response.text();
  assetsCache.set(cacheKey, html);
  return html;
}

// Fetch JSON assets page (paginated mode)
async function fetchAssetsJson(categoryId, sortOrder, pageNum) {
  const cacheKey = `${categoryId}:assets:${sortOrder}:${pageNum}`;
  if (assetsCache.has(cacheKey)) {
    return assetsCache.get(cacheKey);
  }

  const path = getCategoryPath(categoryId);
  const response = await fetch(`/${path}/assets/${sortOrder}/${pageNum}.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch assets page ${pageNum} (${sortOrder}) for ${categoryId}`);
  }

  const data = await response.json();
  assetsCache.set(cacheKey, data);
  return data;
}

// Map display mode to sort order directory name
function getSortOrderFromMode(mode) {
  const modeToSortOrder = {
    'assets-date-desc': 'date-desc',
    'assets-date-asc': 'date-asc',
    'assets-name-asc': 'name-asc',
    'assets-name-desc': 'name-desc'
  };
  return modeToSortOrder[mode] || 'date-desc';
}

// Render assets from JSON data
function renderAssetsTableFromJson(assets, meta) {
  if (assets.length === 0) {
    return '<p class="latest-empty"><em>No downloadable assets found</em></p>';
  }

  const packageIcon = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
    <path d="m8.878.392 5.25 3.045c.54.314.872.89.872 1.514v6.098a1.75 1.75 0 0 1-.872 1.514l-5.25 3.045a1.75 1.75 0 0 1-1.756 0l-5.25-3.045A1.75 1.75 0 0 1 1 11.049V4.951c0-.624.332-1.201.872-1.514L7.122.392a1.75 1.75 0 0 1 1.756 0ZM7.875 1.69l-4.63 2.685L8 7.133l4.755-2.758-4.63-2.685a.248.248 0 0 0-.25 0ZM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432Zm6.25 8.271 4.625-2.683a.25.25 0 0 0 .125-.216V5.677L8.75 8.432Z"></path>
  </svg>`;

  const rows = assets.map(a => {
    const escapedName = escapeHtml(a.name);
    const escapedUrl = escapeHtml(a.url);
    const escapedReleaseUrl = escapeHtml(a.releaseUrl);
    const escapedReleaseTitle = escapeHtml(a.releaseTitle);
    return `
    <tr class="latest-asset-row" data-name="${escapedName.toLowerCase()}" data-date="${a.releaseDate}">
      <td class="asset-cell asset-cell-icon">${packageIcon}</td>
      <td class="asset-cell asset-cell-name">
        <a href="${escapedUrl}" class="asset-name">${escapedName}</a>
      </td>
      <td class="asset-cell asset-cell-size">${formatBytes(a.size)}</td>
      <td class="asset-cell asset-cell-date">
        <a href="${escapedReleaseUrl}" class="asset-release-link" title="${escapedReleaseTitle}">
          <span class="date-value" data-date="${a.releaseDate}"></span>
        </a>
      </td>
    </tr>
  `;
  }).join('');

  let truncationHtml = '';
  if (meta && meta.assetsCount < meta.totalAssetsCount) {
    truncationHtml = `
    <div class="releases-truncated">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path>
      </svg>
      <span>Displaying ${meta.assetsCount} of ${meta.totalAssetsCount} assets</span>
    </div>
    `;
  }

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
    ${truncationHtml}
  `;
}

// Helper function for escaping HTML (if not already defined)
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function selectCategory(categoryId, page = 1) {
  showLoading();
  setTimeout(() => doSelectCategory(categoryId, page), 10);
}

async function doSelectCategory(categoryId, page = 1) {
  try {
    const wasAlreadySelected = currentCategoryId === categoryId;
    const category = categoryData[categoryId];
    document.body.classList.toggle('latest-page-active', categoryId === 'latest-page');

    // Handle index page
    if (category && category.isIndex) {
      updateSidebarSelection(categoryId, wasAlreadySelected);
      currentCategoryId = categoryId;
      currentPage = 1;

      document.getElementById('categoryTitle').textContent = category.name;

      const descriptionEl = document.getElementById('categoryDescription');
      const descriptionHtml = categoryDescriptionsHtml[categoryId];
      if (descriptionHtml) {
        descriptionEl.innerHTML = descriptionHtml;
        descriptionEl.style.display = 'block';
      } else {
        descriptionEl.innerHTML = '';
        descriptionEl.style.display = 'none';
      }

      getReleasesList().innerHTML = '';
      updateUrlParams();
      hideLoading();
      return;
    }

    // Handle latest-page
    if (category && category.isLatestPage) {
      const meta = await fetchMeta(categoryId);
      const displayMode = window.pendingLatestDisplayMode || (typeof currentLatestDisplayMode !== 'undefined' ? currentLatestDisplayMode : 'releases');
      window.pendingLatestDisplayMode = null;

      updateSidebarSelection(categoryId, wasAlreadySelected);
      currentCategoryId = categoryId;

      document.getElementById('categoryTitle').textContent = category.name;

      const descriptionEl = document.getElementById('categoryDescription');
      const descriptionHtml = categoryDescriptionsHtml[categoryId];
      if (descriptionHtml) {
        descriptionEl.innerHTML = descriptionHtml;
        descriptionEl.style.display = 'block';
      } else {
        descriptionEl.innerHTML = '';
        descriptionEl.style.display = 'none';
      }

      const releasesList = getReleasesList();

      // Check if no releases
      if (meta.releaseCount === 0) {
        releasesList.innerHTML = `
          <p class="latest-empty"><em>There are no releases marked as latest</em></p>
        `;
        currentPage = 1;
        updateUrlParams();
        hideLoading();
        return;
      }

      // Build display mode toggle
      const displayModesHtml = `
        <div class="latest-display-modes">
          <span class="display-mode-label">View:</span>
          <button type="button" class="display-mode-btn${displayMode === 'releases' ? ' active' : ''}" data-mode="releases" onclick="setLatestDisplayModeMulti('releases')">Releases</button>
          <span class="display-mode-divider">|</span>
          <span class="display-mode-label">Assets:</span>
          <button type="button" class="display-mode-btn${displayMode === 'assets-date-desc' ? ' active' : ''}" data-mode="assets-date-desc" onclick="setLatestDisplayModeMulti('assets-date-desc')">Date ↓</button>
          <button type="button" class="display-mode-btn${displayMode === 'assets-date-asc' ? ' active' : ''}" data-mode="assets-date-asc" onclick="setLatestDisplayModeMulti('assets-date-asc')">Date ↑</button>
          <button type="button" class="display-mode-btn${displayMode === 'assets-name-asc' ? ' active' : ''}" data-mode="assets-name-asc" onclick="setLatestDisplayModeMulti('assets-name-asc')">A-Z</button>
          <button type="button" class="display-mode-btn${displayMode === 'assets-name-desc' ? ' active' : ''}" data-mode="assets-name-desc" onclick="setLatestDisplayModeMulti('assets-name-desc')">Z-A</button>
        </div>
      `;

      if (displayMode === 'releases') {
        // Releases view with pagination
        const pageNum = Math.min(Math.max(1, page), meta.pageCount);
        const html = await fetchPage(categoryId, pageNum);
        currentPage = pageNum;

        releasesList.innerHTML = displayModesHtml + `<div class="latest-releases-view">${html}</div><div class="latest-assets-view" style="display:none"></div>`;

        const topPlaceholder = document.getElementById('pagination-top-placeholder');
        const bottomPlaceholder = document.getElementById('pagination-bottom-placeholder');

        if (meta.pageCount > 1) {
          if (topPlaceholder) {
            topPlaceholder.innerHTML = renderPagination(pageNum, meta.pageCount, 'top');
          }
          if (bottomPlaceholder) {
            bottomPlaceholder.innerHTML = renderPagination(pageNum, meta.pageCount, 'bottom');
          }
        }
      } else {
        // Assets view
        const assetsPaginated = meta.assetsPaginated === true;
        const assetsPageCount = meta.assetsPageCount || 1;
        currentPage = 1;

        if (assetsPaginated) {
          // Paginated JSON mode
          const assetsPage = window.pendingAssetsPage || 1;
          window.pendingAssetsPage = null;
          const assetsPageNum = Math.min(Math.max(1, assetsPage), assetsPageCount);
          currentAssetsPage = assetsPageNum;

          const sortOrder = getSortOrderFromMode(displayMode);
          const assetsData = await fetchAssetsJson(categoryId, sortOrder, assetsPageNum);
          const assetsHtml = renderAssetsTableFromJson(assetsData, assetsPageNum === assetsPageCount ? meta : null);

          // Add pagination placeholders
          const assetsPaginationTop = '<div id="assets-pagination-top-placeholder"></div>';
          const assetsPaginationBottom = '<div id="assets-pagination-bottom-placeholder"></div>';

          releasesList.innerHTML = displayModesHtml + `<div class="latest-releases-view" style="display:none"></div><div class="latest-assets-view">${assetsPaginationTop}${assetsHtml}${assetsPaginationBottom}</div>`;

          // Inject assets pagination
          const assetsTopPlaceholder = document.getElementById('assets-pagination-top-placeholder');
          const assetsBottomPlaceholder = document.getElementById('assets-pagination-bottom-placeholder');
          if (assetsTopPlaceholder) {
            assetsTopPlaceholder.innerHTML = renderAssetsPagination(assetsPageNum, assetsPageCount, 'top');
          }
          if (assetsBottomPlaceholder) {
            assetsBottomPlaceholder.innerHTML = renderAssetsPagination(assetsPageNum, assetsPageCount, 'bottom');
          }
        } else {
          // Single page HTML mode - fetch pre-rendered HTML and allow client-side sorting
          currentAssetsPage = 1;
          const assetsHtml = await fetchAssetsHtml(categoryId);
          releasesList.innerHTML = displayModesHtml + `<div class="latest-releases-view" style="display:none"></div><div class="latest-assets-view">${assetsHtml}</div>`;
          // Apply client-side sorting
          sortLatestAssets(displayMode);
        }
      }

      if (typeof currentLatestDisplayMode !== 'undefined') {
        currentLatestDisplayMode = displayMode;
      }

      restoreCollapsedStates();
      formatDates();
      updateUrlParams();

      if (pendingScrollTo === 'top') {
        document.querySelector('.main-content').scrollTo(0, 0);
      } else if (pendingScrollTo === 'bottom') {
        const mainContent = document.querySelector('.main-content');
        mainContent.scrollTo(0, mainContent.scrollHeight);
      }
      pendingScrollTo = null;

      hideLoading();
      return;
    }

    // Fetch metadata and page content
    const meta = await fetchMeta(categoryId);
    const pageNum = Math.min(Math.max(1, page), meta.pageCount);
    const html = await fetchPage(categoryId, pageNum);

    updateSidebarSelection(categoryId, wasAlreadySelected);
    currentCategoryId = categoryId;
    currentPage = pageNum;

    // Update title
    if (category) {
      document.getElementById('categoryTitle').textContent = category.name;
    }

    // Update description (only on page 1)
    const descriptionEl = document.getElementById('categoryDescription');
    if (pageNum === 1 && categoryDescriptionsHtml[categoryId]) {
      descriptionEl.innerHTML = categoryDescriptionsHtml[categoryId];
      descriptionEl.style.display = 'block';
    } else {
      descriptionEl.innerHTML = '';
      descriptionEl.style.display = 'none';
    }

    // Update releases list
    const releasesList = getReleasesList();

    // Set content and inject pagination into placeholders
    releasesList.innerHTML = html;

    const topPlaceholder = document.getElementById('pagination-top-placeholder');
    const bottomPlaceholder = document.getElementById('pagination-bottom-placeholder');

    if (meta.pageCount > 1) {
      if (topPlaceholder) {
        topPlaceholder.innerHTML = renderPagination(pageNum, meta.pageCount, 'top');
      }
      if (bottomPlaceholder) {
        bottomPlaceholder.innerHTML = renderPagination(pageNum, meta.pageCount, 'bottom');
      }
    }

    restoreCollapsedStates();
    updateEmptyState();
    formatDates();
    updateUrlParams();

    // Handle scroll position
    if (pendingScrollTo === 'top') {
      document.querySelector('.main-content').scrollTo(0, 0);
    } else if (pendingScrollTo === 'bottom') {
      const mainContent = document.querySelector('.main-content');
      mainContent.scrollTo(0, mainContent.scrollHeight);
    }
    pendingScrollTo = null;

  } catch (error) {
    console.error('Error loading category:', error);
    const isLocalFile = window.location.protocol === 'file:';
    const errorMessage = isLocalFile
      ? 'Multi-page mode requires a web server. Open this site via HTTP/HTTPS, or regenerate with multi-page mode disabled.'
      : 'Error loading releases. Please try again.';
    getReleasesList().innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48">
          <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-2h2v2h-2zm0-4V7h2v6h-2z"/>
        </svg>
        <p>${errorMessage}</p>
      </div>
    `;
  }

  hideLoading();
}

function renderPagination(currentPage, totalPages, position = 'bottom') {
  const pages = [];

  if (totalPages <= 9) {
    // Show all pages
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
  } else if (currentPage <= 5) {
    // Near start: 1 2 3 4 5 ... N
    for (let i = 1; i <= 5; i++) {
      pages.push(i);
    }
    pages.push('...');
    pages.push(totalPages);
  } else if (currentPage >= totalPages - 4) {
    // Near end: 1 ... N-4 N-3 N-2 N-1 N
    pages.push(1);
    pages.push('...');
    for (let i = totalPages - 4; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    // Middle: 1 ... P-2 P-1 P P+1 P+2 ... N
    pages.push(1);
    pages.push('...');
    for (let i = currentPage - 2; i <= currentPage + 2; i++) {
      pages.push(i);
    }
    pages.push('...');
    pages.push(totalPages);
  }

  const pagesHtml = pages.map(p => {
    if (p === '...') {
      return '<span class="pagination-ellipsis">…</span>';
    }
    const isActive = p === currentPage;
    return `<button class="pagination-btn${isActive ? ' active' : ''}" ${isActive ? 'disabled' : `onclick="goToPage(${p}, 'top')"`}>${p}</button>`;
  }).join('');

  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage === totalPages;

  // Scroll direction: prev scrolls to bottom, next scrolls to top
  const prevHtml = isFirstPage ? '' : `
      <button class="pagination-btn pagination-prev" onclick="goToPage(${currentPage - 1}, 'bottom')" title="Previous page">
        <svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"></path></svg>
        Prev
      </button>`;

  const nextHtml = isLastPage ? '' : `
      <button class="pagination-btn pagination-next" onclick="goToPage(${currentPage + 1}, 'top')" title="Next page">
        Next
        <svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
      </button>`;

  return `
    <nav class="pagination pagination-${position}">
      ${prevHtml}
      <div class="pagination-pages">
        ${pagesHtml}
      </div>
      ${nextHtml}
    </nav>
  `;
}

// scrollTo: 'top', 'bottom', or null (no scroll - for initial load)
function goToPage(page, scrollTo = 'top') {
  if (page !== currentPage) {
    pendingScrollTo = scrollTo;
    selectCategory(currentCategoryId, page);
  }
}

// Assets pagination for latest-page
function renderAssetsPagination(currentPage, totalPages, position = 'bottom') {
  const pages = [];

  if (totalPages <= 9) {
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
  } else if (currentPage <= 5) {
    for (let i = 1; i <= 5; i++) {
      pages.push(i);
    }
    pages.push('...');
    pages.push(totalPages);
  } else if (currentPage >= totalPages - 4) {
    pages.push(1);
    pages.push('...');
    for (let i = totalPages - 4; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    pages.push(1);
    pages.push('...');
    for (let i = currentPage - 2; i <= currentPage + 2; i++) {
      pages.push(i);
    }
    pages.push('...');
    pages.push(totalPages);
  }

  const pagesHtml = pages.map(p => {
    if (p === '...') {
      return '<span class="pagination-ellipsis">…</span>';
    }
    const isActive = p === currentPage;
    return `<button class="pagination-btn${isActive ? ' active' : ''}" ${isActive ? 'disabled' : `onclick="goToAssetsPage(${p}, 'top')"`}>${p}</button>`;
  }).join('');

  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage === totalPages;

  const prevHtml = isFirstPage ? '' : `
      <button class="pagination-btn pagination-prev" onclick="goToAssetsPage(${currentPage - 1}, 'bottom')" title="Previous page">
        <svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"></path></svg>
        Prev
      </button>`;

  const nextHtml = isLastPage ? '' : `
      <button class="pagination-btn pagination-next" onclick="goToAssetsPage(${currentPage + 1}, 'top')" title="Next page">
        Next
        <svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
      </button>`;

  return `
    <nav class="pagination pagination-${position}">
      ${prevHtml}
      <div class="pagination-pages">
        ${pagesHtml}
      </div>
      ${nextHtml}
    </nav>
  `;
}

async function goToAssetsPage(page, scrollTo = 'top') {
  if (page === currentAssetsPage || currentCategoryId !== 'latest-page') return;

  showLoading();
  try {
    const meta = await fetchMeta(currentCategoryId);
    const assetsPageCount = meta.assetsPageCount || 1;
    const pageNum = Math.min(Math.max(1, page), assetsPageCount);
    currentAssetsPage = pageNum;

    // Get current sort order from the display mode
    const sortOrder = getSortOrderFromMode(currentLatestDisplayMode || 'assets-date-desc');
    const assetsData = await fetchAssetsJson(currentCategoryId, sortOrder, pageNum);
    const assetsHtml = renderAssetsTableFromJson(assetsData, pageNum === assetsPageCount ? meta : null);

    const assetsView = document.querySelector('.latest-assets-view');
    if (assetsView) {
      const assetsPaginationTop = '<div id="assets-pagination-top-placeholder"></div>';
      const assetsPaginationBottom = '<div id="assets-pagination-bottom-placeholder"></div>';
      assetsView.innerHTML = `${assetsPaginationTop}${assetsHtml}${assetsPaginationBottom}`;

      const assetsTopPlaceholder = document.getElementById('assets-pagination-top-placeholder');
      const assetsBottomPlaceholder = document.getElementById('assets-pagination-bottom-placeholder');
      if (assetsTopPlaceholder) {
        assetsTopPlaceholder.innerHTML = renderAssetsPagination(pageNum, assetsPageCount, 'top');
      }
      if (assetsBottomPlaceholder) {
        assetsBottomPlaceholder.innerHTML = renderAssetsPagination(pageNum, assetsPageCount, 'bottom');
      }
    }

    formatDates();
    updateUrlParams();

    if (scrollTo === 'top') {
      document.querySelector('.main-content').scrollTo(0, 0);
    } else if (scrollTo === 'bottom') {
      const mainContent = document.querySelector('.main-content');
      mainContent.scrollTo(0, mainContent.scrollHeight);
    }
  } catch (error) {
    console.error('Error loading assets page:', error);
  }
  hideLoading();
}

// Track pending scroll position for page navigation
let pendingScrollTo = null;

// Handle browser back/forward
window.addEventListener('popstate', (event) => {
  if (event.state && event.state.categoryId) {
    selectCategory(event.state.categoryId, event.state.page || 1);
  } else {
    // Parse URL to determine category and page
    const path = window.location.pathname.slice(1); // Remove leading /
    const params = new URLSearchParams(window.location.search);
    const page = parseInt(params.get('page'), 10) || 1;

    if (path && categoryData[path]) {
      selectCategory(path, page);
    }
  }
});

// Multi-page mode handler for latest-page display mode switching
async function setLatestDisplayModeMulti(mode) {
  if (currentCategoryId !== 'latest-page') return;

  // Update global mode variable
  if (typeof currentLatestDisplayMode !== 'undefined') {
    currentLatestDisplayMode = mode;
  }

  // Update button active states
  document.querySelectorAll('.display-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const releasesView = document.querySelector('.latest-releases-view');
  const assetsView = document.querySelector('.latest-assets-view');

  if (mode === 'releases') {
    // Switch to releases view - may need to fetch if not loaded
    if (releasesView && releasesView.innerHTML.trim() === '') {
      showLoading();
      try {
        const meta = await fetchMeta(currentCategoryId);
        const html = await fetchPage(currentCategoryId, 1);
        currentPage = 1;
        releasesView.innerHTML = html;

        const topPlaceholder = document.getElementById('pagination-top-placeholder');
        const bottomPlaceholder = document.getElementById('pagination-bottom-placeholder');

        if (meta.pageCount > 1) {
          if (topPlaceholder) {
            topPlaceholder.innerHTML = renderPagination(1, meta.pageCount, 'top');
          }
          if (bottomPlaceholder) {
            bottomPlaceholder.innerHTML = renderPagination(1, meta.pageCount, 'bottom');
          }
        }

        restoreCollapsedStates();
        formatDates();
      } catch (error) {
        console.error('Error loading releases:', error);
      }
      hideLoading();
    }

    if (releasesView) releasesView.style.display = 'flex';
    if (assetsView) assetsView.style.display = 'none';
  } else {
    // Switch to assets view
    const meta = await fetchMeta(currentCategoryId);
    const assetsPaginated = meta.assetsPaginated === true;
    const assetsPageCount = meta.assetsPageCount || 1;

    if (assetsPaginated) {
      // Paginated JSON mode - fetch the appropriate sort order (always go to page 1 on sort change)
      showLoading();
      try {
        currentAssetsPage = 1;
        const sortOrder = getSortOrderFromMode(mode);
        const assetsData = await fetchAssetsJson(currentCategoryId, sortOrder, 1);
        const assetsHtml = renderAssetsTableFromJson(assetsData, assetsPageCount === 1 ? meta : null);

        // Add pagination placeholders
        const assetsPaginationTop = '<div id="assets-pagination-top-placeholder"></div>';
        const assetsPaginationBottom = '<div id="assets-pagination-bottom-placeholder"></div>';

        assetsView.innerHTML = `${assetsPaginationTop}${assetsHtml}${assetsPaginationBottom}`;

        // Inject assets pagination
        const assetsTopPlaceholder = document.getElementById('assets-pagination-top-placeholder');
        const assetsBottomPlaceholder = document.getElementById('assets-pagination-bottom-placeholder');
        if (assetsTopPlaceholder) {
          assetsTopPlaceholder.innerHTML = renderAssetsPagination(1, assetsPageCount, 'top');
        }
        if (assetsBottomPlaceholder) {
          assetsBottomPlaceholder.innerHTML = renderAssetsPagination(1, assetsPageCount, 'bottom');
        }

        formatDates();
      } catch (error) {
        console.error('Error loading assets:', error);
      }
      hideLoading();
    } else {
      // Single-page HTML mode - fetch if not loaded, then apply client-side sorting
      if (assetsView && assetsView.innerHTML.trim() === '') {
        showLoading();
        try {
          currentAssetsPage = 1;
          const assetsHtml = await fetchAssetsHtml(currentCategoryId);
          assetsView.innerHTML = assetsHtml;
          formatDates();
        } catch (error) {
          console.error('Error loading assets:', error);
        }
        hideLoading();
      }
      // Apply client-side sorting
      sortLatestAssets(mode);
    }

    if (releasesView) releasesView.style.display = 'none';
    if (assetsView) assetsView.style.display = 'block';
  }

  updateUrlParams();
}
