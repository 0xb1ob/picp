pi-version-watch: keep picp's tested pi (package.json piCompat.testedMax) following pi releases.

1. `npm view @earendil-works/pi-coding-agent version` is the latest published pi `L`. If `L` is not newer than
   piCompat.testedMax, report "up to date" and stop.
2. Skip if a job or open PR titled `qualify pi L` exists (`gh pr list --state open --search "qualify pi L" in:title`);
   at most one qualify job or PR per pi version. Otherwise create one ship/pr job titled `qualify pi L`.
3. The qualify job: set the pi devDependency, the lockfile and piCompat.testedMax to exactly `L` (confirm with
   `npm view`; state the checked latest version in the PR body), run the FULL suite and `npm run e2e:install`, and open a
   draft PR titled `qualify pi L`. Green: normal review and merge. Red: list the failures in the PR body, file a GitHub
   issue, and change no product code beyond a trivial API rename. Merging stays the repository's; this is no merge authority.
4. Board report: link the `qualify pi L` PR (or issue) when one exists.
