import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const execFileAsync = promisify(execFile);
const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? "3000");
const token = process.env.MCP_TOKEN;
const cameraCommand = process.env.RPICAM_STILL ?? "rpicam-still";
let captureInProgress = false;

if (isIP(host) !== 4) throw new Error("MCP_HOST must be a Raspberry Pi IPv4 address");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be between 1 and 65535");
if (!token || token.length < 16) throw new Error("Set MCP_TOKEN to a random string of at least 16 characters");

async function captureImage(): Promise<Buffer> {
  if (captureInProgress) throw new Error("Camera is busy; try again shortly");
  captureInProgress = true;
  try {
    const { stdout } = await execFileAsync(cameraCommand, [
      "--nopreview", "--timeout", "1000", "--width", "1280", "--height", "720",
      "--quality", "85", "--output", "-"
    ], { encoding: "buffer", timeout: 15_000, maxBuffer: 12 * 1024 * 1024 });
    if (stdout.length < 4 || stdout[0] !== 0xff || stdout[1] !== 0xd8 ||
        stdout[stdout.length - 2] !== 0xff || stdout[stdout.length - 1] !== 0xd9) {
      throw new Error("Camera did not return a complete JPEG image");
    }
    return stdout;
  } finally {
    captureInProgress = false;
  }
}

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "raspi-cam-mcp", version: "1.0.0" });
  server.registerTool("capture_image", {
    description: "Capture one JPEG image from the Raspberry Pi CSI camera",
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      const image = await captureImage();
      return { content: [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown camera error";
      console.error("Camera capture failed:", message);
      return { isError: true, content: [{ type: "text" as const, text: `Camera capture failed: ${message}` }] };
    }
  });
  return server;
}, { responseMode: "json" });

const nodeHandler = toNodeHandler(handler);
const expectedHost = `${host}:${port}`;
const httpServer = createServer((req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  // This endpoint is for non-browser MCP clients on a trusted LAN.
  if (req.headers.host !== expectedHost || req.headers.origin) {
    res.writeHead(403).end();
    return;
  }
  const authorization = req.headers.authorization ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer", "Content-Type": "text/plain" }).end("Unauthorized");
    return;
  }
  void nodeHandler(req, res).catch((error: unknown) => {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  });
});

httpServer.listen(port, host, () => {
  console.log(`MCP server listening at http://${expectedHost}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    httpServer.close();
    void handler.close().finally(() => process.exit(0));
  });
}
