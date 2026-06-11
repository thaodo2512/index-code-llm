import { execa } from 'execa';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url));

let root: string;
let stubBin: string;

// The scripts only need `docker` / `docker compose` to exist when generating
// files (the build/start step is declined), so a stub keeps the tests hermetic.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cgws-deploy-'));
  stubBin = join(root, 'bin');
  await mkdir(stubBin);
  await writeFile(join(stubBin, 'docker'), '#!/bin/sh\nexit 0\n');
  await chmod(join(stubBin, 'docker'), 0o755);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = () => ({ ...process.env, PATH: `${stubBin}:${process.env.PATH}` });

describe('local_deploy.sh (generate only, build declined)', () => {
  it('writes a pinned, hardened deployment with a private .env', async () => {
    const repoPath = join(root, 'repo1');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    const deployDir = join(root, 'deploy');

    const answers = [
      'cgw-test', // deployment name
      'repo1', // repo name
      repoPath, // repo path
      '', // scope (default '.')
      'n', // add another repo?
      '38999', // host port
      'y', // bearer token?
      'n', // index after start?
      deployDir, // deploy dir
      'n', // build and start now? -> generate files only
    ].join('\n');

    const r = await execa('bash', [join(scriptsDir, 'local_deploy.sh')], {
      input: answers + '\n',
      env: env(),
      reject: false,
    });
    expect(r.exitCode, r.stderr).toBe(0);

    const compose = await readFile(join(deployDir, 'docker-compose.yml'), 'utf-8');
    // CodeGraph must come from the Dockerfile pin, never a floating tag.
    expect(compose).not.toContain('latest');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain(`${repoPath}:/repos/repo1:ro`);
    expect(compose).toContain('127.0.0.1:${HOST_PORT}:8765');

    const dotenv = await readFile(join(deployDir, '.env'), 'utf-8');
    expect(dotenv).toMatch(/^CGW_TOKEN=[0-9a-f]{48}$/m);
    // .env holds the bearer token — owner-only.
    expect((await stat(join(deployDir, '.env'))).mode & 0o777).toBe(0o600);

    const ws = JSON.parse(await readFile(join(deployDir, 'workspace.json'), 'utf-8'));
    expect(ws.viewsDir).toBe('/data/views');
    expect(ws.repos).toEqual([{ name: 'repo1', path: '/repos/repo1', scope: ['.'] }]);

    expect((await stat(join(deployDir, 'cgw'))).mode & 0o111).not.toBe(0);
  });
});

describe('cgw remove-repo', () => {
  async function cgwDir(): Promise<string> {
    const dir = join(root, 'cgw-deploy');
    await mkdir(dir);
    await copyFile(join(scriptsDir, 'cgw.sh'), join(dir, 'cgw'));
    await chmod(join(dir, 'cgw'), 0o755);
    await writeFile(
      join(dir, 'workspace.json'),
      JSON.stringify({
        viewsDir: '/data/views',
        repos: [
          { name: 'repo1', path: '/repos/repo1', scope: ['.'] },
          { name: 'repo2', path: '/repos/repo2', scope: ['.'] },
        ],
      }),
    );
    return dir;
  }

  it('rejects path-escaping names before touching anything', async () => {
    const dir = await cgwDir();
    const r = await execa(join(dir, 'cgw'), ['remove-repo', '../..'], { env: env(), reject: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid repo name');
  });

  it('still reaches the registered() check for well-formed names', async () => {
    const dir = await cgwDir();
    const r = await execa(join(dir, 'cgw'), ['remove-repo', 'nope'], { env: env(), reject: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("'nope' is not registered");
  });
});
