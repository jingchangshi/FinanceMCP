import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function requestWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      headers: { Host: host },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await requestWithHost(port, `127.0.0.1:${port}`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('HTTP test server did not become healthy');
}

test('local HTTP server rejects DNS rebinding Host headers', async () => {
  const port = await reservePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    MCP_ALLOWED_HOSTS: '',
    QVERIS_API_KEY: '',
  };
  delete childEnv.MCP_HTTP_HOST;
  delete childEnv.HOST;

  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(port);

    const response = await requestWithHost(port, 'attacker.example');
    assert.equal(response.status, 403);
    assert.match(response.body, /Invalid Host/);
  } finally {
    if (child.exitCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill();
      });
    }
  }
});

async function startServer(overrides = {}) {
  const port = await reservePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    MCP_ALLOWED_HOSTS: '',
    QVERIS_API_KEY: '',
    ...overrides,
  };
  delete childEnv.MCP_HTTP_HOST;
  delete childEnv.HOST;
  if (!('MCP_BODY_LIMIT' in overrides)) delete childEnv.MCP_BODY_LIMIT;
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(port);
  return {
    port,
    async rpc(body) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.status;
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill();
      });
    },
  };
}

test('default MCP body limit is 64kb and MCP_BODY_LIMIT can widen it', async () => {
  const padding = 'x'.repeat(70_000); // > 64 KB, < 256 KB
  const defaults = await startServer();
  try {
    assert.equal(await defaults.rpc({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }), 200);
    assert.equal(
      await defaults.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { padding } }),
      413,
      'a 70 KB body must be rejected by the 64kb default',
    );
  } finally {
    await defaults.stop();
  }

  const widened = await startServer({ MCP_BODY_LIMIT: '256kb' });
  try {
    assert.equal(
      await widened.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { padding } }),
      200,
      'MCP_BODY_LIMIT must still override the default',
    );
  } finally {
    await widened.stop();
  }
});
