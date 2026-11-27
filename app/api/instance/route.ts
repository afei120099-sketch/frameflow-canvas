import { instanceForPort, requestPort } from "@/lib/frameflow-instance";

/** Identity follows the request port. 5173 (and any port outside the split list) stays the default instance. */
export function GET(request: Request) {
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) return Response.json({ error: "仅限本机" }, { status: 403 });
  const spec = instanceForPort(requestPort(request));
  if (spec) return Response.json({ id: spec.id, name: spec.label, inboxPort: spec.inboxPort, claimPort: spec.claimPort, transfer: "http://127.0.0.1:5198" });
  return Response.json({
    id: process.env.FRAMEFLOW_INSTANCE_ID || "",
    name: process.env.FRAMEFLOW_INSTANCE_NAME || "",
    inboxPort: Number(process.env.FRAMEFLOW_INBOX_PORT || 5193),
    claimPort: Number(process.env.FRAMEFLOW_CLAIM_PORT || 8791),
    transfer: "http://127.0.0.1:5198",
  });
}
