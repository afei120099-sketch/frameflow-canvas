import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Split canvases (5174–5177) have no production worker of their own: one GPU, one worker in the default
 * canvas (5173). Their /__production/api and /__production/media requests are forwarded there, tagged
 * with x-frameflow-canvas so each canvas only sees and creates its own episodes. Bodies stream both ways
 * (uploads up to 40 MB, Range requests for video).
 */
const FORWARD_HEADERS = ["content-type", "content-length", "range", "x-frameflow-production", "accept"];

export function forwardProduction(request: IncomingMessage, response: ServerResponse, ownerBase: string, canvas: string, path: string, canvasName = "") {
  const target = new URL(`/__production${path}`, ownerBase);
  const headers: Record<string, string> = { "x-frameflow-canvas": canvas };
  if (canvasName) headers["x-frameflow-canvas-name"] = encodeURIComponent(canvasName);
  for (const name of FORWARD_HEADERS) { const value = request.headers[name]; if (typeof value === "string") headers[name] = value; }
  const upstream = httpRequest(target, { method: request.method, headers, timeout: 120_000 }, (reply) => {
    response.statusCode = reply.statusCode ?? 502;
    for (const [name, value] of Object.entries(reply.headers)) if (value !== undefined && !["connection", "transfer-encoding"].includes(name)) response.setHeader(name, value);
    reply.pipe(response);
  });
  const fail = (message: string) => {
    if (response.headersSent) { response.destroy(); return; }
    response.statusCode = 502;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: `${message}：生产线执行器在主画布（5173），请确认主画布在运行` }));
  };
  upstream.on("timeout", () => upstream.destroy(new Error("连接主画布超时")));
  upstream.on("error", (cause) => fail(cause.message || "连不上主画布"));
  request.pipe(upstream);
}
