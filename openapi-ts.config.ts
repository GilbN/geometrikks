import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  client: "@hey-api/client-fetch",
  input: "./resources/generated/openapi.json",
  output: {
    path: "./resources/generated/api",
    // litestar-vite invokes openapi-ts without node_modules/.bin on PATH, so
    // a bare "prettier" post-processor (what the deprecated format option
    // resolves to) is not found; go through bun's local-bin resolution.
    postProcess: [
      { name: "prettier", command: "bun", args: ["x", "prettier", "--write", "{{path}}"] },
    ],
  },
  plugins: [
    "@hey-api/schemas",
    "@hey-api/sdk",
    {
      name: "@hey-api/typescript",
      enums: "javascript",
    },
  ],
});
