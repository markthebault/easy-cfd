// Re-run a failed case through the live UI, preserving its geometry and settings.
import { chromium } from '../frontend/node_modules/playwright-core/index.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = process.env.EASYCFD_TEST_URL || 'http://127.0.0.1:8000';
const failedId = process.argv[2];
assert.match(failedId || '', /^[a-f0-9]{32}$/, 'Pass the failed run ID');
const out = 'docs/custom-box/mesh-fix';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  const old = await (await page.request.get(`${base}/api/runs/${failedId}`)).json();
  const projects = await (await page.request.get(`${base}/api/projects`)).json();
  const index = projects.findIndex(p => p.id === old.project_id);
  assert.ok(index >= 0);
  const project = projects[index];
  assert.deepEqual(project.settings, old.settings, 'Project changed since failure');
  assert.equal(project.geometry.fingerprint, old.geometry.fingerprint);
  await page.goto(base);
  await page.getByRole('button', { name: /^Designs/ }).click();
  await page.locator('.project-item').nth(index).click();
  await page.getByRole('button', { name: /02.*Driving conditions/ }).click();
  await page.getByLabel('Show box in 3D').check();
  await page.waitForFunction(() => document.querySelector('[data-testid="simulation-box"]'));
  await page.getByRole('button', { name: 'Fit box', exact: true }).click();
  await page.screenshot({ path: `${out}/setup.png`, fullPage: true });
  const event = page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  const response = await event;
  assert.ok(response.ok());
  const submitted = await response.json();
  writeFileSync(`${out}/run-id.txt`, submitted.id + '\n');
  assert.deepEqual(submitted.settings, old.settings);
  assert.deepEqual(submitted.domain, old.domain);
  assert.equal(submitted.geometry.fingerprint, old.geometry.fingerprint);
  console.log('Submitted unchanged case:', submitted.id);
  await page.waitForFunction(
    () => !!document.querySelector('.run-status.completed, .run-status.failed'),
    {}, { timeout: 900000 },
  );
  const run = await (await page.request.get(`${base}/api/runs/${submitted.id}`)).json();
  assert.equal(run.status, 'completed', run.error);
  assert.ok(run.result.mesh_ok);
  const metrics = page.locator('.metric-grid').first();
  for (const [title, key, digits] of [['Drag', 'drag', 2], ['Drag coefficient', 'cd', 4], ['Lift coefficient', 'cl', 4]]) {
    const card = metrics.locator('article').filter({ has: page.getByText(title, { exact: true }) });
    assert.ok((await card.innerText()).includes(run.result[key].toFixed(digits)));
  }
  for (const warning of run.result.warnings) {
    assert.ok((await page.locator('body').innerText()).includes(warning));
  }
  await page.getByLabel('Show saved simulation box').check();
  await page.getByRole('button', { name: 'Fit box', exact: true }).click();
  await page.getByText('Loading geometry…', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.viewport-message.error').count(), 0);
  await page.screenshot({ path: `${out}/result.png`, fullPage: true });
  await page.locator('#run-details').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/diagnostics.png`, fullPage: true });
  const check = readFileSync(`.easycfd/runs/${run.id}/case-medium/log.checkMesh`, 'utf8');
  assert.ok(check.includes('Mesh OK.'));
  assert.ok(!check.includes('Failed '));
  const maxSkewness = Number(check.match(/Max skewness = ([\d.e+-]+)/)[1]);
  assert.ok(maxSkewness <= 4);
  assert.deepEqual(errors, []);
  const summary = { ...run.result };
  delete summary.history;
  writeFileSync(`${out}/checks.json`, JSON.stringify({
    original_run: old.id, run_id: run.id, project_id: project.id,
    unchanged_settings: run.settings, domain: run.domain,
    geometry_fingerprint: run.geometry.fingerprint, max_skewness: maxSkewness,
    result: summary, browser_errors: errors,
  }, null, 2));
  console.log('Mesh fix UI and solver passed:', run.id, 'skewness', maxSkewness);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true });
  console.error((await page.locator('body').innerText()).slice(-3000));
  throw error;
} finally {
  await browser.close();
}
