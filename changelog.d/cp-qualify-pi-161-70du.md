- Qualify pi 1.6.1: the pi devDependency and `piCompat.testedMax` move to 1.6.1. Enum schemas come from a local
  `StringEnum` (`src/contracts/string-enum.ts`) that emits the same JSON as pi-ai's did through 1.4.0, the plan viewer
  takes pi-tui's `readonly string[]` render lines, and docs/contracts.md records that pi 1.5.1+ defaults `cacheWarming`
  to `"idle"`.
