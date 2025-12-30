// ============================================================================
// Multi-page mode specific functionality
// Requires: script-common.js to be loaded first
// ============================================================================

// Cache for fetched content
const pageCache = new Map();
const metaCache = new Map();

let currentPage = 1;

function updateUrlParams() {
  const params = new URLSearchParams();

  const latestOnly = document.getElementById('showLatestOnly');
  const prereleases = document.getElementById('showPrereleases');
  const assets = document.getElementById('showAssets');

  if (latestOnly && latestOnly.checked) params.set('latest', '1');
  if (prereleases && !prereleases.checked) params.set('prereleases', '0');
  if (assets && !assets.checked) params.set('assets', '0');
  if (currentPage > 1) params.set('page', currentPage.toString());

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

function selectCategory(categoryId, page = 1) {
  showLoading();
  setTimeout(() => doSelectCategory(categoryId, page), 10);
}

async function doSelectCategory(categoryId, page = 1) {
  try {
    const wasAlreadySelected = currentCategoryId === categoryId;
    const category = categoryData[categoryId];

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
