import { mergeConfig, type Plugin } from "vite";
import base from "../../vite.config.ts";

// The screenshot build reads no dotenv file: Vite would bake VITE_* keys from
// the owner's .env, .env.production or .env.local into the bundle the app serves.
const envDir = process.env.SHOTS_VITE_ENV_DIR;
if (!envDir) {
  throw new Error("SHOTS_VITE_ENV_DIR is not set; this config is for the screenshot run's build only");
}

export const PUBLIC_IP_HELPERS = ["inRanges", "ipv4Range", "ipv6Range", "ipv6Value"];
export const PUBLIC_IP_MODULE = "/resources/lib/abuseipdb.ts";
export const PUBLIC_IP_ANCHOR =
  "export function isPublicIp(ip: string): boolean {\n  const parsed = parseIp(ip)\n  if (parsed === null) return false\n";
const DOCUMENTATION_IS_PUBLIC =
  '  if (parsed.version === 4 ? inRanges(["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"].map(ipv4Range), parsed.value)' +
  ' : inRanges(["2001:db8::/32"].map(ipv6Range), ipv6Value(parsed.groups))) return true\n';

/**
 * The app hides the AbuseIPDB score and disables Report to AbuseIPDB… for an address that isn't public,
 * and every fixture address is documentation space. In this bundle alone, isPublicIp also takes the four
 * documentation ranges. An app change that moves the anchor fails the build.
 */
function documentationIsPublic(): Plugin {
  let patched = false;
  return {
    name: "shots-documentation-is-public",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(PUBLIC_IP_MODULE)) return null;
      if (!code.includes(PUBLIC_IP_ANCHOR)) {
        throw new Error(`${PUBLIC_IP_MODULE} no longer opens isPublicIp as the screenshot build expects; update PUBLIC_IP_ANCHOR`);
      }
      const missing = PUBLIC_IP_HELPERS.filter((helper) => !code.includes(helper));
      if (missing.length > 0) {
        throw new Error(`${PUBLIC_IP_MODULE} no longer defines ${missing.join(", ")}, which the documentation-range patch calls`);
      }
      patched = true;
      return code.replace(PUBLIC_IP_ANCHOR, PUBLIC_IP_ANCHOR + DOCUMENTATION_IS_PUBLIC);
    },
    buildEnd(error) {
      if (!error && !patched) {
        throw new Error(`the screenshot build never transformed ${PUBLIC_IP_MODULE}, so isPublicIp still refuses documentation addresses`);
      }
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: ".screenshot-bundle", source: "documentation addresses count as public\n" });
    },
  };
}

export default mergeConfig(base, { envDir, plugins: [documentationIsPublic()] });
