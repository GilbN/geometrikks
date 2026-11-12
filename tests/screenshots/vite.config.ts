import { mergeConfig } from "vite";
import base from "../../vite.config.ts";

// The screenshot build reads no dotenv file: Vite would bake VITE_* keys from
// the owner's .env, .env.production or .env.local into the bundle the app serves.
const envDir = process.env.SHOTS_VITE_ENV_DIR;
if (!envDir) {
  throw new Error("SHOTS_VITE_ENV_DIR is not set; this config is for the screenshot run's build only");
}

export default mergeConfig(base, { envDir });
