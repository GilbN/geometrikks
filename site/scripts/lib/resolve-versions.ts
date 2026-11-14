import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareSemver, NEXT, SEMVER, type VersionPlan } from "../../lib/versions";

export async function resolveVersions(
  docsDir: string,
  isPublished: (version: string) => Promise<boolean>,
): Promise<VersionPlan> {
  const nextDir = join(docsDir, NEXT);
  if (!existsSync(nextDir) || !statSync(nextDir).isDirectory()) {
    throw new Error(`${nextDir} is missing; every docs tree needs a next folder`);
  }

  const releases = readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SEMVER.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareSemver(b, a));

  let latestIndex = -1;
  for (let index = 0; index < releases.length; index++) {
    if (await isPublished(releases[index])) {
      latestIndex = index;
      break;
    }
  }

  if (latestIndex === -1) {
    return { latest: null, pending: releases, superseded: [], served: [NEXT] };
  }
  const latest = releases[latestIndex];
  return {
    latest,
    pending: releases.slice(0, latestIndex),
    superseded: releases.slice(latestIndex + 1),
    served: [latest, NEXT],
  };
}
