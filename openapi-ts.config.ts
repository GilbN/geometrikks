import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  client: "@hey-api/client-fetch",
  input: "./src/generated/openapi.json",
  output: {
    path: "./src/generated/api",
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
