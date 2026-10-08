export const meta = {
  name: 'adaptive-build',
  description: 'Adaptive build from a spec: planner sizes and splits the work, risk-scaled review, fix loops with model escalation, looped system review',
  whenToUse: 'Building or rebuilding a project from a written spec where quality matters. Args: {root, spec, checks: string[], notes?, scratch?}',
  phases: [
    { title: 'Plan', detail: 'opus decides one builder vs units, dependencies, and per-unit risk', model: 'opus' },
    { title: 'Build', detail: 'haiku builds each unit when its dependencies finish; risk-scaled sonnet review; fix loop with escalation' },
    { title: 'System review', detail: 'sonnet reviews the whole system in a real run; haiku fixes; repeat while blocking findings remain' },
  ],
}

// ---- inputs ---------------------------------------------------------------
const ROOT = args?.root
if (!ROOT) throw new Error('args.root is required')
const SPEC = args.spec ?? `${ROOT}/SPEC.md`
const CHECKS = args.checks ?? ['npm run typecheck', 'npm test']
const SCRATCH = args.scratch ?? '/tmp'
const NOTES = args.notes ?? ''
const MAX_UNIT_ROUNDS = args.maxUnitRounds ?? 3
const MAX_SYSTEM_ROUNDS = args.maxSystemRounds ?? 2

const COMMON = `Project root: ${ROOT}. Read the spec at ${SPEC} first and follow it.
${NOTES}
Shell rules: never use "pkill -f" or "killall" (they can kill your own shell); stop background processes by PID. Wrap long commands in "timeout". Put throwaway files and databases under ${SCRATCH}. Do not git commit.`

// ---- schemas --------------------------------------------------------------
const PLAN = {
  type: 'object',
  properties: {
    fitsOneContext: { type: 'boolean', description: 'true if one capable builder could hold and build the whole thing coherently' },
    rationale: { type: 'string' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          owns: { type: 'array', items: { type: 'string' }, description: 'files/globs this unit exclusively owns' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          riskReason: { type: 'string' },
          instructions: { type: 'string', description: 'what to build, which spec sections, done criteria and exact checks' },
        },
        required: ['id', 'title', 'owns', 'dependsOn', 'risk', 'riskReason', 'instructions'],
      },
    },
  },
  required: ['fitsOneContext', 'rationale', 'units'],
}

const BUILD = {
  type: 'object',
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    checksRun: { type: 'array', items: { type: 'string' } },
    allPassing: { type: 'boolean' },
    designProblems: { type: 'array', items: { type: 'string' }, description: 'problems you could not solve within your unit (contract or design issues)' },
    notes: { type: 'string' },
  },
  required: ['filesWritten', 'checksRun', 'allPassing', 'designProblems', 'notes'],
}

const REVIEW = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'minor'] },
          area: { type: 'string' },
          file: { type: 'string' },
          problem: { type: 'string' },
          failureScenario: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['severity', 'area', 'file', 'problem', 'failureScenario', 'suggestedFix'],
      },
    },
    thinAreas: { type: 'array', items: { type: 'string' }, description: 'areas you could not check well enough' },
    checksRun: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['findings', 'thinAreas', 'checksRun', 'summary'],
}

// Review lenses by risk: low = none (left to system review), medium = 1, high = 2 independent lenses.
const LENSES = [
  { key: 'correctness', text: 'Correctness and concurrency: real bugs, races, state/consistency errors, error paths, and whether tests assert the actual requirement (not something weaker).' },
  { key: 'spec', text: 'Spec compliance and robustness: every requirement for this unit vs the spec, contracts, security (authz, input validation, injection), accessibility where UI is involved.' },
]
const lensesFor = (risk) => (risk === 'high' ? LENSES : risk === 'medium' ? [LENSES[0]] : [])

const stats = { agents: 0, escalations: 0, skippedReviews: 0, failedAgents: [] }
const run = async (prompt, opts) => {
  stats.agents++
  let result = await agent(prompt, opts)
  if (result === null) {
    // A dead agent (API error, usage limit) must never read as a clean result: retry once, then record it.
    stats.agents++
    result = await agent(prompt, { ...opts, label: `${opts.label}:retry` })
    if (result === null) stats.failedAgents.push(opts.label)
  }
  return result
}

// ---- plan -----------------------------------------------------------------
phase('Plan')
const plan = await run(`${COMMON}
You are the PLANNER. Decide the shape of the build before anyone writes code. Any file-ownership table in the spec is only a suggestion; you decide.
1. Read the spec and the existing files (contracts, configs). Estimate the size of the work.
2. fitsOneContext: true if a single capable builder could build and keep the whole thing coherent in one session. If true, return exactly ONE unit covering everything.
3. Otherwise split along stable seams only (where interfaces are already fixed by the spec/contracts). Fewer, larger units beat many small ones. Each unit exclusively owns its files; list dependencies so a unit starts only after units it builds on finish. Put tooling/e2e/README/integration in a final unit that depends on the rest.
4. Rate each unit's risk: high = concurrency, auth/security, money, state machines, sync protocols, or many callers depend on it; medium = non-trivial logic or UI behaviour; low = mechanical/glue.
5. Write each unit's instructions: spec sections, done criteria, and the exact checks to run. The whole project must finally pass: ${CHECKS.join(' ; ')}.`, { label: 'planner', phase: 'Plan', model: 'opus', schema: PLAN })

if (!plan || !plan.units.length) throw new Error('planner returned no units')
const units = plan.fitsOneContext ? plan.units.slice(0, 1) : plan.units
log(`plan: ${plan.fitsOneContext ? 'single builder' : `${units.length} units`} - ${units.map((u) => `${u.id}(${u.risk})`).join(', ')}`)

// ---- build each unit when its dependencies are done -----------------------
async function buildUnit(u) {
  let model = 'haiku'
  let built = await run(`${COMMON}\nYou are the BUILDER for unit "${u.title}" (${u.id}). You own: ${u.owns.join(', ')}. Units you depend on are already built; use their exports, do not rewrite them (fix minimally and report in designProblems if one blocks you).\n${u.instructions}\nRun the checks named above until they pass. Report exact commands and results.`,
    { label: `build:${u.id}`, phase: 'Build', model, schema: BUILD })
  const history = [{ round: 0, model, allPassing: built?.allPassing ?? false }]
  const lenses = lensesFor(u.risk)
  if (!lenses.length) stats.skippedReviews++

  let lastBlocking = Infinity
  for (let round = 1; round <= MAX_UNIT_ROUNDS; round++) {
    const reviews = (await parallel(lenses.map((l) => () =>
      run(`${COMMON}\nYou are a REVIEWER (lens: ${l.key}) for unit "${u.title}" (${u.id}), which owns: ${u.owns.join(', ')}. Do NOT edit files. ${l.text}\nRun the unit's checks yourself. Report only real defects with concrete failure scenarios; blocking = violates the spec, fails a check, or is a real bug.\nUnit instructions were: ${u.instructions}`,
        { label: `review:${u.id}:${l.key}:r${round}`, phase: 'Build', model: 'sonnet', effort: 'high', schema: REVIEW })))).filter(Boolean)
    if (reviews.length < lenses.length) {
      history.push({ round, unverified: `${lenses.length - reviews.length} reviewer(s) failed` })
      log(`${u.id}: review incomplete in round ${round}; marking unverified`)
      return { id: u.id, risk: u.risk, history, final: built, unverified: true }
    }
    const findings = reviews.flatMap((r) => r.findings)
    const blocking = findings.filter((f) => f.severity === 'blocking')
    const failing = !(built?.allPassing)
    history.push({ round, reviewers: lenses.length, blocking: blocking.length, minor: findings.length - blocking.length })

    // Done when nothing blocks and checks pass. Minor findings get one cheap fix pass on the first round only.
    if (!blocking.length && !failing) {
      if (round === 1 && findings.length) {
        built = await run(`${COMMON}\nYou are the BUILDER for unit ${u.id}. Apply these minor review findings where cheap and clearly correct, then re-run the unit's checks until green.\n${JSON.stringify(findings)}`,
          { label: `polish:${u.id}`, phase: 'Build', model, schema: BUILD })
      }
      break
    }
    // Escalate when the cheap model is stuck: checks still failing after a fix, or blocking findings not shrinking.
    if (round >= 2 && model === 'haiku' && (failing || blocking.length >= lastBlocking)) {
      model = 'sonnet'
      stats.escalations++
      log(`escalating ${u.id} to sonnet (round ${round}: failing=${failing}, blocking=${blocking.length})`)
    }
    lastBlocking = blocking.length
    built = await run(`${COMMON}\nYou are the BUILDER for unit "${u.title}" (${u.id}). Fix every blocking finding (and cheap, clearly-correct minor ones)${failing ? '; the unit checks were also failing - make them pass' : ''}. Disagree in notes rather than silently skipping.\nFindings: ${JSON.stringify(findings)}\nThen re-run the unit's checks until green.`,
      { label: `fix:${u.id}:r${round}`, phase: 'Build', model, schema: BUILD })
    history[history.length - 1].fixedWith = model
    if (!lenses.length) break // low risk: no reviewer to re-check, the system review covers it
  }
  log(`${u.id} done: ${JSON.stringify(history)}`)
  return { id: u.id, risk: u.risk, history, final: built }
}

phase('Build')
const done = {}
const byId = Object.fromEntries(units.map((u) => [u.id, u]))
const visiting = new Set()
function start(id) {
  if (done[id]) return done[id]
  const u = byId[id]
  if (!u) return Promise.resolve(null)
  if (visiting.has(id)) throw new Error(`dependency cycle at ${id}`)
  visiting.add(id)
  const deps = (u.dependsOn ?? []).filter((d) => byId[d]).map(start)
  visiting.delete(id)
  done[id] = Promise.all(deps).then(() => buildUnit(u))
  return done[id]
}
const unitResults = await Promise.all(units.map((u) => start(u.id)))

// ---- system review loop ---------------------------------------------------
phase('System review')
const systemRounds = []
let focus = ''
for (let round = 1; round <= MAX_SYSTEM_ROUNDS; round++) {
  const review = await run(`${COMMON}\nYou are the SYSTEM REVIEWER. Do NOT edit files. Check the whole system against the spec adversarially:
- Run: ${CHECKS.join(' ; ')}
- Run the real application and drive it the way a user would (for web UIs use Playwright in a real browser), covering every user-facing requirement in the spec, including keyboard, accessibility, offline/reconnect, narrow viewports and concurrency between two sessions where relevant. Stop anything you start by PID.
${focus}
Report blocking vs minor findings with concrete failure scenarios, and list thinAreas you could not verify well.`,
    { label: `system-review:r${round}`, phase: 'System review', model: 'sonnet', effort: 'high', schema: REVIEW })
  if (!review) {
    systemRounds.push({ round, notRun: true })
    log(`system review r${round} did not run (agent failed twice); the system is UNVERIFIED`)
    break
  }
  const blocking = (review?.findings ?? []).filter((f) => f.severity === 'blocking')
  systemRounds.push({ round, blocking: blocking.length, minor: (review?.findings ?? []).length - blocking.length, thinAreas: review?.thinAreas ?? [] })
  log(`system review r${round}: ${blocking.length} blocking, ${(review?.findings ?? []).length - blocking.length} minor, thin: ${(review?.thinAreas ?? []).join('; ') || 'none'}`)
  if (!review || !review.findings.length) break

  const model = blocking.length && round > 1 ? 'sonnet' : 'haiku'
  if (model === 'sonnet') stats.escalations++
  const fix = await run(`${COMMON}\nYou are the INTEGRATION FIXER. Fix every blocking finding and the cheap, clearly-correct minor ones (any file, except contracts the spec marks as fixed). Then run ${CHECKS.join(' ; ')} until all pass and update any verification notes in the README with real results.\nFindings: ${JSON.stringify(review.findings)}`,
    { label: `system-fix:r${round}`, phase: 'System review', model, schema: BUILD })
  systemRounds[systemRounds.length - 1].fixedWith = model
  systemRounds[systemRounds.length - 1].fixPassing = fix?.allPassing ?? false
  // Another round only if something blocked; minor-only rounds are not re-reviewed.
  if (!blocking.length) break
  focus = `Previous round's blocking findings (verify they are really fixed, then look elsewhere, especially these previously thin areas: ${(review.thinAreas ?? []).join('; ')}): ${JSON.stringify(blocking.map((b) => b.problem))}`
}

return {
  plan: { fitsOneContext: plan.fitsOneContext, rationale: plan.rationale, units: units.map((u) => ({ id: u.id, risk: u.risk, dependsOn: u.dependsOn, riskReason: u.riskReason })) },
  units: unitResults.map((r) => r && { id: r.id, risk: r.risk, history: r.history, allPassing: r.final?.allPassing, unverified: r.unverified ?? false, designProblems: r.final?.designProblems }),
  verified: !stats.failedAgents.length && systemRounds.every((r) => !r.notRun) && unitResults.every((r) => r && !r.unverified),
  systemRounds,
  stats,
}
