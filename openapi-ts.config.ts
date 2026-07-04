import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  client: "@hey-api/client-fetch",
  input: "./resources/generated/openapi.json",
  output: {
    path: "./resources/generated/api",
    format: "prettier",
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
