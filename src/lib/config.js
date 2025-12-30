const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration & CLI Arguments
// ============================================================================

function printUsage() {
  console.log(`
Usage: node generate-release-page.js --repo <owner/repo> [options]
       node generate-release-page.js --releases-file <path> [options]

Either --repo or --releases-file is required.

Options:
  --repo <owner/repo>     Repository to fetch releases from
                          Can be full URL: https://github.com/owner/repo
  --releases-file <path>  Load releases from a local JSON file instead of GitHub API
  --token <token>         GitHub API token (or use GITHUB_TOKEN env var)
  --config <path>         Config file path, local or URL
                          Default: .github/categorized-releases/config.yaml
  --output <dir>          Output directory for generated site (default: _site)
  --save-releases <path>  Fetch ALL releases and save to JSON file, then exit
                          (config file not used, no page generated)
  --github-markdown       Use GitHub API for markdown rendering instead of local code
                          (slower but more similar to GitHub's own rendering)
  --help                  Show this help message

Examples:
  # Fetch releases from a repository
  node generate-release-page.js --repo owner/repo --config ./config.yaml

  # Using a remote config file
  node generate-release-page.js --repo owner/repo --config https://example.com/config.yaml

  # Using a local releases file (for offline development or testing)
  node generate-release-page.js --releases-file releases.json --config ./config.yaml

  # Fetch releases and save for later use (no page generated)
  node generate-release-page.js --repo owner/repo --save-releases releases.json
`);
}

function parseRepoArg(repo) {
  if (!repo) return null;
  // Handle full GitHub URL
  const urlMatch = repo.match(/github\.com\/([^\/]+\/[^\/]+)/);
  if (urlMatch) {
    return urlMatch[1].replace(/\.git$/, '');
  }
  return repo;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    token: process.env.GITHUB_TOKEN || null,
    repo: null,
    configPath: '.github/categorized-releases/config.yaml',
    outputDir: '_site',
    releasesFile: null,
    saveReleasesFile: null,
    useGitHubMarkdown: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token':
        config.token = args[++i];
        break;
      case '--repo':
        config.repo = parseRepoArg(args[++i]);
        break;
      case '--config':
        config.configPath = args[++i];
        break;
      case '--output':
        config.outputDir = args[++i];
        break;
      case '--releases-file':
        config.releasesFile = args[++i];
        break;
      case '--save-releases':
        config.saveReleasesFile = args[++i];
        break;
      case '--github-markdown':
        config.useGitHubMarkdown = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (args[i].startsWith('-')) {
          console.error(`Unknown option: ${args[i]}`);
          printUsage();
          process.exit(1);
        }
    }
  }

  // Validate required arguments
  if (!config.repo && !config.releasesFile) {
    console.error('Error: Either --repo or --releases-file is required.');
    console.error('Run with --help for usage details.');
    process.exit(1);
  }

  return config;
}

function isUrl(str) {
  return str && (str.startsWith('http://') || str.startsWith('https://'));
}

async function fetchUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

// Parse arguments early so they're available globally
const CONFIG = parseArgs();

module.exports = {
  CONFIG,
  printUsage,
  parseArgs,
  parseRepoArg,
  isUrl,
  fetchUrl
};
