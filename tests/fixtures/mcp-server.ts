// Minimal, local JSON-RPC server used to verify the real MCPorter CLI.
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result: unknown;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "private-tool-description",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
      break;
    case "tools/call":
      result = {
        content: [{ type: "text", text: request.params.arguments.text }],
      };
      break;
    default:
      result = {};
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
