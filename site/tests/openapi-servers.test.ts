import { describe, expect, test } from "bun:test";
import { PLACEHOLDER_SERVER, withPlaceholderServer } from "../lib/openapi-servers";

describe("withPlaceholderServer", () => {
  test("adds the placeholder when the schema has no servers", () => {
    expect(withPlaceholderServer({ openapi: "3.1.0" }).servers).toEqual([PLACEHOLDER_SERVER]);
  });

  test("replaces a relative server", () => {
    expect(withPlaceholderServer({ servers: [{ url: "/" }] }).servers).toEqual([PLACEHOLDER_SERVER]);
  });

  test("keeps an absolute server the schema defines", () => {
    const schema = { servers: [{ url: "https://geo.internal.test" }] };
    expect(withPlaceholderServer(schema)).toBe(schema);
  });

  test("keeps the rest of the schema", () => {
    const result = withPlaceholderServer({ openapi: "3.1.0", paths: { "/health": {} }, servers: [{ url: "/" }] });
    expect(result.paths).toEqual({ "/health": {} });
  });
});
