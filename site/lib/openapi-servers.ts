export const PLACEHOLDER_SERVER = {
  url: "https://geometrikks.example.com",
  description: "Your GeoMetrikks server",
};

type SchemaServer = { url?: unknown };
type Schema = { servers?: SchemaServer[] } & Record<string, unknown>;

const isAbsolute = (server: SchemaServer) => typeof server.url === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(server.url);

// GeoMetrikks is self-hosted, so a relative server ("/") would resolve against the docs origin in every example.
export function withPlaceholderServer<T extends Schema>(schema: T): T & { servers: SchemaServer[] } {
  if (schema.servers?.some(isAbsolute)) return schema as T & { servers: SchemaServer[] };
  return { ...schema, servers: [PLACEHOLDER_SERVER] };
}
