---
name: prd-rules
description: Turn a PRD into business-rule knowledge cards the orchestrator loads on demand. Three seats extract candidate rules and the gaps in them, a human confirms the contested ones, and only confirmed rules are written to .qoder/rules/. Use for /prd-rules, "extract business rules", "capture domain rules from this PRD", or when a task keeps hitting domain questions nobody has written down.
---

# PRD to business rules

A PRD states what to build. The business rules underneath it are what the code has to keep being true for years after the PRD is forgotten, and they are usually the part left implicit.

This skill extracts them, puts the uncertain ones to a human, and writes the answers down where the orchestrator can find them later. Knowledge accretes one PRD at a time, so the tenth task in a domain should not have to re-ask what the first one settled.

**Confirmation is not optional.** An inferred rule that is wrong does not fail loudly. It shapes every later decision in the domain and reads like established fact by the time someone notices. A rule gets written either because the PRD states it plainly or because a human confirmed it. Nothing else belongs in a card.

## 1. Get the PRD

Accept a file path, pasted text, or a URL. Read it in full before doing anything else.

Ask which domain the card belongs to when the PRD does not make it obvious. One card per domain, so a PRD spanning billing and notifications produces two.

Do not reconstruct the rules from the code instead. Code shows what the system currently does, which is exactly what a PRD is about to change, and inferring intent from the thing being changed produces a card that defends the old behavior. When there is no PRD and only a domain to capture, say that this skill is the wrong one and use **interrogate** against the code instead.

## 2. Fan out

Dispatch `pstack:pstack-panel-1`, `pstack:pstack-panel-2`, and `pstack:pstack-panel-3` in one message so they run concurrently. Three seats on three models find different gaps. Give each the PRD path or text, the domain, and this brief.

> Read the PRD in full. Produce two lists and nothing else.
>
> **Rules.** Every business rule the PRD states or implies. For each one, write the observable behavior it constrains, meaning what a user or a caller can see that would be different if the rule were broken. Quote the PRD line it came from. Skip implementation detail, technology choices, and anything about how the work gets done.
>
> **Gaps.** Every place where two reasonable readings of the PRD produce different behavior, plus every rule the domain obviously needs that the PRD does not mention at all. For each one, write the question, the candidate readings, and what changes depending on the answer.
>
> Gaps matter more than rules. A rule the PRD already states needs no human. A gap that nobody raises becomes a silent default someone picks for you.
>
> Report both lists as plain text. Do not write any file and do not edit the code.

These are read-only briefs. If a seat tries to change something, discard its output and re-dispatch.

## 3. Consolidate

Merge the three lists.

- Deduplicate rules that say the same thing in different words. Keep the wording that states an observable behavior.
- Keep a rule when all three seats found it, or when one found it and the PRD line it quotes is real. Verify the quote before keeping a single-seat rule, because a plausible quote is easy to invent.
- Merge gaps that share a root question. Three seats circling one ambiguity is one question, not three.
- Drop gaps that the PRD does answer, and move the answer into the rules list with its quote.

Split the result into three piles.

| Pile | Disposition |
|---|---|
| Stated | The PRD says it plainly and only one reading is possible. Write it to the card, no question needed. |
| Contested | Two or more readings produce different behavior. Put it to the human. |
| Missing | The domain needs it and the PRD never mentions it. Put it to the human. |

## 4. Ask

Use `AskUserQuestion`. One question per contested or missing rule, batched into as few calls as the tool allows, and never as free text when an option list will do.

Each question gives the candidate readings as options, so answering is a choice rather than an essay. Include the PRD quote in the question when there is one. Add an option for "neither, the rule is different" rather than forcing a pick between two wrong answers.

Cap it. More than about ten questions in one pass means the PRD is thinner than the domain needs, so ask the ten that change the most behavior and record the rest as open questions in the card. An unanswered question written down is useful. An unanswered question dropped is how the next person re-litigates it.

Skip questions whose answer cannot change what gets built. A rule nobody will ever branch on is trivia.

## 5. Write the card

Write `.claude/skills/enterprise-<domain>/SKILL.md`, with the domain in kebab case. Qoder loads project rules from `.qoder/rules/`, and `trigger: model_decision` is what makes the card load only for tasks that need it rather than on every message.

```markdown
---
trigger: model_decision
description: Use when working on <domain> in this repo, when changing <the behaviors this card constrains>, or when a <domain> requirement looks ambiguous. Holds the business rules confirmed from <PRD name>.
---

# Business rules: <domain>

# schema: 1

Written by /prd-rules. Rules tagged [stated] are quoted from a PRD and were
unambiguous. Rules tagged [confirmed] were put to a human, who picked a reading.
Rules tagged [assumed] are open questions nobody has answered yet, and they are
recorded so the next person sees the gap instead of silently picking a default.

## Rules

- <the observable behavior>. [stated, <PRD section or line>]
- <the observable behavior>. [confirmed <date>, chose <reading> over <alternative>]

## Open questions

- <the question>. Behavior differs depending on the answer: <reading A> versus
  <reading B>. [assumed <date>, no answer yet]

## Sources

- <PRD path, title, or URL>, read <date>
```

The `description` is the load trigger, so write it about the tasks that need the card and not about the card. "Use when working on pricing changes" loads at the right time. "Business rules for pricing" does not tell a model when to care.

The `# schema: 1` line marks the format. A card without it came from an older run, so rewrite it whole rather than merging into it.

Every rule states an observable behavior. "Discounts apply at checkout" is a rule a test can check. "Discounts are handled correctly" is a sentence that agrees with whatever the code already does.

## 6. Accrete

A card is appended to, never rewritten from scratch, and a card in another domain is never touched.

When a later PRD covers the same domain, read the existing card first. Then:

- A rule the new PRD confirms again gets its date refreshed and both sources listed.
- A rule the new PRD contradicts is a decision, not an overwrite. Put both readings to the human, and record which won and why, because the loser will come back otherwise.
- An open question that the new PRD answers moves from Open questions to Rules and keeps the date it was first raised.
- A rule the new PRD silently stops mentioning stays. Absence from a later PRD is not a repeal, and deleting it would lose the reason it existed.

## 7. Report

Tell the user what landed and where.

- The card path and the domain.
- Counts: rules stated, rules confirmed, questions still open.
- Every question asked and the answer given, so the record exists outside the card too.
- The open questions, named, since those are the ones that will bite.
- Whether any rule contradicted an existing card, and how it was resolved.

Say plainly if the PRD was too thin to support the domain. That is a finding about the PRD and worth more than a card full of guesses.

## What this skill does not do

It does not write code, create tasks, or change the PRD. It produces one knowledge card and a record of what a human decided.

It does not pull from a wiki. When the rules live in Confluence or Notion, an MCP server has to be configured for it, and Claude Code ignores `mcpServers` on plugin agents, so that configuration is yours to make. Point this skill at exported text instead when there is no server.

It does not verify that the code obeys the card. That is a separate run, and **interrogate** is the skill for it once a card exists to check against.
