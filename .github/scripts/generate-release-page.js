const fs = require('fs');
const path = require('path');

const releaseName = process.env.RELEASE_NAME || 'Unnamed Release';
const releaseUrl = process.env.RELEASE_URL || '#';
const releaseTag = process.env.RELEASE_TAG || '';
const releaseBody = process.env.RELEASE_BODY || '';

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, char => map[char]);
}

function generateHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(releaseName)}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #333; }
    .tag {
      background: #f1f1f1;
      padding: 4px 8px;
      border-radius: 4px;
      font-family: monospace;
    }
    a { color: #0366d6; }
    .release-notes {
      background: #f6f8fa;
      padding: 16px;
      border-radius: 8px;
      margin-top: 20px;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(releaseName)}</h1>
  <p><span class="tag">${escapeHtml(releaseTag)}</span></p>
  <p><a href="${escapeHtml(releaseUrl)}">View Release on GitHub</a></p>
  ${releaseBody ? `<div class="release-notes">${escapeHtml(releaseBody)}</div>` : ''}
</body>
</html>`;
}

// Create output directory and write file
const outputDir = '_site';
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'index.html'), generateHtml());

console.log('Generated release page successfully');
