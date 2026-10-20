// Print the commit the rolling lab-bundle release was last published from, for the publish job's ordering check.
// Usage: node scripts/release-stamp.mjs <owner/repo> <tag>   (GH_TOKEN authenticates; GITHUB_API_URL overrides the API)
// Prints nothing, and exits 0, only when the release or its build.json asset is confirmed absent (HTTP 404 for the
// release, or no asset of that name), because then there is nothing newer to overwrite. Any other outcome, such as a
// failed request, a non-2xx status or a stamp that is not JSON with a commit SHA, exits 1: "could not tell" must stop
// the publish, not read as "nothing published".
const [repo, tag] = process.argv.slice(2);
if (!repo || !tag) {
  console.error('Usage: node scripts/release-stamp.mjs <owner/repo> <tag>');
  process.exit(2);
}

const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const get = (url, accept) => fetch(url, {
  headers: {
    Accept: accept,
    'User-Agent': 'integration-failure-lab',
    ...(process.env.GH_TOKEN && { Authorization: `Bearer ${process.env.GH_TOKEN}` }),
  },
});

try {
  const release = await get(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, 'application/vnd.github+json');
  if (release.status !== 404) {
    if (!release.ok) throw new Error(`the ${tag} release lookup returned HTTP ${release.status}`);
    const asset = (await release.json()).assets?.find(a => a.name === 'build.json');
    if (asset) {
      const file = await get(asset.url, 'application/octet-stream');
      if (!file.ok) throw new Error(`downloading build.json returned HTTP ${file.status}`);
      const { gitCommit } = JSON.parse(await file.text()) ?? {};
      if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error(`build.json names no commit SHA (${JSON.stringify(gitCommit)})`);
      console.log(gitCommit);
    }
  }
} catch (error) {
  console.error(`Cannot read the ${tag} release stamp: ${error.message}`);
  process.exit(1);
}
