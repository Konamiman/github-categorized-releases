// ============================================================================
// Single-page mode specific functionality
// Requires: script-common.js to be loaded first
// ============================================================================

function updateUrlParams() {
  const params = new URLSearchParams();

  const latestOnly = document.getElementById('showLatestOnly');
  const prereleases = document.getElementById('showPrereleases');
  const assets = document.getElementById('showAssets');

  if (latestOnly && latestOnly.checked) params.set('latest', '1');
  if (prereleases && !prereleases.checked) params.set('prereleases', '0');
  if (assets && !assets.checked) params.set('assets', '0');

  const queryString = params.toString();
  const hash = window.location.hash;
  const newUrl = window.location.pathname + (queryString ? '?' + queryString : '') + hash;
  history.replaceState(null, '', newUrl);
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
}

function selectCategory(categoryId) {
  // Check if this is a large category first
  const html = categoryReleasesHtml[categoryId];
  const isLargeCategory = html && html.length > 50000;

  // Show loading immediately for large categories
  if (isLargeCategory) {
    showLoading();
    setTimeout(() => doSelectCategoryFull(categoryId, html), 10);
  } else {
    doSelectCategoryFull(categoryId, html);
  }
}

function doSelectCategoryFull(categoryId, html) {
  const wasAlreadySelected = currentCategoryId === categoryId;
  updateSidebarSelection(categoryId, wasAlreadySelected);
  currentCategoryId = categoryId;
  doSelectCategory(categoryId, html);
}

function doSelectCategory(categoryId, html) {
  // Update title
  const category = categoryData[categoryId];
  if (category) {
    document.getElementById('categoryTitle').textContent = category.name;
  }

  // Update description
  const descriptionEl = document.getElementById('categoryDescription');
  const descriptionHtml = categoryDescriptionsHtml[categoryId];
  if (descriptionHtml) {
    descriptionEl.innerHTML = descriptionHtml;
    descriptionEl.style.display = 'block';
  } else {
    descriptionEl.innerHTML = '';
    descriptionEl.style.display = 'none';
  }

  // Update releases list
  const releasesList = getReleasesList();

  if (html) {
    releasesList.innerHTML = html;
    restoreCollapsedStates();
    updateEmptyState();
    formatDates();
    hideLoading();
  } else if (category && category.isIndex) {
    // Index page - just show the description, no releases message
    releasesList.innerHTML = '';
  } else if (category && category.children && category.children.length > 0) {
    // Show subcategories navigation when no releases but has children
    const linksHtml = category.children.map(child =>
      `<li><a href="#${child.id}" onclick="event.preventDefault(); selectCategory('${child.id}')">${child.name}</a></li>`
    ).join('');
    releasesList.innerHTML = `
      <div class="subcategories">
        <h3>Browse subcategories</h3>
        <ul>${linksHtml}</ul>
      </div>
    `;
  } else {
    releasesList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48">
          <path fill="currentColor" d="M5.25 3A2.25 2.25 0 003 5.25v13.5A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V5.25A2.25 2.25 0 0018.75 3H5.25zM4.5 5.25a.75.75 0 01.75-.75h13.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H5.25a.75.75 0 01-.75-.75V5.25z"/>
        </svg>
        <p>No releases in this category</p>
      </div>
    `;
  }

  // Update URL hash (no hash for index page)
  const hash = categoryId === 'index' ? '' : '#' + categoryId;
  const query = window.location.search;
  history.replaceState(null, '', window.location.pathname + query + hash);
}

// Handle browser back/forward for hash changes
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1);
  if (hash && categoryData[hash] && hash !== currentCategoryId) {
    selectCategory(hash);
  }
});
