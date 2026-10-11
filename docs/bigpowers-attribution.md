# bigpowers attribution

The planner evidence-mapping guidance in `profiles/planner.md` (Method step 2)
and `prompts/briefs/brief-research.md` (Method step 5) adapts planning ideas
from bigpowers, inspected at commit
`812d57a917675f8b9929d1519f5038dc1d01917f`:

- <https://github.com/danielvm-git/bigpowers/tree/812d57a917675f8b9929d1519f5038dc1d01917f>
- <https://github.com/danielvm-git/bigpowers/blob/812d57a917675f8b9929d1519f5038dc1d01917f/LICENSE>
- `skills/assess-impact/SKILL.md` — map dependents and the tests that cover them.
- `skills/plan-work/SKILL.md` — purpose, callers and contracts; before/after deltas.
- `skills/plan-tests/SKILL.md` — scenario-level test planning, including failure cases.
- `skills/trace-requirement/SKILL.md` and `skills/validate-contracts/SKILL.md` —
  requirement → change → proof traceability; boundary contracts.

What was adapted: recording current → intended behavior per changed boundary,
its callers/consumers and existing tests with evidence paths; mapping each
acceptance condition to the exact change and runnable proof; and treating
missing evidence as unknown rather than absent. The wording is picp's own and
lives in the existing plan sections. Nothing else was taken: no skills,
scripts, hooks, numeric gates, user questions, subagents, `specs/` state or
simple-english material, and no package is installed or loaded. The
baseline/candidate and held-out-case discipline in `docs/evals.md` follows the
same snapshot's `skills/run-benchmark/SKILL.md`.

The notice is kept even where the result is a paraphrase.

## License

```text
MIT License

Copyright (c) 2026 Daniel VM

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
