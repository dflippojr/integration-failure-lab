// scripts/release-stamp.mjs tells the publish job what the lab-bundle release holds: a commit, or confirmed nothing.
// Anything else must fail the job, so a lookup error cannot let an older run overwrite a newer release.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/release-stamp.mjs', import.meta.url));
const sha = 'a'.repeat(40);

// A loopback stand-in for the GitHub API: it answers each request path with a [status, body] from `routes`.
let server, base, requests;
const routes = new Map();
before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, accept: req.headers.accept, authorization: req.headers.authorization });
    const route = routes.get(req.url);
    if (route === 'reset') return req.socket.destroy();
    const [status, body] = route ?? [404, '{"message":"Not Found"}'];
    res.writeHead(status).end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const releaseUrl = '/repos/lab/lab/releases/tags/lab-bundle';
const release = (assets = [{ name: 'build.json', url: `${base}/assets/1` }]) => [200, JSON.stringify({ assets })];
const stampOf = (...routeList) => {
  requests = [];
  routes.clear();
  for (const [url, route] of routeList) routes.set(url, route);
  return run('lab/lab', 'lab-bundle');
};
const run = (...args) => new Promise(resolve => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, GITHUB_API_URL: base, GH_TOKEN: 'secret' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});

test('prints the commit the release was published from', async () => {
  const run = await stampOf(
    [releaseUrl, release()],
    ['/assets/1', [200, JSON.stringify({ gitCommit: sha, builtFrom: 'integration-failure-lab' })]],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), sha);
  assert.deepEqual(requests.map(r => r.accept), ['application/vnd.github+json', 'application/octet-stream']);
  assert.ok(requests.every(r => r.authorization === 'Bearer secret'));
});

test('a release that does not exist yet is confirmed absent: nothing printed, exit 0', async () => {
  const run = await stampOf([releaseUrl, [404, '{"message":"Not Found"}']]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
});

test('a release without a build.json asset is confirmed to hold no stamp: nothing printed, exit 0', async () => {
  for (const assets of [[], [{ name: 'lab-bundle.zip', url: `${base}/assets/2` }], undefined]) {
    const run = await stampOf([releaseUrl, [200, JSON.stringify({ assets })]]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
  }
});

test('a lookup error fails instead of reading as an absent release', async () => {
  for (const [route, message] of [
    [[500, 'oops'], /release lookup returned HTTP 500/],
    [[403, '{"message":"rate limit"}'], /release lookup returned HTTP 403/],
    [[200, 'not json'], /Cannot read the lab-bundle release stamp/],
    ['reset', /Cannot read the lab-bundle release stamp: fetch failed/],
  ]) {
    const run = await stampOf([releaseUrl, route]);
    assert.equal(run.status, 1, JSON.stringify(route));
    assert.equal(run.stdout, '');
    assert.match(run.stderr, message);
  }
});

test('a failed build.json download or an unusable stamp fails', async () => {
  for (const [asset, message] of [
    [[404, 'gone'], /downloading build\.json returned HTTP 404/],
    [[502, 'bad gateway'], /downloading build\.json returned HTTP 502/],
    [[200, 'not json'], /Cannot read the lab-bundle release stamp/],
    [[200, 'null'], /names no commit SHA \(undefined\)/],
    [[200, '{}'], /names no commit SHA \(undefined\)/],
    [[200, JSON.stringify({ gitCommit: `${sha}-dirty` })], /names no commit SHA/],
    [[200, JSON.stringify({ gitCommit: 'main' })], /names no commit SHA/],
  ]) {
    const run = await stampOf([releaseUrl, release()], ['/assets/1', asset]);
    assert.equal(run.status, 1, JSON.stringify(asset));
    assert.equal(run.stdout, '');
    assert.match(run.stderr, message);
  }
});

test('a line break in the tag cannot forge a second log line', async () => {
  const tag = 'lab-bundle\nFORGED entry';
  requests = [];
  routes.clear();
  routes.set(`/repos/lab/lab/releases/tags/${encodeURIComponent(tag)}`, [500, 'oops']);
  const result = await run('lab/lab', tag);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trimEnd().split('\n').length, 1, result.stderr);
  assert.match(result.stderr, /^Cannot read the lab-bundle\\u000aFORGED entry release stamp: .*returned HTTP 500\n$/);
});

test('a parse error that quotes a line break from the stamp cannot forge a second log line', async () => {
  const run = await stampOf(
    [releaseUrl, release()],
    ['/assets/1', [200, 'not json\nFORGED entry']],
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.trimEnd().split('\n').length, 1, run.stderr);
  assert.match(run.stderr, /^Cannot read the lab-bundle release stamp: .*\\u000a/);
});

test('exits 2 without a repository and a tag', async () => {
  const run = await new Promise(resolve => {
    const child = spawn(process.execPath, [script, 'lab/lab']);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stderr }));
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^Usage:/);
});

test('the publish job reads the release stamp with the script and stops when it fails', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const order = ci.slice(ci.indexOf('id: order'), ci.indexOf('- name: Publish the lab-bundle pre-release'));
  assert.match(order, /current=\$\(node scripts\/release-stamp\.mjs "\$GITHUB_REPOSITORY" "\$TAG"\)/);
  assert.doesNotMatch(order, /\|\| true/);
  assert.doesNotMatch(order, /gh release download/);
});
