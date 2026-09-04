// Regression test for stonyx-cron#30.
//
// The package must publish `config/environment.js` (plain JS) and must NOT
// publish `config/environment.ts`. Node refuses to type-strip inside
// `node_modules`, so if we ship a `.ts` here the stonyx module loader
// dynamic-import of this config will crash consumers at parse time.
//
// This test invokes `npm pack --dry-run --json` and asserts the tarball
// entry list contains `config/environment.js` and does not contain
// `config/environment.ts`.
import QUnit from 'qunit';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const { module, test } = QUnit;

module('[Unit] Publish surface', function () {
  test('config/environment.js is published and .ts is not', function (assert) {
    const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const report = JSON.parse(stdout);
    const entry = Array.isArray(report) ? report[0] : report;
    const files = (entry.files ?? []).map((f: { path: string }) => f.path);

    assert.ok(
      files.includes('config/environment.js'),
      'published tarball includes config/environment.js'
    );
    assert.notOk(
      files.includes('config/environment.ts'),
      'published tarball does NOT include config/environment.ts'
    );
  });

  // Regression test for stonyx-cron#34.
  //
  // #34 made two published-surface claims that had been verified by hand and
  // recorded only in a PR body: that `CronService` emits `#private;` (so the
  // class is nominally typed and a consumer's structural double stops
  // compiling), and that `claimJob` / `settleJob` / `executeClaimed` do NOT
  // appear in the emitted declarations. This file exists because a
  // published-surface property regressed once before (#30) and prose did not
  // catch it; the same guard applies here. A later refactor that publishes one
  // of those three, or that flips the class back to structural typing, is a
  // breaking change for consumers and must not land silently.
  //
  // Asserted against the EMITTED `dist/service.d.ts`, never against `src/`.
  test('dist/service.d.ts keeps CronService nominal and its claim helpers private', function (assert) {
    const declarations = readFileSync('dist/service.d.ts', 'utf8');

    assert.ok(
      /^\s*#private;\s*$/m.test(declarations),
      'CronService emits `#private;` — the class stays nominally typed'
    );

    // Scoped to declarations, not the whole file: each name is legitimately
    // mentioned inside JSDoc prose, and a substring match would pass on that.
    for (const name of ['claimJob', 'settleJob', 'executeClaimed']) {
      assert.notOk(
        new RegExp(`^\\s*(private\\s+)?${name}\\s*[(<:]`, 'm').test(declarations),
        `${name} is not declared in the published surface`
      );
    }

    // The narrowed `reason` union is only usable if a consumer can name it.
    for (const type of ['SkipReason', 'ExecuteResult', 'JobDueResult', 'ServiceStatus', 'ListOptions', 'OnJobDueCallback']) {
      assert.ok(
        new RegExp(`^export (type|interface) ${type}\\b`, 'm').test(declarations),
        `${type} is exported from the published surface`
      );
    }

    assert.ok(
      declarations.includes("reason?: SkipReason"),
      'ExecuteResult.reason is the narrowed union, not string'
    );
  });
});
