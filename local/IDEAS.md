# Ideas / Feature Backlog — `local/` (Plutus / Proactive Scout)

Running list of ideas and feature requests for the local companion app. Not a roadmap or
commitment — just a place to park things worth building later instead of losing them.

---

## Future Value Shift analysis ("donkeys vs tractors")

A structured, multi-step prompt for evaluating a company's long-term strategic position —
where it's vulnerable to disruption, what could replace it, and what to watch for as early
warning signs. Candidate as a new one-shot Proactive Scout report type (same pattern as
`tradeIdeas.js`'s digest → single prompt → stored report), or as a Plutus chat workflow.

Inputs: (a) company name + ticker, (b) short description of its main products/services,
(c) brief overview of its current tech stack and business model.

```
Step 1 – Inputs and current state: I will give you: (a) a company name and ticker, (b) a
short description of its main products/services, and (c) a brief overview of its current
technology stack and business model.

Using that, first map the company's CURRENT position:
- Core markets and customer segments it serves
- Main value proposition today (why customers pay them instead of others)
- Key dependencies and bottlenecks (e.g. regulation, suppliers, labor, compute, data,
  distribution)
- How its current tech stack and operations reinforce or LIMIT that position

Step 2 – External landscape scan: Now zoom out and compare this to the broader environment
over the next 5-10 years:
- Macroeconomic trends: interest rates, demographics, globalization vs reshoring, consumer
  spending shifts, regulation themes in this industry
- Emerging and adjacent technologies: AI/ML, automation/robotics, crypto, new materials,
  IoT, AR/VR, biotech, energy tech, etc as relevant
- Business model innovations: subscriptions, usage-based pricing, platforms/marketplaces,
  vertical integration, open source, etc
- Historical disruption patterns: e.g. horses -> cars, film cameras -> digital, taxis -> ride
  sharing, on-prem software -> cloud, physical media -> streaming

Step 3 – Future Value Shift analysis ("donkeys vs tractors"): Do a 'Future Value Shift'
analysis for this company:
- Vulnerabilities
  - Where is this company currently behaving like the "donkey" in a soon-to-be "tractor"
    world?
  - Which parts of its value chain are most vulnerable to:
    - Automation or AI
    - New hardware or infrastructure
    - New distribution models (platforms, marketplaces, direct-to-consumer)
    - Regulation changes or commoditization
    - Emerging "tractor" players
- Identify what types of companies or technologies could be the "tractors" that replace
  today's "donkeys" in this market.
  - Name concrete categories of potential disruptors (they can be startups, incumbents from
    adjacent markets, or open-source ecosystems) and explain:
    - What they do differently (tech, cost structure, UX, distribution, data advantage)
    - Why their model could capture value that the current company is leaving on the table

Step 4 – Predictive hypotheses for the next 5-10 years: Generate 5-10 specific predictive
hypotheses about where VALUE will shift in this industry over the next 5-10 years. For each
hypothesis, provide:
- Short statement: "If X trend continues / emerges, then value will shift from [current
  model] to [new model]."
- Who wins vs who loses: which types of companies gain power, which lose it, and why
- Mechanism: the causal story of how the shift happens (cost advantage, regulation, network
  effects, data flywheel, UX, etc)

Step 5 – Leading indicators to watch: For each hypothesis, list the most important technical
or market INDICATORS that this transition is actually starting to happen, such as:
- Technical milestones (e.g. model accuracy hitting a specific threshold, hardware cost
  hitting $X, latency or energy use dropping below Y)
- Adoption signals (e.g. percentage of workflows moving to automation, share of sales moving
  online, number of active users on a new platform)
- Capital flows (VC/PE investment spikes in a new architecture or business model, major M&A
  moves)
- Regulatory shifts (new laws, standards, or subsidies favoring the "tractor" model)
- Behavior changes (customer churn patterns, reduced willingness to pay for legacy
  offerings, rapid growth of a new usage pattern)

Output format:
- Section 1: Brief summary of the company's CURRENT position
- Section 2: Key macro, tech, and disruption patterns relevant to this company
- Section 3: Future Value Shift analysis
  - 3-5 main vulnerability areas for the current company
  - 3-5 categories of potential "tractor" companies and why they're dangerous
- Section 4: 5-10 predictive hypotheses for where value will shift in the next 5-10 years
- Section 5: For each hypothesis, a bullet list of 3-7 concrete indicators that would signal
  the shift is underway

Stay high-level and strategic, but make the hypotheses AND indicators as specific and
testable as possible so they can be monitored over time.
```

**Implementation notes (not yet built):**
- Needs live company/tech-stack input, not derivable from `trades` data alone — likely a
  manual-input form (ticker + free-text description) rather than something the Scout
  auto-triggers.
- Long, multi-section output — better suited to `CHAT_MODEL` (bigger, general-reasoning
  model) than the small `CONTRADICTION_MODEL`; this isn't a JSON-mode structured-extraction
  task, it's open-ended strategic writing.
- Could reuse the `trade_idea_reports` storage pattern (store the report + a digest of what
  it was given) so past analyses stay auditable, same reasoning as the existing Proactive
  Scout reports.
