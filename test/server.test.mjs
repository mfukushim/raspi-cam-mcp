import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mcpJson(response) {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data, `Missing SSE data: ${body}`);
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(body);
}

test("Bearer auth, host/origin checks, and MCP tool listing", async () => {
  const port = await freePort();
  const token = "test-token-with-enough-length";
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_TOKEN: token,
      RPICAM_STILL: "nonexistent-rpicam-command-for-test" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes("MCP server listening")) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const url = `http://127.0.0.1:${port}/mcp`;
    const request = (headers = {}, body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body)
      });

    assert.equal((await request()).status, 401);
    assert.equal((await request({ Authorization: "Bearer wrong-token-with-enough-length" })).status, 401);
    assert.equal((await request({ Authorization: `Bearer ${token}`, Origin: "http://evil.example" })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers: {
        Host: "evil.example", Authorization: `Bearer ${token}`,
        "Content-Type": "application/json", Accept: "application/json"
      } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    });
    assert.equal(badHostStatus, 403);

    const headers = { Authorization: `Bearer ${token}` };
    const initialize = await request(headers, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }
    });
    assert.equal(initialize.status, 200);
    assert.equal((await mcpJson(initialize)).result.serverInfo.name, "raspi-cam-mcp");

    const list = await request(headers);
    assert.equal(list.status, 200);
    assert.deepEqual((await mcpJson(list)).result.tools.map((tool) => tool.name), ["capture_image"]);

    const capture = await request(headers, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capture_image", arguments: {} }
    });
    assert.equal(capture.status, 200);
    assert.equal((await mcpJson(capture)).result.isError, true);
  } finally {
    child.kill();
  }
});
