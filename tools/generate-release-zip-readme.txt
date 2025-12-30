Categorized Releases Generator
==============================

A tool to generate a categorized releases page for GitHub repositories.


PREREQUISITES
-------------

- Node.js 20 or later (https://nodejs.org/)


USAGE
-----

Generate a releases page from a GitHub repository:

  node src/generate-release-page.js --repo owner/repo --config config.yaml

With a GitHub token (for private repos or higher rate limits):

  node src/generate-release-page.js --repo owner/repo --token YOUR_TOKEN --config config.yaml

Save releases to a file for offline use:

  node src/generate-release-page.js --repo owner/repo --save-releases releases.json

Generate from a saved releases file:

  node src/generate-release-page.js --releases-file releases.json --config config.yaml

Run with --help for all options.


OUTPUT
------

The generated site is written to the output directory (_site by default).
Open _site/index.html in a browser to view the releases page.


MORE INFORMATION
----------------

Full documentation and configuration reference:
https://github.com/Konamiman/github-categorized-releases
